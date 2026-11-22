import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { OnPageOverlayDashboard } from '../../src/extension/content/overlay-dashboard.js';

describe('Overlay edit controls', () => {
  it('requires explicit text and apply before changing a selected page element', async () => {
    const dom = new JSDOM('<!doctype html><body><h1>Original heading</h1></body>', {
      url: 'https://example.com',
    });
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const calls: unknown[] = [];
    const overlay = new OnPageOverlayDashboard(dom.window.document, shadow, {
      getPageInfo: () => ({
        title: 'Example',
        url: 'https://example.com',
        hostname: 'example.com',
      }),
      getResourceUrl: () => null,
      onRunOverlayTool: (tool, options) => {
        calls.push({ tool, options });
        return Promise.resolve(null);
      },
      onStartPickerForTool: () => undefined,
      onOpenFullDashboard: () => Promise.resolve(),
      onFetchSiteActivity: () => Promise.resolve([]),
      onCloseOverlay: () => undefined,
    });
    expect(shadow.querySelector('.ps-anchor')?.getAttribute('data-theme')).toBe('dark');
    expect(shadow.querySelectorAll('button[data-overlay-bar-tool]').length).toBe(15);

    expect(overlay.handleToolbarActionClick()).toBe('expanded');
    expect(overlay.isPipMenuOpen()).toBe(false);
    expect(overlay.handleToolbarActionClick()).toBe('expanded');
    expect(overlay.isPipMenuOpen()).toBe(true);
    expect(
      shadow.querySelector('.ps-pip-menu.open button[data-ps-action="open-settings"]'),
    ).not.toBeNull();
    expect(overlay.handleToolbarActionClick()).toBe('expanded');
    expect(overlay.isPipMenuOpen()).toBe(false);

    shadow.querySelector<HTMLButtonElement>('button[data-overlay-bar-tool="responsive"]')?.click();
    expect(shadow.querySelector('.ps-drawer.ps-drawer-wide.open')).not.toBeNull();
    expect(shadow.querySelectorAll('iframe[name="pagesift-responsive-frame"]').length).toBe(1);
    shadow.querySelector<HTMLButtonElement>('button[data-ps-resp-mode="grid"]')?.click();
    expect(shadow.querySelectorAll('iframe[name="pagesift-responsive-frame"]').length).toBe(2);

    overlay.showResultSummary({
      tool: 'tech_stack',
      title: 'Tech Stack (2 Detected)',
      summary: 'Next.js, React',
      techStackSummary: {
        totalDetected: 2,
        oneLiner: 'Next.js, React',
        groups: [
          {
            category: 'framework',
            label: 'Frameworks & Runtimes',
            items: [
              { technology: 'Next.js', confidence: 'high', shortReason: '#__next root' },
              { technology: 'React', confidence: 'medium', shortReason: 'React mount' },
            ],
          },
        ],
      },
    });
    expect(shadow.querySelectorAll('.tech-badge-icon svg').length).toBe(2);
    expect(shadow.querySelectorAll('.tech-cat-icon').length).toBe(1);
    const techSearch = shadow.querySelector<HTMLInputElement>('input[data-ps-tech-search]');
    expect(techSearch).not.toBeNull();
    if (techSearch) {
      techSearch.value = 'React';
      techSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      expect(shadow.querySelectorAll('.ps-stack-item').length).toBe(1);
    }

    overlay.showEditor('edit_text', 'h1', 'Original heading');
    expect(calls).toEqual([]);
    const input = shadow.querySelector<HTMLTextAreaElement>('[data-ps-edit-text]');
    expect(input?.value).toBe('Original heading');
    if (!input) throw new Error('Text editor is missing');
    input.value = 'Explicit replacement';
    shadow
      .querySelector<HTMLFormElement>('[data-ps-edit-form]')
      ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ tool: 'edit_text', options: { text: 'Explicit replacement' } }]);
    overlay.close();
    dom.window.close();
  });
});
