import { createSvgIcon } from './theme.js';

export type MacNotificationTone = 'info' | 'success' | 'warning' | 'error';

export interface MacNotificationOptions {
  title: string;
  message: string;
  tone?: MacNotificationTone;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
}

const STACK_ID = 'pagesift-mac-notify-stack';

function ensureNotificationStack(doc: Document): HTMLElement {
  let stack = doc.getElementById(STACK_ID);
  if (stack && stack.isConnected) {
    return stack;
  }
  stack = doc.createElement('div');
  stack.id = STACK_ID;
  stack.className = 'ps-mac-toast-stack';
  stack.setAttribute('aria-live', 'polite');
  stack.setAttribute('aria-relevant', 'additions removals');
  doc.body.appendChild(stack);
  return stack;
}

export function pushMacNotification(
  options: MacNotificationOptions,
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): void {
  if (!doc) {
    return;
  }
  const stack = ensureNotificationStack(doc);
  while (stack.childElementCount >= 3) {
    stack.firstElementChild?.remove();
  }

  const tone: MacNotificationTone = options.tone ?? 'info';
  const card = doc.createElement('div');
  card.className = `ps-mac-toast ps-mac-toast-${tone}`;
  card.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const topRow = doc.createElement('div');
  topRow.className = 'ps-mac-toast-top';

  const brand = doc.createElement('div');
  brand.className = 'ps-mac-toast-brand';
  const dot = doc.createElement('span');
  dot.className = 'ps-mac-toast-dot';
  const appLabel = doc.createElement('span');
  appLabel.textContent = 'PageSift';
  brand.append(dot, appLabel);

  const metaRight = doc.createElement('div');
  metaRight.className = 'ps-mac-toast-meta';
  const timeEl = doc.createElement('span');
  timeEl.textContent = 'now';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ps-mac-toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.appendChild(createSvgIcon('close', '', doc));

  metaRight.append(timeEl, closeBtn);
  topRow.append(brand, metaRight);

  const titleEl = doc.createElement('div');
  titleEl.className = 'ps-mac-toast-title';
  titleEl.textContent = options.title;

  const msgEl = doc.createElement('div');
  msgEl.className = 'ps-mac-toast-body';
  msgEl.textContent = options.message;

  card.append(topRow, titleEl, msgEl);

  if (options.actionLabel && options.onAction) {
    const actionsRow = doc.createElement('div');
    actionsRow.className = 'ps-mac-toast-actions';
    const actBtn = doc.createElement('button');
    actBtn.type = 'button';
    actBtn.className = 'secondary sm';
    actBtn.textContent = options.actionLabel;
    const handler = options.onAction;
    actBtn.addEventListener('click', () => {
      dismiss();
      handler();
    });
    actionsRow.appendChild(actBtn);
    card.appendChild(actionsRow);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const dismiss = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    card.classList.add('leaving');
    setTimeout(() => {
      card.remove();
    }, 180);
  };

  closeBtn.addEventListener('click', dismiss);

  const duration = options.durationMs ?? (tone === 'error' ? 7500 : 4500);
  const startTimer = (): void => {
    if (duration > 0) {
      timer = setTimeout(dismiss, duration);
    }
  };
  card.addEventListener('mouseenter', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
  card.addEventListener('mouseleave', startTimer);

  stack.appendChild(card);
  startTimer();
}
