import { unzipSync } from 'fflate';
import type { AssetExtractionReport } from '../engines/assets-engine.js';
import { decodeBase64ToBytes } from '../engines/capture-engine.js';
import type { ClonePageManifest } from '../engines/clone-page-engine.js';
import type { ColorExtractionReport } from '../engines/colors-engine.js';
import type { DesignReviewReport } from '../engines/design-review-engine.js';
import type { FontExtractionReport } from '../engines/fonts-engine.js';
import type { InspectElementReport } from '../engines/inspect-engine.js';
import type { MeasureReport } from '../engines/measure-engine.js';
import type { ResponsiveSessionState } from '../engines/responsive-engine.js';
import type { TechStackReport } from '../engines/tech-stack-engine.js';
import type { ToolId } from '../protocol/messages.js';

export interface StructuredRenderCallbacks {
  onCopyText: (text: string, label: string) => void;
  onDownloadSingleAsset: (filename: string, mimeType: string, bytes: Uint8Array) => void;
  getSelectedColorFormat: () => string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function createMetricsStrip(items: Array<{ label: string; value: string }>): HTMLElement {
  const strip = el('div', 'metrics-strip');
  for (const item of items) {
    const cell = el('div', 'metric-cell');
    cell.appendChild(el('span', 'metric-label', item.label));
    cell.appendChild(el('span', 'metric-value', item.value));
    strip.appendChild(cell);
  }
  return strip;
}

function createKvSection(
  title: string,
  rows: Array<[string, string]>,
  colorColumn = false,
): HTMLElement {
  const box = el('div', 'kv-section');
  box.appendChild(el('h3', 'block-title', title));

  const table = el('table', 'kv-table');
  const tbody = el('tbody');
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('th', undefined, k));
    const td = el('td', 'mono');
    const looksLikeColor =
      colorColumn &&
      /^(#|rgb\(|rgba\(|hsl\(|hsla\()/i.test(v.trim()) &&
      v.trim().toLowerCase() !== 'transparent';
    if (looksLikeColor) {
      const chip = el('span');
      chip.style.display = 'inline-block';
      chip.style.width = '11px';
      chip.style.height = '11px';
      chip.style.borderRadius = '2px';
      chip.style.border = '1px solid var(--border-strong)';
      chip.style.backgroundColor = v;
      chip.style.marginRight = '6px';
      chip.style.verticalAlign = '-1px';
      td.appendChild(chip);
    }
    td.appendChild(document.createTextNode(v || '-'));
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  return box;
}

function renderSafeMarkdownPreview(markdown: string): HTMLElement {
  const container = el('div', 'doc-preview');
  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        container.appendChild(el('pre', undefined, codeLines.join('\n')));
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('### ')) {
      container.appendChild(el('h3', undefined, trimmed.slice(4)));
    } else if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      container.appendChild(el('h2', undefined, trimmed.replace(/^#+\s+/, '')));
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const p = el('p', undefined, `• ${trimmed.slice(2)}`);
      p.style.paddingLeft = '10px';
      container.appendChild(p);
    } else {
      container.appendChild(el('p', undefined, trimmed));
    }
  }
  if (codeLines.length > 0) {
    container.appendChild(el('pre', undefined, codeLines.join('\n')));
  }
  return container;
}

function renderInspectView(
  data: Record<string, unknown>,
  callbacks: StructuredRenderCallbacks,
): HTMLElement {
  const wrap = el('div', 'structured-view');
  const report = data['report'] as InspectElementReport | undefined;
  if (!report) {
    wrap.appendChild(
      el('div', 'empty-state', 'Run Inspect to examine an element on the active page.'),
    );
    return wrap;
  }

  const headBlock = el('div', 'flat-block');
  const topRow = el('div', 'block-heading');
  const idWrap = el('div', 'control-row');
  idWrap.appendChild(el('span', 'tag accent mono', report.selector));
  idWrap.appendChild(
    el(
      'span',
      'tag mono',
      `${Math.round(report.boundingBox.width)} × ${Math.round(report.boundingBox.height)} px`,
    ),
  );
  if (report.insideOpenShadowRoot) {
    idWrap.appendChild(el('span', 'tag warning', 'Open Shadow DOM'));
  }
  topRow.appendChild(idWrap);

  const actions = el('div', 'control-row');
  const copySelBtn = el('button', 'secondary sm', 'Copy Selector');
  copySelBtn.type = 'button';
  copySelBtn.addEventListener('click', () => {
    callbacks.onCopyText(report.selector, 'element selector');
  });
  const copyHtmlBtn = el('button', 'secondary sm', 'Copy Safe HTML');
  copyHtmlBtn.type = 'button';
  copyHtmlBtn.addEventListener('click', () => {
    callbacks.onCopyText(report.safeHtml, 'sanitized element HTML');
  });
  const computedCss = [
    `display: ${report.layout.display};`,
    `position: ${report.layout.position};`,
    `font-family: ${report.typography.fontFamily};`,
    `font-size: ${report.typography.fontSize};`,
    `font-weight: ${report.typography.fontWeight};`,
    `line-height: ${report.typography.lineHeight};`,
    `color: ${report.colors.textColor};`,
    `background-color: ${report.colors.backgroundColor};`,
    `border-radius: ${report.bordersAndEffects.borderRadius};`,
    `padding: ${report.spacing.padding.top}px ${report.spacing.padding.right}px ${report.spacing.padding.bottom}px ${report.spacing.padding.left}px;`,
    `margin: ${report.spacing.margin.top}px ${report.spacing.margin.right}px ${report.spacing.margin.bottom}px ${report.spacing.margin.left}px;`,
  ].join('\n');
  const copyCssBtn = el('button', 'secondary sm', 'Copy CSS');
  copyCssBtn.type = 'button';
  copyCssBtn.addEventListener('click', () => {
    callbacks.onCopyText(computedCss, 'computed CSS properties');
  });
  actions.append(copySelBtn, copyHtmlBtn, copyCssBtn);
  topRow.appendChild(actions);
  headBlock.appendChild(topRow);

  const bm = el('div', 'box-model');
  bm.appendChild(
    el(
      'div',
      'muted',
      `margin ${report.spacing.margin.top} / ${report.spacing.margin.right} / ${report.spacing.margin.bottom} / ${report.spacing.margin.left} px`,
    ),
  );
  const bmInner = el('div', 'box-model-inner');
  bmInner.appendChild(
    el(
      'div',
      undefined,
      `padding ${report.spacing.padding.top} / ${report.spacing.padding.right} / ${report.spacing.padding.bottom} / ${report.spacing.padding.left} px`,
    ),
  );
  bmInner.appendChild(
    el(
      'div',
      'box-model-core',
      `${Math.round(report.boundingBox.width)} × ${Math.round(report.boundingBox.height)} px  @ (${Math.round(report.boundingBox.pageX)}, ${Math.round(report.boundingBox.pageY)})`,
    ),
  );
  bm.appendChild(bmInner);
  headBlock.appendChild(bm);
  wrap.appendChild(headBlock);

  const grid = el('div', 'kv-grid');
  grid.appendChild(
    createKvSection('Layout', [
      ['display', report.layout.display],
      ['position', report.layout.position],
      ['flex / align', `${report.layout.flexDirection} · ${report.layout.alignItems}`],
      ['gap', report.layout.gap],
      ['overflow', `${report.layout.overflowX} / ${report.layout.overflowY}`],
      ['z-index', report.layout.zIndex],
    ]),
  );
  grid.appendChild(
    createKvSection('Typography', [
      ['font-family', report.typography.fontFamily],
      ['size / weight', `${report.typography.fontSize} · ${report.typography.fontWeight}`],
      ['line-height', report.typography.lineHeight],
      ['letter-spacing', report.typography.letterSpacing],
      ['text-align', report.typography.textAlign],
    ]),
  );
  grid.appendChild(
    createKvSection(
      'Colors & Effects',
      [
        ['text', report.colors.textColor],
        ['background', report.colors.backgroundColor],
        ['border', report.colors.borderColor],
        ['radius', report.bordersAndEffects.borderRadius],
        ['opacity', report.bordersAndEffects.opacity],
        ['shadow', report.bordersAndEffects.boxShadow],
      ],
      true,
    ),
  );
  grid.appendChild(
    createKvSection('Accessibility', [
      ['tag', report.tagName],
      ['role', report.accessibility.role ?? 'implicit'],
      ['accessible name', report.accessibility.accessibleName ?? 'none'],
      [
        'tabindex',
        report.accessibility.tabIndex !== null ? String(report.accessibility.tabIndex) : 'default',
      ],
    ]),
  );
  wrap.appendChild(grid);
  wrap.appendChild(el('div', 'notice-bar', report.diagnostics.computedStyleNotice));
  return wrap;
}

function renderClonePageView(data: Record<string, unknown>): HTMLElement {
  const wrap = el('div', 'structured-view');
  const manifest = data['manifest'] as ClonePageManifest | undefined;
  if (!manifest) {
    wrap.appendChild(
      el('div', 'empty-state', 'Run Clone Page to build a sanitized static HTML/CSS snapshot ZIP.'),
    );
    return wrap;
  }

  wrap.appendChild(
    createMetricsStrip([
      { label: 'Bundled Assets', value: String(manifest.rewrittenAssets.length) },
      { label: 'Archive Files', value: String(manifest.files.length) },
      {
        label: 'CSS Rules Captured',
        value: String(manifest.cssFidelity.accessibleStylesheetRulesCount),
      },
      { label: 'Missing / Skipped', value: String(manifest.missingResources.length) },
    ]),
  );

  const policy = el('div', 'flat-block');
  const ph = el('div', 'block-heading');
  ph.appendChild(el('h3', 'block-title', 'Snapshot Scope & Sanitization'));
  ph.appendChild(
    el(
      'span',
      manifest.isSelfContained ? 'tag positive' : 'tag warning',
      manifest.isSelfContained ? 'Self-Contained Archive' : 'Partial — Missing Resources Listed',
    ),
  );
  policy.appendChild(ph);
  policy.appendChild(
    el(
      'div',
      'muted',
      `${manifest.scopeDisclaimer} Sanitizer: ${manifest.sanitizationPolicy.sanitizer}. Defensive CSP applied: ${manifest.sanitizationPolicy.defensiveCspApplied ? 'Yes' : 'No'}.`,
    ),
  );
  policy.appendChild(el('div', 'muted', manifest.cssFidelity.fidelityNote));
  wrap.appendChild(policy);

  if (manifest.missingResources.length > 0) {
    const missBlock = el('div', 'flat-block');
    missBlock.appendChild(
      el(
        'h3',
        'block-title',
        `Missing or Unbundled Resources (${manifest.missingResources.length})`,
      ),
    );
    const scroll = el('div', 'table-scroll');
    const table = el('table', 'kv-table');
    const thead = el('thead');
    const htr = el('tr');
    htr.append(
      el('th', undefined, 'Context'),
      el('th', undefined, 'Resource URL'),
      el('th', undefined, 'Reason'),
    );
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const item of manifest.missingResources.slice(0, 40)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', item.context));
      tr.appendChild(el('td', 'mono break-all', item.url));
      tr.appendChild(el('td', undefined, item.reason));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    missBlock.appendChild(scroll);
    wrap.appendChild(missBlock);
  }
  return wrap;
}

function renderAssetsView(
  data: Record<string, unknown>,
  callbacks: StructuredRenderCallbacks,
): HTMLElement {
  const wrap = el('div', 'structured-view');
  const report = data['report'] as AssetExtractionReport | undefined;
  if (!report) {
    wrap.appendChild(
      el('div', 'empty-state', 'Run Assets to discover images, SVGs, fonts, and media.'),
    );
    return wrap;
  }

  const packagedAssets = Array.isArray(data['packagedAssets'])
    ? (data['packagedAssets'] as Array<{
        id?: string;
        url?: string;
        originalUrl?: string;
        archivePath: string;
        mimeType?: string;
        byteLength?: number;
      }>)
    : [];
  const skipped = Array.isArray(data['skippedOrUnavailable'])
    ? (data['skippedOrUnavailable'] as Array<{ url: string; reason: string }>)
    : [];

  let zipEntries: Record<string, Uint8Array> | null = null;
  if (typeof data['zipBase64'] === 'string' && data['zipBase64'].length > 0) {
    try {
      zipEntries = unzipSync(decodeBase64ToBytes(data['zipBase64']));
    } catch {
      zipEntries = null;
    }
  }
  const packagedByUrl = new Map(
    packagedAssets.map((p) => [p.url ?? p.originalUrl ?? '', p] as const),
  );
  const packagedById = new Map(
    packagedAssets
      .filter((p): p is typeof p & { id: string } => typeof p.id === 'string')
      .map((p) => [p.id, p] as const),
  );
  const skippedByUrl = new Map(skipped.map((s) => [s.url, s.reason]));

  wrap.appendChild(
    createMetricsStrip([
      { label: 'Discovered', value: String(report.summary.totalDiscovered) },
      { label: 'Bundled in ZIP', value: String(packagedAssets.length) },
      { label: 'Inline SVGs', value: String(report.summary.inlineAvailableCount) },
      {
        label: 'Skipped / Unavailable',
        value: String(skipped.length + report.summary.unavailableOrProtectedCount),
      },
    ]),
  );

  const filterBar = el('div', 'filter-bar');
  const grid = el('div', 'asset-grid');
  const filters: Array<{ id: string; label: string }> = [
    { id: 'all', label: `All (${report.assets.length})` },
    { id: 'image', label: 'Images' },
    { id: 'svg', label: 'SVGs' },
    { id: 'font', label: 'Fonts' },
    { id: 'background', label: 'Backgrounds' },
    { id: 'unavailable', label: 'Unavailable' },
  ];

  let activeFilter = 'all';

  const drawCards = (): void => {
    grid.textContent = '';
    const visible = report.assets.filter((asset) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'unavailable') {
        return (
          asset.availabilityStatus === 'streaming_or_blob_unavailable' ||
          asset.availabilityStatus === 'protected_or_invalid' ||
          skippedByUrl.has(asset.url)
        );
      }
      if (activeFilter === 'image') {
        return asset.kind === 'image' || asset.kind === 'icon' || asset.kind === 'poster';
      }
      return asset.kind === activeFilter;
    });

    if (visible.length === 0) {
      grid.appendChild(el('div', 'empty-state', 'No assets match this filter.'));
      return;
    }

    for (const asset of visible.slice(0, 60)) {
      const card = el('div', 'asset-card');
      const thumb = el('div', 'asset-thumb');

      const pkg = packagedByUrl.get(asset.url) ?? packagedById.get(asset.id);
      const pkgBytes = pkg && zipEntries ? zipEntries[pkg.archivePath] : undefined;

      if (asset.safeSvgPreview) {
        const img = el('img');
        img.alt = asset.altText || asset.safeFilename;
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.safeSvgPreview)}`;
        thumb.appendChild(img);
      } else if (
        pkgBytes &&
        (asset.kind === 'image' ||
          asset.kind === 'icon' ||
          asset.kind === 'background' ||
          asset.kind === 'poster')
      ) {
        const mime = pkg?.mimeType || asset.mimeTypeHint || 'image/png';
        const copy = new Uint8Array(pkgBytes.byteLength);
        copy.set(pkgBytes);
        const blobUrl = URL.createObjectURL(new Blob([copy], { type: mime }));
        const img = el('img');
        img.alt = asset.altText || asset.safeFilename;
        img.src = blobUrl;
        img.addEventListener('load', () => {
          URL.revokeObjectURL(blobUrl);
        });
        thumb.appendChild(img);
      } else {
        thumb.appendChild(el('span', 'tag mono', asset.kind));
      }
      card.appendChild(thumb);

      const nameRow = el('div', 'block-heading');
      const fileLabel = pkg
        ? pkg.archivePath.startsWith('assets/')
          ? pkg.archivePath.slice(7)
          : pkg.archivePath
        : asset.safeFilename;
      nameRow.appendChild(el('span', 'mono truncate', fileLabel));
      const skipReason = skippedByUrl.get(asset.url);
      if (pkg) {
        nameRow.appendChild(el('span', 'tag positive', 'Bundled'));
      } else if (asset.availabilityStatus === 'inline_available') {
        nameRow.appendChild(el('span', 'tag accent', 'Inline'));
      } else if (skipReason) {
        nameRow.appendChild(el('span', 'tag warning', 'Skipped'));
      } else {
        nameRow.appendChild(el('span', 'tag danger', 'Unavailable'));
      }
      card.appendChild(nameRow);

      const metaParts = [asset.mimeTypeHint];
      if (asset.width && asset.height) {
        metaParts.push(`${asset.width}×${asset.height}`);
      }
      if (pkg?.byteLength) {
        metaParts.push(`${pkg.byteLength.toLocaleString()} B`);
      }
      card.appendChild(el('div', 'muted truncate', metaParts.join(' · ')));

      if (skipReason) {
        card.appendChild(el('div', 'muted break-all', skipReason));
      } else if (asset.url) {
        card.appendChild(el('div', 'mono muted truncate', asset.url));
      }

      const btnRow = el('div', 'control-row');
      if (pkgBytes && pkg) {
        const dlBtn = el('button', 'secondary sm', 'Download');
        dlBtn.type = 'button';
        dlBtn.addEventListener('click', () => {
          callbacks.onDownloadSingleAsset(
            fileLabel,
            pkg.mimeType || asset.mimeTypeHint || 'application/octet-stream',
            pkgBytes,
          );
        });
        btnRow.appendChild(dlBtn);
      } else if (asset.safeSvgPreview) {
        const dlBtn = el('button', 'secondary sm', 'Download SVG');
        dlBtn.type = 'button';
        dlBtn.addEventListener('click', () => {
          callbacks.onDownloadSingleAsset(
            asset.safeFilename.endsWith('.svg') ? asset.safeFilename : `${asset.safeFilename}.svg`,
            'image/svg+xml;charset=utf-8',
            new TextEncoder().encode(asset.safeSvgPreview ?? ''),
          );
        });
        btnRow.appendChild(dlBtn);
      }
      if (asset.url && asset.url.startsWith('http')) {
        const cpBtn = el('button', 'ghost sm', 'Copy URL');
        cpBtn.type = 'button';
        cpBtn.addEventListener('click', () => {
          callbacks.onCopyText(asset.url, 'asset URL');
        });
        btnRow.appendChild(cpBtn);
      }
      if (btnRow.childNodes.length > 0) {
        card.appendChild(btnRow);
      }
      grid.appendChild(card);
    }
  };

  for (const f of filters) {
    const chip = el(
      'button',
      f.id === activeFilter ? 'filter-chip active' : 'filter-chip',
      f.label,
    );
    chip.type = 'button';
    chip.addEventListener('click', () => {
      activeFilter = f.id;
      filterBar.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b === chip);
      });
      drawCards();
    });
    filterBar.appendChild(chip);
  }

  drawCards();
  wrap.appendChild(filterBar);
  wrap.appendChild(grid);
  return wrap;
}

function renderColorsView(
  data: Record<string, unknown>,
  callbacks: StructuredRenderCallbacks,
): HTMLElement {
  const wrap = el('div', 'structured-view');
  const report = data['report'] as ColorExtractionReport | undefined;
  if (!report) {
    wrap.appendChild(el('div', 'empty-state', 'Run Colors to extract normalized palette tokens.'));
    return wrap;
  }

  wrap.appendChild(
    createMetricsStrip([
      { label: 'Unique Colors', value: String(report.colors.length) },
      { label: 'Gradients', value: String(report.gradients.length) },
      { label: 'CSS Variables', value: String(report.customProperties.length) },
      { label: 'Scanned Nodes', value: String(report.diagnostics.scannedElementsCount) },
    ]),
  );

  if (report.colors.length === 0) {
    wrap.appendChild(
      el('div', 'empty-state', 'No distinct rendered colors detected on this page.'),
    );
  } else {
    const grid = el('div', 'swatch-grid');
    for (const token of report.colors.slice(0, 36)) {
      const card = el('div', 'swatch-card');
      const preview = el('div', 'swatch-preview');
      const fill = el('div', 'swatch-fill');
      fill.style.backgroundColor = token.rgbString;
      preview.appendChild(fill);
      card.appendChild(preview);

      const meta = el('div', 'swatch-meta');
      const top = el('div', 'block-heading');
      top.appendChild(el('span', 'mono', token.hex));
      top.appendChild(el('span', 'muted mono', `${token.usageCount}×`));
      meta.appendChild(top);
      meta.appendChild(el('div', 'muted mono truncate', token.rgbString));
      meta.appendChild(el('div', 'muted mono truncate', token.hslString));

      const copyBtn = el('button', 'secondary sm', `Copy ${token.hex}`);
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', () => {
        callbacks.onCopyText(token.hex, `color ${token.hex}`);
      });
      meta.appendChild(copyBtn);
      card.appendChild(meta);
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
  }

  const fmt = callbacks.getSelectedColorFormat();
  const exportMap: Record<string, string> = {
    cssVariables: report.exports.cssVariables,
    tailwindV4: report.exports.tailwindV4Theme,
    tailwindV3: report.exports.tailwindV3Config,
    scss: report.exports.scss,
    json: report.exports.json,
  };
  const activeExportText = exportMap[fmt] ?? report.exports.cssVariables;
  const exportBlock = el('div', 'flat-block');
  exportBlock.appendChild(el('h3', 'block-title', `Token Export (${fmt})`));
  exportBlock.appendChild(el('pre', 'code-box', activeExportText));
  wrap.appendChild(exportBlock);

  return wrap;
}

function renderFontsView(data: Record<string, unknown>): HTMLElement {
  const wrap = el('div', 'structured-view');
  const report = data['report'] as FontExtractionReport | undefined;
  if (!report) {
    wrap.appendChild(
      el('div', 'empty-state', 'Run Fonts to inspect typography families and scale.'),
    );
    return wrap;
  }

  wrap.appendChild(el('div', 'notice-bar', report.diagnostics.renderedFontIdentityDisclosure));
  wrap.appendChild(
    createMetricsStrip([
      { label: 'Font Families', value: String(report.families.length) },
      { label: '@font-face Rules', value: String(report.fontFaceDeclarations.length) },
      { label: 'Scanned Nodes', value: String(report.diagnostics.scannedElementsCount) },
    ]),
  );

  for (const family of report.families.slice(0, 12)) {
    const block = el('div', 'flat-block');
    const hdr = el('div', 'block-heading');
    const titleWrap = el('div');
    titleWrap.appendChild(el('h3', 'block-title', family.primaryFamily));
    titleWrap.appendChild(el('div', 'muted mono break-all', family.declaredStack));
    hdr.appendChild(titleWrap);

    const tags = el('div', 'control-row');
    tags.appendChild(el('span', 'tag', `${family.totalUsageCount} elements`));
    const loadedLabel =
      family.verifiedLoadedInFontFaceSet === true
        ? 'Loaded (FontFaceSet)'
        : family.verifiedLoadedInFontFaceSet === 'unsupported'
          ? 'System / Unchecked'
          : 'Fallback / Not Loaded';
    tags.appendChild(
      el(
        'span',
        family.verifiedLoadedInFontFaceSet === true ? 'tag positive' : 'tag warning',
        loadedLabel,
      ),
    );
    hdr.appendChild(tags);
    block.appendChild(hdr);

    const scroll = el('div', 'table-scroll');
    const table = el('table', 'kv-table');
    const thead = el('thead');
    const htr = el('tr');
    htr.append(
      el('th', undefined, 'Size'),
      el('th', undefined, 'Weight'),
      el('th', undefined, 'Line Height'),
      el('th', undefined, 'Count'),
      el('th', undefined, 'Sample'),
    );
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const combo of family.combinations.slice(0, 8)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', combo.fontSize));
      tr.appendChild(el('td', 'mono', combo.fontWeight));
      tr.appendChild(el('td', 'mono', combo.lineHeight));
      tr.appendChild(el('td', 'mono', String(combo.usageCount)));
      const sampleTd = el('td', undefined, combo.sampleText || 'Aa Bb Cc 123');
      sampleTd.style.fontWeight = combo.fontWeight;
      tr.appendChild(sampleTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    block.appendChild(scroll);
    wrap.appendChild(block);
  }
  return wrap;
}

function renderMeasureView(data: Record<string, unknown>): HTMLElement {
  const wrap = el('div', 'structured-view');
  const report = data['report'] as MeasureReport | undefined;
  if (!report) {
    wrap.appendChild(el('div', 'empty-state', 'Enter one or two selectors and run Measure.'));
    return wrap;
  }

  const stats: Array<{ label: string; value: string }> = [
    { label: 'Primary Size', value: `${report.primary.width} × ${report.primary.height} px` },
    { label: 'Device Scale', value: `${report.viewport.devicePixelRatio}x` },
  ];
  if (report.distance) {
    stats.push(
      { label: 'Horizontal Gap', value: `${report.distance.horizontalGap} px` },
      { label: 'Vertical Gap', value: `${report.distance.verticalGap} px` },
      { label: 'Center Distance', value: `${report.distance.centerDistance} px` },
      { label: 'Overlap', value: report.distance.isOverlapping ? 'Yes' : 'No' },
    );
  }
  wrap.appendChild(createMetricsStrip(stats));

  const grid = el('div', 'kv-grid');
  grid.appendChild(
    createKvSection(`Primary: ${report.primary.selector}`, [
      [
        'viewport rect',
        `${report.primary.left}, ${report.primary.top} (${report.primary.width}×${report.primary.height})`,
      ],
      ['page offset', `${report.primary.pageX}, ${report.primary.pageY}`],
      [
        'padding',
        `${report.primary.padding.top} / ${report.primary.padding.right} / ${report.primary.padding.bottom} / ${report.primary.padding.left}`,
      ],
      [
        'margin',
        `${report.primary.margin.top} / ${report.primary.margin.right} / ${report.primary.margin.bottom} / ${report.primary.margin.left}`,
      ],
    ]),
  );
  if (report.secondary) {
    grid.appendChild(
      createKvSection(`Secondary: ${report.secondary.selector}`, [
        [
          'viewport rect',
          `${report.secondary.left}, ${report.secondary.top} (${report.secondary.width}×${report.secondary.height})`,
        ],
        ['page offset', `${report.secondary.pageX}, ${report.secondary.pageY}`],
        [
          'padding',
          `${report.secondary.padding.top} / ${report.secondary.padding.right} / ${report.secondary.padding.bottom} / ${report.secondary.padding.left}`,
        ],
        [
          'margin',
          `${report.secondary.margin.top} / ${report.secondary.margin.right} / ${report.secondary.margin.bottom} / ${report.secondary.margin.left}`,
        ],
      ]),
    );
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderResponsiveView(data: Record<string, unknown>): HTMLElement {
  const wrap = el('div', 'structured-view');
  const session = data['session'] as ResponsiveSessionState | null | undefined;
  if (!session || session.windows.length === 0) {
    wrap.appendChild(
      el(
        'div',
        'empty-state',
        'Select presets or a custom viewport size and open preview windows to compare layouts and synchronize scrolling.',
      ),
    );
    return wrap;
  }

  const block = el('div', 'flat-block');
  const hdr = el('div', 'block-heading');
  hdr.appendChild(
    el('h3', 'block-title', `Managed Responsive Windows (${session.windows.length})`),
  );
  hdr.appendChild(
    el(
      'span',
      session.syncEnabled ? 'tag positive' : 'tag',
      session.syncEnabled ? 'Scroll Sync Active' : 'Scroll Sync Off',
    ),
  );
  block.appendChild(hdr);

  const scroll = el('div', 'table-scroll');
  const table = el('table', 'kv-table');
  const thead = el('thead');
  const htr = el('tr');
  htr.append(
    el('th', undefined, 'Preset'),
    el('th', undefined, 'Requested'),
    el('th', undefined, 'Measured Inner'),
    el('th', undefined, 'Chrome Delta'),
    el('th', undefined, 'Fit Status'),
  );
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const w of session.windows) {
    const tr = el('tr');
    tr.appendChild(el('td', undefined, w.label));
    tr.appendChild(el('td', 'mono', `${w.requestedWidth} × ${w.requestedHeight}`));
    tr.appendChild(
      el(
        'td',
        'mono',
        w.actualInnerWidth !== null && w.actualInnerHeight !== null
          ? `${w.actualInnerWidth} × ${w.actualInnerHeight}`
          : 'Pending',
      ),
    );
    tr.appendChild(
      el(
        'td',
        'mono',
        w.chromeDeltaWidth !== null && w.chromeDeltaHeight !== null
          ? `+${w.chromeDeltaWidth}w / +${w.chromeDeltaHeight}h`
          : '-',
      ),
    );
    const stTd = el('td');
    stTd.appendChild(
      el(
        'span',
        w.sizeConstrainedByBrowser ? 'tag warning' : 'tag positive',
        w.sizeConstrainedByBrowser ? 'OS Min-Width Constrained' : 'Exact Match',
      ),
    );
    tr.appendChild(stTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  block.appendChild(scroll);
  wrap.appendChild(block);
  return wrap;
}

function renderDesignReviewView(
  data: Record<string, unknown>,
  callbacks: StructuredRenderCallbacks,
): HTMLElement {
  const wrap = el('div', 'structured-view');
  const report = data['report'] as DesignReviewReport | undefined;
  if (!report) {
    wrap.appendChild(
      el('div', 'empty-state', 'Run Design Review to audit hierarchy, spacing, and WCAG contrast.'),
    );
    return wrap;
  }

  wrap.appendChild(el('div', 'notice-bar', report.methodologyDisclaimer));
  wrap.appendChild(
    createMetricsStrip([
      { label: 'Total Findings', value: String(report.findings.length) },
      { label: 'Contrast Failures', value: String(report.metrics.contrastFailuresCount) },
      { label: 'Heading Scale', value: `${report.metrics.headingScaleRatio}x` },
      { label: 'Off-Grid Spacings', value: String(report.metrics.offGridSpacingValuesPx.length) },
    ]),
  );

  if (report.findings.length === 0) {
    wrap.appendChild(
      el(
        'div',
        'empty-state',
        'No heuristic contrast, hierarchy, or spacing issues flagged on this page.',
      ),
    );
  } else {
    for (const severity of ['high', 'medium', 'low'] as const) {
      const grouped = report.findings.filter((f) => f.severity === severity);
      if (grouped.length === 0) {
        continue;
      }
      wrap.appendChild(
        el(
          'div',
          'rail-group-label',
          `${severity[0]?.toUpperCase() ?? ''}${severity.slice(1)} impact (${grouped.length})`,
        ),
      );
      for (const f of grouped) {
        const card = el('div', `finding-row sev-${f.severity}`);
        const hdr = el('div', 'block-heading');
        hdr.appendChild(el('strong', undefined, f.title));
        const tagClass =
          f.severity === 'high'
            ? 'tag danger'
            : f.severity === 'medium'
              ? 'tag warning'
              : 'tag accent';
        hdr.appendChild(el('span', tagClass, `${f.severity} · ${f.category.replace(/_/g, ' ')}`));
        card.appendChild(hdr);
        card.appendChild(el('div', 'muted', `Evidence: ${f.evidence}`));
        card.appendChild(el('div', undefined, `Suggested fix: ${f.suggestion}`));
        if (f.affectedSelectors.length > 0) {
          const selRow = el('div', 'control-row');
          for (const s of f.affectedSelectors.slice(0, 6)) {
            selRow.appendChild(el('span', 'tag mono', s));
          }
          card.appendChild(selRow);
        }
        wrap.appendChild(card);
      }
    }
  }

  if (report.localFixPrompt) {
    const promptBtn = el('button', 'secondary sm', 'Copy Remediation Prompt');
    promptBtn.type = 'button';
    promptBtn.addEventListener('click', () => {
      callbacks.onCopyText(report.localFixPrompt, 'remediation prompt');
    });
    const row = el('div', 'control-row');
    row.appendChild(promptBtn);
    wrap.appendChild(row);
  }
  return wrap;
}

function renderTechStackView(data: Record<string, unknown>): HTMLElement {
  const wrap = el('div', 'structured-view');
  const report = data['report'] as TechStackReport | undefined;
  if (!report) {
    wrap.appendChild(
      el('div', 'empty-state', 'Run Tech Stack to inspect public frontend markers.'),
    );
    return wrap;
  }

  wrap.appendChild(el('div', 'notice-bar', report.methodologyDisclosure));

  if (report.detections.length === 0) {
    wrap.appendChild(
      el(
        'div',
        'empty-state',
        'No public framework, CSS library, CMS, or analytics markers were detected on this page.',
      ),
    );
    return wrap;
  }

  const grid = el('div', 'kv-grid');
  for (const det of report.detections) {
    const box = el('div', 'kv-section');
    const hdr = el('div', 'block-heading');
    hdr.appendChild(el('h3', 'block-title', det.technology));
    const tags = el('div', 'control-row');
    tags.appendChild(el('span', 'tag', det.category.replace(/_/g, ' ')));
    tags.appendChild(
      el(
        'span',
        det.confidence === 'high'
          ? 'tag positive'
          : det.confidence === 'medium'
            ? 'tag accent'
            : 'tag warning',
        `${det.confidence} confidence`,
      ),
    );
    hdr.appendChild(tags);
    box.appendChild(hdr);

    const list = el('ul');
    list.style.margin = '0 0 6px';
    list.style.paddingLeft = '18px';
    for (const ev of det.evidence) {
      list.appendChild(el('li', 'mono', ev));
    }
    box.appendChild(list);
    box.appendChild(el('div', 'muted', `Uncertainty: ${det.uncertaintyNote}`));
    grid.appendChild(box);
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderEditPreviewView(tool: ToolId, data: Record<string, unknown>): HTMLElement {
  const wrap = el('div', 'structured-view');
  const history = data['history'] as { undoCount?: number; redoCount?: number } | undefined;
  wrap.appendChild(
    el(
      'div',
      'notice-bar',
      'Local preview only — changes apply strictly inside this live browser tab and reset automatically when the page reloads.',
    ),
  );
  wrap.appendChild(
    createMetricsStrip([
      { label: 'Preview Action', value: tool.replace('_', ' ') },
      { label: 'Undo Steps', value: String(history?.undoCount ?? 0) },
      { label: 'Redo Steps', value: String(history?.redoCount ?? 0) },
    ]),
  );
  return wrap;
}

function renderCaptureSummaryView(data: Record<string, unknown>): HTMLElement {
  const wrap = el('div', 'structured-view');
  const verified = data['verified'] as
    | { width: number; height: number; mimeType: string; byteLength: number }
    | undefined;
  const tilesCaptured = typeof data['tilesCaptured'] === 'number' ? data['tilesCaptured'] : 1;
  const nestedScrollDetected = data['nestedScrollDetected'] === true;

  if (!verified) {
    wrap.appendChild(
      el(
        'div',
        'notice-bar',
        'Capture limits: up to 32,768px canvas dimensions (16,383px max for WebP), 40 full-page tiles, and 550ms inter-tile pacing.',
      ),
    );
    return wrap;
  }

  wrap.appendChild(
    createMetricsStrip([
      { label: 'Resolution', value: `${verified.width} × ${verified.height} px` },
      { label: 'Format', value: verified.mimeType },
      { label: 'File Size', value: `${(verified.byteLength / 1024).toFixed(1)} KiB` },
      { label: 'Tiles Captured', value: String(tilesCaptured) },
    ]),
  );
  if (nestedScrollDetected) {
    wrap.appendChild(
      el(
        'div',
        'status-line warning',
        'Nested scroll container detected — full-page scrolling stopped at the document scroll boundary.',
      ),
    );
  }
  return wrap;
}

export function renderStructuredToolResult(
  tool: ToolId,
  data: Record<string, unknown>,
  callbacks: StructuredRenderCallbacks,
): HTMLElement {
  switch (tool) {
    case 'inspect':
      return renderInspectView(data, callbacks);
    case 'clone_page':
      return renderClonePageView(data);
    case 'design_md': {
      const wrap = el('div', 'structured-view');
      const md = (data['result'] as { markdown?: string } | undefined)?.markdown ?? '';
      wrap.appendChild(
        md
          ? renderSafeMarkdownPreview(md)
          : el('div', 'empty-state', 'Run Design MD to generate a structured design-system file.'),
      );
      return wrap;
    }
    case 'clone_prompt': {
      const wrap = el('div', 'structured-view');
      const prompt = (data['report'] as { prompt?: string } | undefined)?.prompt ?? '';
      wrap.appendChild(
        prompt
          ? renderSafeMarkdownPreview(prompt)
          : el(
              'div',
              'empty-state',
              'Run Clone Prompt to generate a structured implementation brief.',
            ),
      );
      return wrap;
    }
    case 'assets':
      return renderAssetsView(data, callbacks);
    case 'colors':
      return renderColorsView(data, callbacks);
    case 'fonts':
      return renderFontsView(data);
    case 'measure':
      return renderMeasureView(data);
    case 'capture':
      return renderCaptureSummaryView(data);
    case 'responsive':
      return renderResponsiveView(data);
    case 'design_review':
      return renderDesignReviewView(data, callbacks);
    case 'tech_stack':
      return renderTechStackView(data);
    case 'edit_text':
    case 'swap_font':
    case 'arrange':
      return renderEditPreviewView(tool, data);
  }
}
