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
    overlay.openExpanded();
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
