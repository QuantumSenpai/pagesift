import type { MotionInspectionResult } from '../engines/motion-observation-engine.js';
import type { GeneratedMotionExports } from '../engines/motion-codegen-engine.js';
import {
  summarizeMotionSpecCounts,
  type MotionSpec,
  type MotionTriggerType,
} from '../engines/motion-spec.js';

export interface OverlayMotionDrawerState {
  targetSelector: string;
  trigger: MotionTriggerType;
  durationMs: number;
  status: 'idle' | 'observing' | 'ready' | 'cancelled' | 'error';
  statusText: string;
  activeSessionId: string | null;
  inspection: MotionInspectionResult | null;
  spec: MotionSpec | null;
  exports: GeneratedMotionExports | null;
}

export interface OverlayMotionDrawerHandlers {
  onPickTarget: () => void;
  onInspect: (selector?: string) => Promise<void>;
  onStartObservation: (
    trigger: MotionTriggerType,
    durationMs: number,
    selector?: string,
  ) => Promise<void>;
  onStopObservation: () => Promise<void>;
  onCancelObservation: () => Promise<void>;
  onOpenFullMotionLab: () => void;
  onCopyText: (text: string, label: string) => void;
  onDownloadText: (filename: string, mime: string, text: string) => void;
  onClose: () => void;
  onStateChange: () => void;
}

export function renderMotionLabOverlayDrawer(
  doc: Document,
  container: HTMLElement,
  state: OverlayMotionDrawerState,
  handlers: OverlayMotionDrawerHandlers,
): void {
  container.textContent = '';

  const head = doc.createElement('div');
  head.className = 'ps-drawer-head';
  const titleEl = doc.createElement('span');
  titleEl.className = 'ps-drawer-title';
  titleEl.textContent = 'Motion Lab — Temporal Reverse Engineering';
  head.appendChild(titleEl);

  const headBtns = doc.createElement('div');
  headBtns.style.display = 'flex';
  headBtns.style.gap = '6px';
  headBtns.style.flexWrap = 'wrap';

  const pickBtn = doc.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'ps-btn';
  pickBtn.setAttribute('data-ps-motion-action', 'pick-target');
  pickBtn.textContent = 'Pick Element';
  pickBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handlers.onPickTarget();
  });

  const openFullBtn = doc.createElement('button');
  openFullBtn.type = 'button';
  openFullBtn.className = 'ps-btn primary';
  openFullBtn.setAttribute('data-ps-motion-action', 'open-full');
  openFullBtn.textContent = 'Open Full Lab';
  openFullBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handlers.onOpenFullMotionLab();
  });

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ps-btn ghost';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handlers.onClose();
  });

  headBtns.append(pickBtn, openFullBtn, closeBtn);
  head.appendChild(headBtns);
  container.appendChild(head);

  const controls = doc.createElement('div');
  controls.style.display = 'flex';
  controls.style.flexWrap = 'wrap';
  controls.style.alignItems = 'center';
  controls.style.gap = '8px';
  controls.style.marginBottom = '10px';

  const targetTag = doc.createElement('span');
  targetTag.className = 'ps-tag accent';
  targetTag.textContent = `Target: ${state.targetSelector}`;
  controls.appendChild(targetTag);

  const triggerSel = doc.createElement('select');
  triggerSel.className = 'ps-field';
  triggerSel.style.width = 'auto';
  triggerSel.setAttribute('data-ps-motion-trigger', 'true');
  const triggers: Array<[MotionTriggerType, string]> = [
    ['hover', 'Hover / Pointer'],
    ['click', 'Click'],
    ['scroll', 'Scroll'],
    ['load', 'Load / Entrance'],
    ['drag', 'Drag'],
    ['manual', 'Manual Interaction'],
  ];
  for (const [val, label] of triggers) {
    const opt = doc.createElement('option');
    opt.value = val;
    opt.textContent = label;
    opt.selected = state.trigger === val;
    triggerSel.appendChild(opt);
  }
  triggerSel.addEventListener('change', () => {
    state.trigger = triggerSel.value as MotionTriggerType;
  });
  controls.appendChild(triggerSel);

  const durSel = doc.createElement('select');
  durSel.className = 'ps-field';
  durSel.style.width = 'auto';
  durSel.setAttribute('data-ps-motion-duration', 'true');
  for (const ms of [1500, 3000, 5000, 8000]) {
    const opt = doc.createElement('option');
    opt.value = String(ms);
    opt.textContent = `${(ms / 1000).toFixed(1)}s window`;
    opt.selected = state.durationMs === ms;
    durSel.appendChild(opt);
  }
  durSel.addEventListener('change', () => {
    state.durationMs = Number(durSel.value) || 3000;
  });
  controls.appendChild(durSel);

  const inspectBtn = doc.createElement('button');
  inspectBtn.type = 'button';
  inspectBtn.className = 'ps-btn';
  inspectBtn.setAttribute('data-ps-motion-action', 'inspect');
  inspectBtn.textContent = 'Inspect Declared';
  inspectBtn.disabled = state.status === 'observing';
  inspectBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void handlers.onInspect(state.targetSelector);
  });
  controls.appendChild(inspectBtn);

  if (state.status !== 'observing') {
    const startBtn = doc.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'ps-btn primary';
    startBtn.setAttribute('data-ps-motion-action', 'start');
    startBtn.textContent = 'Start Observation';
    startBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void handlers.onStartObservation(state.trigger, state.durationMs, state.targetSelector);
    });
    controls.appendChild(startBtn);
  } else {
    const stopBtn = doc.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'ps-btn primary';
    stopBtn.setAttribute('data-ps-motion-action', 'stop');
    stopBtn.textContent = 'Finish & Analyze';
    stopBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void handlers.onStopObservation();
    });

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ps-btn ghost';
    cancelBtn.setAttribute('data-ps-motion-action', 'cancel');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void handlers.onCancelObservation();
    });
    controls.append(stopBtn, cancelBtn);
  }

  container.appendChild(controls);

  const statusLine = doc.createElement('div');
  statusLine.style.fontSize = '12px';
  statusLine.style.color = state.status === 'error' ? '#f87171' : 'var(--ps-muted, #94a3b8)';
  statusLine.style.marginBottom = '10px';
  statusLine.textContent = state.statusText;
  container.appendChild(statusLine);

  if (state.inspection && !state.spec) {
    const insBox = doc.createElement('div');
    insBox.className = 'ps-stack-grid';
    const summaryCard = doc.createElement('div');
    summaryCard.className = 'ps-kv-card';
    summaryCard.textContent = `Declared scan: ${state.inspection.declaredAnimations.length} animation(s)/transition(s), ${state.inspection.targets.length} target(s), ${state.inspection.canvases.length} canvas element(s), ${state.inspection.unavailableItems.length} unavailable/cross-origin note(s).`;
    insBox.appendChild(summaryCard);
    for (const dec of state.inspection.declaredAnimations.slice(0, 6)) {
      const row = doc.createElement('div');
      row.className = 'ps-site-row';
      row.textContent = `[Declared · ${dec.kind}] ${dec.selector} (${dec.name || dec.propertyHint}) — ${Math.round(dec.durationMs ?? 0)}ms · ${dec.easing}`;
      insBox.appendChild(row);
    }
    container.appendChild(insBox);
  }

  if (state.spec) {
    const counts = summarizeMotionSpecCounts(state.spec);
    const pills = doc.createElement('div');
    pills.style.display = 'flex';
    pills.style.flexWrap = 'wrap';
    pills.style.gap = '6px';
    pills.style.marginBottom = '10px';
    for (const [label, count] of [
      ['Declared', counts.declaredCount],
      ['Observed', counts.observedCount],
      ['Inferred', counts.inferredCount],
      ['Unavailable', counts.unavailableCount],
      ['Replayable', counts.replayableCount],
    ] as const) {
      const tag = doc.createElement('span');
      tag.className = 'ps-tag';
      tag.textContent = `${label}: ${count}`;
      pills.appendChild(tag);
    }
    container.appendChild(pills);

    const trackList = doc.createElement('div');
    trackList.className = 'ps-site-list';
    if (state.spec.tracks.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'ps-site-row';
      empty.textContent =
        'No motion tracks changed during this observation window. Interact with the target (hover/click/scroll) during observation or pick another element.';
      trackList.appendChild(empty);
    } else {
      for (const track of state.spec.tracks.slice(0, 8)) {
        const row = doc.createElement('div');
        row.className = 'ps-site-row';
        const domainStr =
          track.timelineDomain === 'scroll_progress_percent' ||
          track.timelineDomain === 'view_progress_percent'
            ? `scroll ${Math.round(track.progressStartPct ?? 0)}%–${Math.round(track.progressEndPct ?? 100)}%`
            : `${Math.round(track.durationMs ?? 0)}ms (delay ${Math.round(track.delayMs ?? 0)}ms)`;
        const easing =
          track.declaredEasing ??
          (track.inferredEasings[0]
            ? `${track.inferredEasings[0].name} (inferred · ${track.inferredEasings[0].confidence})`
            : 'linear');
        row.textContent = `[${track.evidenceClass} · ${track.category}] ${track.selector} · ${track.property}: ${domainStr} · ${easing}`;
        trackList.appendChild(row);
      }
    }
    container.appendChild(trackList);

    if (state.exports) {
      const exportRow = doc.createElement('div');
      exportRow.style.display = 'flex';
      exportRow.style.flexWrap = 'wrap';
      exportRow.style.gap = '6px';
      exportRow.style.marginTop = '10px';

      const actions: Array<[string, () => void]> = [
        [
          'Copy CSS',
          () => {
            handlers.onCopyText(state.exports?.cssCode ?? '', 'CSS Keyframes');
          },
        ],
        [
          'Copy WAAPI',
          () => {
            handlers.onCopyText(state.exports?.waapiCode ?? '', 'WAAPI Snippet');
          },
        ],
        [
          'Copy MOTION.md',
          () => {
            handlers.onCopyText(state.exports?.motionMd ?? '', 'MOTION.md');
          },
        ],
        [
          'Download JSON',
          () => {
            handlers.onDownloadText(
              'pagesift-motion-spec.json',
              'application/json;charset=utf-8',
              JSON.stringify(state.spec, null, 2),
            );
          },
        ],
      ];
      for (const [label, fn] of actions) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ps-btn';
        btn.textContent = label;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          fn();
        });
        exportRow.appendChild(btn);
      }
      container.appendChild(exportRow);
    }
  }
}
