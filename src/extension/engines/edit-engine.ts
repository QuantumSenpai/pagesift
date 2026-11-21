import { isPageSiftElement } from './dom-utils.js';

interface TextEditCommand {
  kind: 'text_edit';
  element: HTMLElement;
  previousHtml: string;
  nextHtml: string;
}

interface FontSwapTargetState {
  element: HTMLElement;
  previousFontFamily: string;
  previousPriority: string;
  nextFontFamily: string;
}

interface FontSwapCommand {
  kind: 'font_swap';
  targets: FontSwapTargetState[];
  injectedLinkElement: HTMLLinkElement | null;
}

interface ArrangeCommand {
  kind: 'arrange';
  element: HTMLElement;
  action: 'move' | 'hide' | 'remove';
  previousTransform: string;
  previousTransformPriority: string;
  previousVisibility: string;
  previousVisibilityPriority: string;
  previousDisplay: string;
  previousDisplayPriority: string;
  nextTransform: string;
  nextVisibility: string;
  nextDisplay: string;
}

type ReversibleCommand = TextEditCommand | FontSwapCommand | ArrangeCommand;

export interface EditHistoryStatus {
  undoCount: number;
  redoCount: number;
  lastAction: string | null;
}

const FORBIDDEN_TEXT_EDIT_TAGS = new Set([
  'input',
  'textarea',
  'select',
  'option',
  'script',
  'style',
  'noscript',
  'iframe',
]);

function replaceDirectTextPreservingChildren(el: HTMLElement, newText: string): string {
  const clone = el.cloneNode(true) as HTMLElement;
  const directTextNodes = Array.from(clone.childNodes).filter(
    (node): node is Text => node.nodeType === 3 && (node.nodeValue ?? '').trim().length > 0,
  );

  const firstDirect = directTextNodes[0];
  if (firstDirect) {
    firstDirect.nodeValue = newText;
    for (let i = 1; i < directTextNodes.length; i += 1) {
      const extraNode = directTextNodes[i];
      if (extraNode) {
        extraNode.nodeValue = '';
      }
    }
    return clone.innerHTML;
  }

  const walker = el.ownerDocument.createTreeWalker(clone, 4);
  const firstDescendant = walker.nextNode() as Text | null;
  if (firstDescendant) {
    firstDescendant.nodeValue = newText;
    return clone.innerHTML;
  }

  clone.textContent = newText;
  return clone.innerHTML;
}

function isEditableHtmlElement(node: Element): node is HTMLElement {
  return 'style' in node && typeof (node as HTMLElement).style === 'object';
}

export class PageEditController {
  private readonly doc: Document;
  private readonly undoStack: ReversibleCommand[] = [];
  private readonly redoStack: ReversibleCommand[] = [];

  public constructor(doc: Document) {
    this.doc = doc;
  }

  public getStatus(): EditHistoryStatus {
    const top = this.undoStack[this.undoStack.length - 1];
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      lastAction: top ? top.kind : null,
    };
  }

  public applyTextEdit(target: Element, newText: string): EditHistoryStatus {
    if (isPageSiftElement(target)) {
      throw new Error('Cannot edit PageSift UI elements');
    }
    if (!isEditableHtmlElement(target)) {
      throw new Error('Target element is not an editable HTML element');
    }
    if (!target.isConnected) {
      throw new Error('Target element is detached from document');
    }
    const tagLower = target.tagName.toLowerCase();
    if (FORBIDDEN_TEXT_EDIT_TAGS.has(tagLower)) {
      throw new Error(
        `In-place text preview does not modify <${tagLower}> form or script controls`,
      );
    }

    const previousHtml = target.innerHTML;
    const nextHtml = replaceDirectTextPreservingChildren(target, newText);
    target.innerHTML = nextHtml;

    this.undoStack.push({
      kind: 'text_edit',
      element: target,
      previousHtml,
      nextHtml,
    });
    this.redoStack.length = 0;

    return this.getStatus();
  }

  public applyFontSwap(params: {
    target: Element | null;
    scope: 'element' | 'similar' | 'page';
    fontFamily: string;
    remoteFontCssUrl?: string;
    allowRemoteFontLoad?: boolean;
  }): EditHistoryStatus {
    const cleanFamily = params.fontFamily.trim();
    if (!cleanFamily || cleanFamily.length > 160 || /[;{}]/.test(cleanFamily)) {
      throw new Error('Invalid font family name');
    }

    let injectedLinkElement: HTMLLinkElement | null = null;
    if (params.remoteFontCssUrl) {
      if (!params.allowRemoteFontLoad) {
        throw new Error('Loading a remote font requires explicit user opt-in');
      }
      const parsedUrl = new URL(params.remoteFontCssUrl);
      if (parsedUrl.protocol !== 'https:') {
        throw new Error('Remote font stylesheet URL must use https://');
      }
      const link = this.doc.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('href', parsedUrl.toString());
      link.setAttribute('data-pagesift-remote-font', 'true');
      this.doc.head.appendChild(link);
      injectedLinkElement = link;
    }

    const elementsToUpdate: HTMLElement[] = [];

    if (params.scope === 'element') {
      if (
        !params.target ||
        !isEditableHtmlElement(params.target) ||
        isPageSiftElement(params.target)
      ) {
        throw new Error('Valid target HTML element is required for element-scoped font swap');
      }
      elementsToUpdate.push(params.target);
    } else if (params.scope === 'similar') {
      if (
        !params.target ||
        !isEditableHtmlElement(params.target) ||
        isPageSiftElement(params.target)
      ) {
        throw new Error('Valid target HTML element is required for similar-element font swap');
      }
      const tag = params.target.tagName.toLowerCase();
      const firstClass = Array.from(params.target.classList)[0];
      const query = firstClass ? `${tag}.${firstClass}` : tag;
      for (const el of Array.from(this.doc.querySelectorAll(query))) {
        if (isEditableHtmlElement(el) && !isPageSiftElement(el)) {
          elementsToUpdate.push(el);
        }
      }
    } else {
      elementsToUpdate.push(this.doc.body);
    }

    const targets: FontSwapTargetState[] = [];
    for (const el of elementsToUpdate) {
      if (!el.isConnected) {
        continue;
      }
      targets.push({
        element: el,
        previousFontFamily: el.style.getPropertyValue('font-family'),
        previousPriority: el.style.getPropertyPriority('font-family'),
        nextFontFamily: cleanFamily,
      });
      el.style.setProperty('font-family', cleanFamily, 'important');
    }

    this.undoStack.push({
      kind: 'font_swap',
      targets,
      injectedLinkElement,
    });
    this.redoStack.length = 0;

    return this.getStatus();
  }

  public applyArrangeMutation(params: {
    target: Element;
    action: 'move' | 'hide' | 'remove';
    dx?: number;
    dy?: number;
  }): EditHistoryStatus {
    if (isPageSiftElement(params.target)) {
      throw new Error('Cannot arrange PageSift internal UI elements');
    }
    if (!isEditableHtmlElement(params.target)) {
      throw new Error('Target element is not an HTML element');
    }
    if (!params.target.isConnected) {
      throw new Error('Target element is detached from document');
    }

    const el = params.target;
    const previousTransform = el.style.getPropertyValue('transform');
    const previousTransformPriority = el.style.getPropertyPriority('transform');
    const previousVisibility = el.style.getPropertyValue('visibility');
    const previousVisibilityPriority = el.style.getPropertyPriority('visibility');
    const previousDisplay = el.style.getPropertyValue('display');
    const previousDisplayPriority = el.style.getPropertyPriority('display');

    let nextTransform = previousTransform;
    let nextVisibility = previousVisibility;
    let nextDisplay = previousDisplay;

    if (params.action === 'move') {
      const dx = Math.round(params.dx ?? 0);
      const dy = Math.round(params.dy ?? 0);
      nextTransform = `translate(${dx}px, ${dy}px)`;
      el.style.setProperty('transform', nextTransform, 'important');
    } else if (params.action === 'hide') {
      nextVisibility = 'hidden';
      el.style.setProperty('visibility', 'hidden', 'important');
    } else {
      nextDisplay = 'none';
      el.style.setProperty('display', 'none', 'important');
    }

    this.undoStack.push({
      kind: 'arrange',
      element: el,
      action: params.action,
      previousTransform,
      previousTransformPriority,
      previousVisibility,
      previousVisibilityPriority,
      previousDisplay,
      previousDisplayPriority,
      nextTransform,
      nextVisibility,
      nextDisplay,
    });
    this.redoStack.length = 0;

    return this.getStatus();
  }

  public undo(): EditHistoryStatus {
    const cmd = this.undoStack.pop();
    if (!cmd) {
      return this.getStatus();
    }
    this.revertCommand(cmd);
    this.redoStack.push(cmd);
    return this.getStatus();
  }

  public redo(): EditHistoryStatus {
    const cmd = this.redoStack.pop();
    if (!cmd) {
      return this.getStatus();
    }
    this.reapplyCommand(cmd);
    this.undoStack.push(cmd);
    return this.getStatus();
  }

  public resetAll(): EditHistoryStatus {
    while (this.undoStack.length > 0) {
      const cmd = this.undoStack.pop();
      if (cmd) {
        this.revertCommand(cmd);
      }
    }
    this.redoStack.length = 0;
    return this.getStatus();
  }

  private revertCommand(cmd: ReversibleCommand): void {
    if (cmd.kind === 'text_edit') {
      if (cmd.element.isConnected) {
        cmd.element.innerHTML = cmd.previousHtml;
      }
      return;
    }

    if (cmd.kind === 'font_swap') {
      for (const item of cmd.targets) {
        if (!item.element.isConnected) {
          continue;
        }
        if (item.previousFontFamily) {
          item.element.style.setProperty(
            'font-family',
            item.previousFontFamily,
            item.previousPriority,
          );
        } else {
          item.element.style.removeProperty('font-family');
        }
      }
      if (cmd.injectedLinkElement && cmd.injectedLinkElement.isConnected) {
        cmd.injectedLinkElement.remove();
      }
      return;
    }

    if (!cmd.element.isConnected) {
      return;
    }
    this.restoreStyleProperty(
      cmd.element,
      'transform',
      cmd.previousTransform,
      cmd.previousTransformPriority,
    );
    this.restoreStyleProperty(
      cmd.element,
      'visibility',
      cmd.previousVisibility,
      cmd.previousVisibilityPriority,
    );
    this.restoreStyleProperty(
      cmd.element,
      'display',
      cmd.previousDisplay,
      cmd.previousDisplayPriority,
    );
  }

  private reapplyCommand(cmd: ReversibleCommand): void {
    if (cmd.kind === 'text_edit') {
      if (cmd.element.isConnected) {
        cmd.element.innerHTML = cmd.nextHtml;
      }
      return;
    }

    if (cmd.kind === 'font_swap') {
      if (cmd.injectedLinkElement && !cmd.injectedLinkElement.isConnected) {
        this.doc.head.appendChild(cmd.injectedLinkElement);
      }
      for (const item of cmd.targets) {
        if (item.element.isConnected) {
          item.element.style.setProperty('font-family', item.nextFontFamily, 'important');
        }
      }
      return;
    }

    if (!cmd.element.isConnected) {
      return;
    }
    if (cmd.action === 'move') {
      cmd.element.style.setProperty('transform', cmd.nextTransform, 'important');
    } else if (cmd.action === 'hide') {
      cmd.element.style.setProperty('visibility', cmd.nextVisibility, 'important');
    } else {
      cmd.element.style.setProperty('display', cmd.nextDisplay, 'important');
    }
  }

  private restoreStyleProperty(
    el: HTMLElement,
    prop: string,
    value: string,
    priority: string,
  ): void {
    if (value) {
      el.style.setProperty(prop, value, priority);
    } else {
      el.style.removeProperty(prop);
    }
  }
}
