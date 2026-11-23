import {
  buildLabeledContactSheetHtml,
  compareMotionSpecs,
  type MotionComparisonReport,
} from '../engines/motion-compare-engine.js';
import {
  generateMotionExports,
  type GeneratedMotionExports,
} from '../engines/motion-codegen-engine.js';
import {
  buildReanimateHandoffRecipe,
  importReanimateJsonText,
  importReanimateZipBytes,
  validateImportedMediaDescriptor,
} from '../engines/motion-import-engine.js';
import type { MotionInspectionResult } from '../engines/motion-observation-engine.js';
import { MotionVisualRecorder, type VisualRecordingResult } from '../engines/motion-recorder.js';
import {
  MOTION_CAPABILITY_MATRIX,
  summarizeMotionSpecCounts,
  type MotionSpec,
  type MotionTrack,
  type MotionTriggerType,
} from '../engines/motion-spec.js';

export interface MotionLabPanelCallbacks {
  onInspect: (selector?: string) => Promise<{
    targetSelector: string;
    inspection: MotionInspectionResult;
  }>;
  onStartObservation: (opts: {
    selector?: string;
    trigger: MotionTriggerType;
    durationMs: number;
  }) => Promise<{
    sessionId: string;
    targetSelector: string;
    inspection: MotionInspectionResult;
  }>;
  onStopObservation: () => Promise<{
    spec: MotionSpec;
    exports: GeneratedMotionExports;
  }>;
  onCancelObservation: () => Promise<void>;
  onSaveSpecArtifact: (spec: MotionSpec, title: string) => Promise<void>;
  onSaveRecordedMedia?: (sessionId: string, result: VisualRecordingResult) => Promise<void>;
  onCopyText: (text: string, label: string) => void;
  onDownloadFile: (filename: string, mimeType: string, content: string | Uint8Array) => void;
  onStatus: (message: string, variant?: 'neutral' | 'error' | 'success' | 'warning') => void;
  getSelectorInput: () => string | undefined;
}

export interface MotionLabUiState {
  spec: MotionSpec | null;
  exports: GeneratedMotionExports | null;
  inspection: MotionInspectionResult | null;
  comparison: MotionComparisonReport | null;
  recording: VisualRecordingResult | null;
  recordingStatusText: string;
  activeSessionId: string | null;
  trigger: MotionTriggerType;
  durationMs: number;
  exportTab: 'css' | 'waapi' | 'html' | 'md' | 'prompt' | 'json' | 'handoff';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createEvidenceTag(evidenceClass: string): HTMLElement {
  const cls =
    evidenceClass === 'declared'
      ? 'tag positive'
      : evidenceClass === 'observed'
        ? 'tag'
        : evidenceClass === 'inferred'
          ? 'tag warning'
          : 'tag';
  return el('span', cls, evidenceClass.toUpperCase());
}

function buildDemoCandidateSpecFromExports(spec: MotionSpec): MotionSpec {
  const clonedTracks: MotionTrack[] = spec.tracks.map((t) => ({
    ...t,
    trackId: `demo-${t.trackId}`,
  }));
  return {
    ...spec,
    specId: `candidate-${spec.specId}`,
    sourceKind: 'live_observation',
    session: {
      ...spec.session,
      sessionId: `candidate-${spec.session.sessionId}`,
    },
    tracks: clonedTracks,
  };
}

class IsolatedMotionPreviewPlayer {
  private animations: Animation[] = [];
  private totalMs = 1000;
  private playbackRate = 1;
  private reducedMotion = false;
  private readonly stageBox: HTMLElement;
  private readonly tracks: MotionTrack[];

  public constructor(stageBox: HTMLElement, spec: MotionSpec) {
    this.stageBox = stageBox;
    this.tracks = spec.tracks;
    this.totalMs = Math.max(
      400,
      ...spec.tracks
        .filter((t) => t.replaySupported)
        .map((t) => Math.max(0, t.endMs ?? (t.delayMs ?? 0) + (t.durationMs ?? 800))),
    );
    this.rebuild();
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    for (const anim of this.animations) {
      anim.playbackRate = rate;
    }
  }

  public setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.rebuild();
  }

  public play(): void {
    for (const anim of this.animations) {
      anim.playbackRate = this.playbackRate;
      anim.play();
    }
  }

  public pause(): void {
    for (const anim of this.animations) {
      anim.pause();
    }
  }

  public restart(): void {
    for (const anim of this.animations) {
      anim.currentTime = 0;
      anim.playbackRate = this.playbackRate;
      anim.play();
    }
  }

  public scrubProgress(fraction01: number): void {
    const t = Math.max(0, Math.min(1, fraction01)) * this.totalMs;
    for (const anim of this.animations) {
      anim.pause();
      anim.currentTime = t;
    }
  }

  public getTotalMs(): number {
    return this.totalMs;
  }

  public dispose(): void {
    for (const anim of this.animations) {
      try {
        anim.cancel();
      } catch {
        continue;
      }
    }
    this.animations = [];
  }

  private rebuild(): void {
    this.dispose();
    this.stageBox.textContent = '';

    const replayable = this.tracks.filter((t) => t.replaySupported);
    if (replayable.length === 0) {
      this.stageBox.appendChild(
        el(
          'div',
          'empty-state',
          'No replayable CSS/WAAPI/numeric tracks captured yet. Scroll, canvas, or unavailable tracks are listed below.',
        ),
      );
      return;
    }

    const byTarget = new Map<string, MotionTrack[]>();
    for (const t of replayable) {
      const list = byTarget.get(t.selector) ?? [];
      list.push(t);
      byTarget.set(t.selector, list);
    }

    let idx = 0;
    for (const [selector, groupTracks] of byTarget.entries()) {
      idx += 1;
      const box = el('div', 'motion-preview-node');
      box.setAttribute('data-motion-preview-node', selector);
      const label = el('span', 'mono', `#${idx} ${selector.slice(0, 32)}`);
      box.appendChild(label);
      this.stageBox.appendChild(box);

      if (typeof box.animate !== 'function') continue;

      for (const track of groupTracks) {
        const duration = Math.max(120, Math.round(track.durationMs ?? 500));
        const delay = Math.max(0, Math.round(track.delayMs ?? 0));
        const easing =
          track.declaredEasing && !track.declaredEasing.includes('function')
            ? track.declaredEasing
            : (track.inferredEasings[0]?.cssEasing ?? 'ease-out');

        let keyframes: Keyframe[];
        if (this.reducedMotion) {
          keyframes = [{ opacity: 0.45 }, { opacity: 1 }];
        } else if (track.property === 'opacity') {
          const from = typeof track.fromValue === 'number' ? track.fromValue : 0;
          const to = typeof track.toValue === 'number' ? track.toValue : 1;
          keyframes = [{ opacity: from }, { opacity: to }];
        } else if (
          track.property === 'translateX' ||
          track.property === 'translateY' ||
          track.property === 'scaleX' ||
          track.property === 'scaleY' ||
          track.property === 'rotateZ'
        ) {
          const from = typeof track.fromValue === 'number' ? track.fromValue : 0;
          const to = typeof track.toValue === 'number' ? track.toValue : 0;
          const fn = (val: number): string => {
            if (track.property === 'translateX') return `translateX(${val.toFixed(1)}px)`;
            if (track.property === 'translateY') return `translateY(${val.toFixed(1)}px)`;
            if (track.property === 'scaleX') return `scaleX(${val.toFixed(3)})`;
            if (track.property === 'scaleY') return `scaleY(${val.toFixed(3)})`;
            return `rotate(${val.toFixed(1)}deg)`;
          };
          keyframes = [{ transform: fn(from) }, { transform: fn(to) }];
        } else if (track.property === 'transform') {
          const from = typeof track.fromValue === 'string' ? track.fromValue : 'translateY(16px)';
          const to = typeof track.toValue === 'string' ? track.toValue : 'none';
          keyframes = [{ transform: from }, { transform: to }];
        } else {
          keyframes = [{ opacity: 0.5 }, { opacity: 1 }];
        }

        try {
          const anim = box.animate(keyframes, {
            duration,
            delay,
            easing,
            fill: 'both',
            iterations: track.iterations === 'infinite' ? Infinity : 1,
          });
          anim.playbackRate = this.playbackRate;
          anim.pause();
          this.animations.push(anim);
        } catch {
          continue;
        }
      }
    }
  }
}

export function renderMotionLabPanel(
  container: HTMLElement,
  initialData: Record<string, unknown>,
  callbacks: MotionLabPanelCallbacks,
): () => void {
  const state: MotionLabUiState = {
    spec: (initialData['spec'] as MotionSpec | undefined) ?? null,
    exports: (initialData['exports'] as GeneratedMotionExports | undefined) ?? null,
    inspection: (initialData['inspection'] as MotionInspectionResult | undefined) ?? null,
    comparison: null,
    recording: null,
    recordingStatusText:
      'Visual screen/tab recording is optional and opt-in (audio always disabled).',
    activeSessionId: null,
    trigger: 'hover',
    durationMs: 3000,
    exportTab: 'css',
  };

  if (state.spec && !state.exports) {
    state.exports = generateMotionExports(state.spec);
  }
  if (state.spec) {
    state.comparison = compareMotionSpecs(state.spec, null);
  }

  let player: IsolatedMotionPreviewPlayer | null = null;
  let recorder: MotionVisualRecorder | null = null;

  const cleanup = (): void => {
    player?.dispose();
    player = null;
    recorder?.dispose();
    recorder = null;
  };

  const render = (): void => {
    player?.dispose();
    player = null;
    container.textContent = '';

    const root = el('div', 'motion-lab-root');

    const controlsCard = el('article', 'flat-block');
    controlsCard
      .appendChild(el('div', 'block-heading'))
      .appendChild(
        el('h3', undefined, '1. Observation, Optional Video Capture & Reanimate Import'),
      );

    const row1 = el('div', 'control-row');
    const triggerSel = document.createElement('select');
    triggerSel.id = 'motion-trigger-select';
    triggerSel.setAttribute('aria-label', 'Motion trigger type');
    for (const [val, lbl] of [
      ['hover', 'Hover / Pointer'],
      ['click', 'Click'],
      ['scroll', 'Scroll'],
      ['load', 'Load / Entrance'],
      ['drag', 'Drag'],
      ['manual', 'Manual'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      opt.selected = state.trigger === val;
      triggerSel.appendChild(opt);
    }
    triggerSel.addEventListener('change', () => {
      state.trigger = triggerSel.value as MotionTriggerType;
    });

    const durSel = document.createElement('select');
    durSel.id = 'motion-duration-select';
    durSel.setAttribute('aria-label', 'Observation duration');
    for (const ms of [1500, 3000, 5000, 8000]) {
      const opt = document.createElement('option');
      opt.value = String(ms);
      opt.textContent = `${(ms / 1000).toFixed(1)}s window`;
      opt.selected = state.durationMs === ms;
      durSel.appendChild(opt);
    }
    durSel.addEventListener('change', () => {
      state.durationMs = Number(durSel.value) || 3000;
    });

    const inspectBtn = el('button', 'secondary sm', 'Inspect Declared');
    inspectBtn.type = 'button';
    inspectBtn.id = 'motion-inspect-btn';
    inspectBtn.disabled = state.activeSessionId !== null;
    inspectBtn.addEventListener('click', () => {
      void callbacks
        .onInspect(callbacks.getSelectorInput())
        .then((res) => {
          state.inspection = res.inspection;
          callbacks.onStatus(
            `Inspected ${res.targetSelector}: ${res.inspection.declaredAnimations.length} declared animation(s).`,
            'success',
          );
          render();
        })
        .catch((err: unknown) => {
          callbacks.onStatus(
            `Error: ${err instanceof Error ? err.message : 'Inspect failed'}`,
            'error',
          );
        });
    });

    row1.append(triggerSel, durSel, inspectBtn);

    if (state.activeSessionId === null) {
      const startBtn = el('button', 'sm', 'Start Observation');
      startBtn.type = 'button';
      startBtn.id = 'motion-start-btn';
      startBtn.addEventListener('click', () => {
        const selectorVal = callbacks.getSelectorInput();
        void callbacks
          .onStartObservation({
            ...(selectorVal ? { selector: selectorVal } : {}),
            trigger: state.trigger,
            durationMs: state.durationMs,
          })
          .then((started) => {
            state.activeSessionId = started.sessionId;
            state.inspection = started.inspection;
            callbacks.onStatus(
              `Observing "${state.trigger}" on ${started.targetSelector} — interact on the page now, then click Finish & Analyze.`,
              'neutral',
            );
            render();
          })
          .catch((err: unknown) => {
            callbacks.onStatus(
              `Error: ${err instanceof Error ? err.message : 'Failed to start observation'}`,
              'error',
            );
          });
      });
      row1.appendChild(startBtn);
    } else {
      const stopBtn = el('button', 'sm', 'Finish & Analyze');
      stopBtn.type = 'button';
      stopBtn.id = 'motion-stop-btn';
      stopBtn.addEventListener('click', () => {
        void callbacks
          .onStopObservation()
          .then((res) => {
            state.activeSessionId = null;
            state.spec = res.spec;
            state.exports = res.exports;
            state.comparison = compareMotionSpecs(res.spec, null);
            callbacks.onStatus(
              `Captured ${res.spec.tracks.length} track(s) in ${Math.round(res.spec.session.observedDurationMs)} ms.`,
              'success',
            );
            render();
          })
          .catch((err: unknown) => {
            state.activeSessionId = null;
            callbacks.onStatus(
              `Error: ${err instanceof Error ? err.message : 'Stop failed'}`,
              'error',
            );
            render();
          });
      });

      const cancelBtn = el('button', 'danger sm', 'Cancel Observation');
      cancelBtn.type = 'button';
      cancelBtn.id = 'motion-cancel-btn';
      cancelBtn.addEventListener('click', () => {
        void callbacks.onCancelObservation().finally(() => {
          state.activeSessionId = null;
          callbacks.onStatus('Motion observation cancelled cleanly.', 'warning');
          render();
        });
      });
      row1.append(stopBtn, cancelBtn);
    }

    const recordBtn = el(
      'button',
      'secondary sm',
      recorder ? 'Stop Video Recording' : 'Record Visual Evidence (Opt-In)',
    );
    recordBtn.type = 'button';
    recordBtn.id = 'motion-record-video-btn';
    recordBtn.addEventListener('click', () => {
      if (recorder) {
        const activeRec = recorder;
        recorder = null;
        void activeRec.stop('recorded').then(async (res) => {
          state.recording = res;
          state.recordingStatusText = `${res.status}: ${res.message} (${res.frameTimestampsMs.length} frame timestamps, ${res.sampledFrames.length} posters)`;
          if (state.spec && res.status === 'recorded') {
            state.spec = {
              ...state.spec,
              session: {
                ...state.spec.session,
                visualRecordingStatus: 'recorded',
                visualFrameCount: res.frameTimestampsMs.length,
              },
            };
            await callbacks
              .onSaveRecordedMedia?.(state.spec.session.sessionId, res)
              .catch(() => {});
          }
          render();
        });
        return;
      }

      const nextRec = new MotionVisualRecorder();
      void nextRec
        .start({
          maxDurationMs: state.durationMs,
          cropRect: state.spec?.targets[0]?.initialBox ?? null,
          devicePixelRatio: window.devicePixelRatio || 1,
        })
        .then((startRes) => {
          if (!startRes.started) {
            nextRec.dispose();
            state.recordingStatusText = `${startRes.status}: ${startRes.message}`;
            if (state.spec) {
              state.spec = {
                ...state.spec,
                session: {
                  ...state.spec.session,
                  visualRecordingStatus:
                    startRes.status === 'permission_denied' || startRes.status === 'unsupported'
                      ? startRes.status
                      : 'failed',
                },
              };
            }
            callbacks.onStatus(startRes.message, 'warning');
            render();
            return;
          }
          recorder = nextRec;
          state.recordingStatusText = startRes.message;
          render();
        });
    });
    row1.appendChild(recordBtn);

    const importLabel = el('label', 'btn-link sm', 'Import Reanimate ZIP / JSON');
    importLabel.setAttribute('for', 'motion-import-file');
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.id = 'motion-import-file';
    importInput.accept = '.zip,.json,.png,.jpg,.jpeg,.webp,.webm';
    importInput.style.display = 'none';
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      if (!file) return;
      void file.arrayBuffer().then((buf) => {
        try {
          const lower = file.name.toLowerCase();
          if (lower.endsWith('.zip')) {
            const imported = importReanimateZipBytes(new Uint8Array(buf));
            state.spec = imported.spec;
            state.exports = generateMotionExports(imported.spec);
            state.comparison = compareMotionSpecs(imported.spec, null);
            callbacks.onStatus(
              `Imported ${imported.spec.tracks.length} track(s) from ${file.name}${imported.warnings.length > 0 ? ` (${imported.warnings.length} warning(s))` : ''}.`,
              'success',
            );
          } else if (lower.endsWith('.json')) {
            const text = new TextDecoder().decode(new Uint8Array(buf));
            const imported = importReanimateJsonText(text, file.name);
            state.spec = imported.spec;
            state.exports = generateMotionExports(imported.spec);
            state.comparison = compareMotionSpecs(imported.spec, null);
            callbacks.onStatus(
              `Imported ${imported.spec.tracks.length} track(s) from ${file.name}.`,
              'success',
            );
          } else {
            const check = validateImportedMediaDescriptor({
              filename: file.name,
              mimeType: file.type || 'application/octet-stream',
              byteLength: file.size,
            });
            if (!check.valid) {
              throw new Error(check.reason ?? 'Unsupported media file.');
            }
            callbacks.onStatus(`Validated local visual evidence file "${file.name}".`, 'success');
          }
          render();
        } catch (err: unknown) {
          callbacks.onStatus(err instanceof Error ? err.message : 'Import failed', 'error');
        }
      });
    });
    row1.append(importLabel, importInput);
    controlsCard.appendChild(row1);
    controlsCard.appendChild(el('div', 'muted motion-subnote', state.recordingStatusText));
    root.appendChild(controlsCard);

    if (state.inspection && !state.spec) {
      const insCard = el('article', 'flat-block');
      insCard.appendChild(
        el(
          'h3',
          undefined,
          `Declared Animations Pre-Observation (${state.inspection.declaredAnimations.length})`,
        ),
      );
      if (state.inspection.declaredAnimations.length === 0) {
        insCard.appendChild(
          el(
            'div',
            'muted',
            'No running CSS/WAAPI animations detected at rest. Start observation and trigger hover/click/scroll on the target.',
          ),
        );
      } else {
        for (const d of state.inspection.declaredAnimations.slice(0, 12)) {
          const row = el('div', 'motion-track-row');
          row.appendChild(createEvidenceTag('declared'));
          row.appendChild(
            el(
              'span',
              'mono',
              `${d.kind} · ${d.selector} · ${d.name || d.propertyHint} (${Math.round(d.durationMs ?? 0)}ms, ${d.easing})`,
            ),
          );
          insCard.appendChild(row);
        }
      }
      root.appendChild(insCard);
    }

    if (state.spec) {
      const spec = state.spec;
      const counts = summarizeMotionSpecCounts(spec);

      const summaryCard = el('article', 'flat-block');
      const head = el('div', 'block-heading');
      head.appendChild(el('h3', undefined, `2. Motion Specification · ${spec.rootSelector}`));
      const saveSpecBtn = el('button', 'secondary sm', 'Save Session Artifact');
      saveSpecBtn.type = 'button';
      saveSpecBtn.id = 'motion-save-artifact-btn';
      saveSpecBtn.addEventListener('click', () => {
        void callbacks.onSaveSpecArtifact(
          spec,
          `Motion Lab · ${spec.environment.pageTitle || spec.rootSelector}`,
        );
      });
      head.appendChild(saveSpecBtn);
      summaryCard.appendChild(head);

      const badges = el('div', 'control-row');
      for (const [lbl, cnt, cls] of [
        ['Declared', counts.declaredCount, 'tag positive'],
        ['Observed', counts.observedCount, 'tag'],
        ['Inferred', counts.inferredCount, 'tag warning'],
        ['Unavailable', counts.unavailableCount, 'tag'],
        ['Replayable', counts.replayableCount, 'tag positive'],
      ] as const) {
        badges.appendChild(el('span', cls, `${lbl}: ${cnt}`));
      }
      summaryCard.appendChild(badges);
      summaryCard.appendChild(
        el(
          'div',
          'muted motion-subnote',
          `State: ${spec.session.state} · Duration: ${Math.round(spec.session.observedDurationMs)}ms · Samples: ${spec.session.sampleCount}${spec.session.measuredMeanFps ? ` · ~${spec.session.measuredMeanFps.toFixed(1)} fps` : ''} · Viewport: ${spec.environment.viewport.width}x${spec.environment.viewport.height}@${spec.environment.devicePixelRatio}x`,
        ),
      );

      if (spec.session.interruptionReason) {
        summaryCard.appendChild(
          el('div', 'status-line warning', `Interrupted: ${spec.session.interruptionReason}`),
        );
      }

      if (spec.unavailableItems.length > 0) {
        const unavailBox = el('div', 'motion-unavailable-list');
        for (const item of spec.unavailableItems) {
          unavailBox.appendChild(
            el(
              'div',
              'status-line warning',
              `[Unavailable · ${item.category}] ${item.target}: ${item.reason}`,
            ),
          );
        }
        summaryCard.appendChild(unavailBox);
      }

      const totalTimelineMs = Math.max(
        100,
        spec.session.observedDurationMs,
        ...spec.tracks.map((t) => t.endMs ?? (t.delayMs ?? 0) + (t.durationMs ?? 0)),
      );
      const timelineWrap = el('div', 'motion-timeline-wrap');
      for (const track of spec.tracks) {
        const row = el('div', 'motion-track-row');
        row.appendChild(createEvidenceTag(track.evidenceClass));
        const meta = el('span', 'mono motion-track-label', `${track.selector} · ${track.property}`);
        const barBg = el('div', 'motion-bar-bg');
        const barFill = el('div', `motion-bar-fill evidence-${track.evidenceClass}`);
        if (
          track.timelineDomain === 'scroll_progress_percent' ||
          track.timelineDomain === 'view_progress_percent'
        ) {
          const p0 = Math.max(0, Math.min(100, track.progressStartPct ?? 0));
          const p1 = Math.max(p0 + 2, Math.min(100, track.progressEndPct ?? 100));
          barFill.style.left = `${p0}%`;
          barFill.style.width = `${p1 - p0}%`;
        } else {
          const s = Math.max(0, track.startMs ?? 0);
          const e = Math.max(s + 20, track.endMs ?? s + (track.durationMs ?? 300));
          const leftPct = Math.min(95, (s / totalTimelineMs) * 100);
          const widthPct = Math.max(4, Math.min(100 - leftPct, ((e - s) / totalTimelineMs) * 100));
          barFill.style.left = `${leftPct}%`;
          barFill.style.width = `${widthPct}%`;
        }
        barBg.appendChild(barFill);

        const timingDetail =
          track.timelineDomain === 'scroll_progress_percent' ||
          track.timelineDomain === 'view_progress_percent'
            ? `scroll ${Math.round(track.progressStartPct ?? 0)}%..${Math.round(track.progressEndPct ?? 100)}%`
            : `${Math.round(track.durationMs ?? 0)}ms (d:${Math.round(track.delayMs ?? 0)}ms)`;
        const easingDetail =
          track.declaredEasing ??
          (track.inferredEasings[0]
            ? `${track.inferredEasings[0].name} [est · rmse ${track.inferredEasings[0].rmse.toFixed(3)}]`
            : 'linear');

        const info = el(
          'span',
          'muted mono',
          `${timingDetail} · ${easingDetail}${track.staggerFromPrevMs ? ` · +${Math.round(track.staggerFromPrevMs)}ms stagger` : ''}`,
        );
        row.append(meta, barBg, info);
        timelineWrap.appendChild(row);
      }
      summaryCard.appendChild(timelineWrap);
      root.appendChild(summaryCard);

      const previewCard = el('article', 'flat-block');
      previewCard.appendChild(
        el('h3', undefined, '3. Isolated Preview Player (Deterministic Scrubbing)'),
      );
      const previewStage = el('div', 'motion-preview-stage');
      previewStage.id = 'motion-preview-stage';
      previewCard.appendChild(previewStage);

      player = new IsolatedMotionPreviewPlayer(previewStage, spec);

      const playerCtrl = el('div', 'control-row');
      const playBtn = el('button', 'sm', 'Play');
      playBtn.type = 'button';
      playBtn.id = 'motion-preview-play';
      playBtn.addEventListener('click', () => {
        player?.play();
      });

      const pauseBtn = el('button', 'secondary sm', 'Pause');
      pauseBtn.type = 'button';
      pauseBtn.id = 'motion-preview-pause';
      pauseBtn.addEventListener('click', () => {
        player?.pause();
      });

      const restartBtn = el('button', 'secondary sm', 'Restart');
      restartBtn.type = 'button';
      restartBtn.id = 'motion-preview-restart';
      restartBtn.addEventListener('click', () => player?.restart());

      const scrub = document.createElement('input');
      scrub.type = 'range';
      scrub.id = 'motion-preview-scrub';
      scrub.min = '0';
      scrub.max = '1000';
      scrub.value = '0';
      scrub.setAttribute('aria-label', 'Scrub preview timeline');
      const scrubLabel = el('span', 'mono muted', `0 / ${Math.round(player.getTotalMs())}ms`);
      scrub.addEventListener('input', () => {
        const frac = Number(scrub.value) / 1000;
        player?.scrubProgress(frac);
        scrubLabel.textContent = `${Math.round(frac * (player?.getTotalMs() ?? 0))} / ${Math.round(player?.getTotalMs() ?? 0)}ms`;
      });

      const speedSel = document.createElement('select');
      speedSel.setAttribute('aria-label', 'Playback speed');
      for (const spd of [0.25, 0.5, 1, 2]) {
        const opt = document.createElement('option');
        opt.value = String(spd);
        opt.textContent = `${spd}x`;
        opt.selected = spd === 1;
        speedSel.appendChild(opt);
      }
      speedSel.addEventListener('change', () => {
        player?.setPlaybackRate(Number(speedSel.value) || 1);
      });

      const reducedLabel = el('label', 'inline-check');
      const reducedCb = document.createElement('input');
      reducedCb.type = 'checkbox';
      reducedCb.id = 'motion-reduced-motion-toggle';
      reducedCb.addEventListener('change', () => {
        player?.setReducedMotion(reducedCb.checked);
      });
      reducedLabel.append(reducedCb, document.createTextNode('Reduced Motion'));

      playerCtrl.append(playBtn, pauseBtn, restartBtn, scrub, scrubLabel, speedSel, reducedLabel);
      previewCard.appendChild(playerCtrl);

      const nonReplayable = spec.tracks.filter((t) => !t.replaySupported);
      if (nonReplayable.length > 0) {
        const unsupportedMsg = el(
          'div',
          'muted motion-subnote',
          `Non-replayable tracks (${nonReplayable.length}): ${nonReplayable
            .slice(0, 4)
            .map((t) => `${t.property} (${t.unsupportedReason ?? t.category})`)
            .join('; ')}`,
        );
        previewCard.appendChild(unsupportedMsg);
      }
      root.appendChild(previewCard);

      const compareCard = el('article', 'flat-block');
      compareCard.appendChild(el('h3', undefined, '4. Reconstruction Comparison & Contact Sheet'));
      const cmpRow = el('div', 'control-row');
      const verifySelfBtn = el('button', 'secondary sm', 'Verify Export Spec Parity');
      verifySelfBtn.type = 'button';
      verifySelfBtn.id = 'motion-compare-parity-btn';
      verifySelfBtn.addEventListener('click', () => {
        const candidate = buildDemoCandidateSpecFromExports(spec);
        state.comparison = compareMotionSpecs(spec, candidate);
        render();
      });

      const uploadCmpLabel = el('label', 'btn-link sm', 'Compare Imported Candidate JSON');
      uploadCmpLabel.setAttribute('for', 'motion-compare-json-input');
      const uploadCmpInput = document.createElement('input');
      uploadCmpInput.type = 'file';
      uploadCmpInput.id = 'motion-compare-json-input';
      uploadCmpInput.accept = '.json';
      uploadCmpInput.style.display = 'none';
      uploadCmpInput.addEventListener('change', () => {
        const file = uploadCmpInput.files?.[0];
        if (!file) return;
        void file.text().then((txt) => {
          try {
            const imported = importReanimateJsonText(txt, file.name);
            state.comparison = compareMotionSpecs(spec, imported.spec);
            render();
          } catch (err: unknown) {
            callbacks.onStatus(
              err instanceof Error ? err.message : 'Candidate import failed',
              'error',
            );
          }
        });
      });

      const dlSheetBtn = el('button', 'secondary sm', 'Download Contact Sheet HTML');
      dlSheetBtn.type = 'button';
      dlSheetBtn.addEventListener('click', () => {
        const report = state.comparison ?? compareMotionSpecs(spec, null);
        const html = buildLabeledContactSheetHtml(report, spec.rootSelector);
        callbacks.onDownloadFile(
          'pagesift-motion-contact-sheet.html',
          'text/html;charset=utf-8',
          html,
        );
      });

      cmpRow.append(verifySelfBtn, uploadCmpLabel, uploadCmpInput, dlSheetBtn);
      compareCard.appendChild(cmpRow);

      const cmp = state.comparison ?? compareMotionSpecs(spec, null);
      const cmpStatus = el(
        'div',
        cmp.status === 'matched'
          ? 'status-line success'
          : cmp.status === 'not_compared'
            ? 'status-line'
            : 'status-line warning',
        `Comparison Status: ${cmp.status} · Setup Compatible: ${cmp.compatible ? 'Yes' : 'No'}${cmp.maxTimingErrorMs !== null ? ` · Max Timing Error: ${Math.round(cmp.maxTimingErrorMs)}ms` : ''}${cmp.maxValueRmse !== null ? ` · Max Value RMSE: ${cmp.maxValueRmse.toFixed(3)}` : ''}`,
      );
      compareCard.appendChild(cmpStatus);
      for (const note of [...cmp.compatibilityMismatches, ...cmp.notes].slice(0, 6)) {
        compareCard.appendChild(el('div', 'muted motion-subnote', note));
      }
      root.appendChild(compareCard);

      if (state.exports) {
        const exp = state.exports;
        const handoff = buildReanimateHandoffRecipe(spec);
        const expCard = el('article', 'flat-block');
        expCard.appendChild(el('h3', undefined, '5. Reusable Code Exports & Reanimate Handoff'));

        const tabRow = el('div', 'control-row');
        const exportMap: Record<
          MotionLabUiState['exportTab'],
          { label: string; filename: string; mime: string; content: string }
        > = {
          css: {
            label: 'CSS',
            filename: 'motion.css',
            mime: 'text/css;charset=utf-8',
            content: exp.cssCode,
          },
          waapi: {
            label: 'WAAPI JS',
            filename: 'motion-waapi.js',
            mime: 'text/javascript;charset=utf-8',
            content: exp.waapiCode,
          },
          html: {
            label: 'HTML Demo',
            filename: 'motion-demo.html',
            mime: 'text/html;charset=utf-8',
            content: exp.htmlDemo,
          },
          md: {
            label: 'MOTION.md',
            filename: 'MOTION.md',
            mime: 'text/markdown;charset=utf-8',
            content: exp.motionMd,
          },
          prompt: {
            label: 'AI Prompt',
            filename: 'motion-prompt.md',
            mime: 'text/markdown;charset=utf-8',
            content: exp.reconstructionPrompt,
          },
          json: {
            label: 'Spec JSON',
            filename: 'motion-spec.json',
            mime: 'application/json;charset=utf-8',
            content: JSON.stringify(spec, null, 2),
          },
          handoff: {
            label: 'Reanimate CLI Handoff',
            filename: 'reanimate-capture-config.json',
            mime: 'application/json;charset=utf-8',
            content: `${handoff.explanation}\n\nCLI Command:\n${handoff.cliCommand}\n\ncapture-config.json:\n${handoff.captureConfigJson}`,
          },
        };

        for (const [key, item] of Object.entries(exportMap)) {
          const btn = el('button', key === state.exportTab ? 'sm' : 'secondary sm', item.label);
          btn.type = 'button';
          btn.addEventListener('click', () => {
            state.exportTab = key as MotionLabUiState['exportTab'];
            render();
          });
          tabRow.appendChild(btn);
        }

        const activeExport = exportMap[state.exportTab];
        const copyExpBtn = el('button', 'secondary sm', 'Copy Active');
        copyExpBtn.type = 'button';
        copyExpBtn.addEventListener('click', () => {
          callbacks.onCopyText(activeExport.content, activeExport.label);
        });
        const dlExpBtn = el('button', 'secondary sm', `Download ${activeExport.filename}`);
        dlExpBtn.type = 'button';
        dlExpBtn.addEventListener('click', () => {
          callbacks.onDownloadFile(activeExport.filename, activeExport.mime, activeExport.content);
        });
        tabRow.append(copyExpBtn, dlExpBtn);

        const pre = el('pre', 'code-box motion-code-preview');
        pre.textContent = activeExport.content;
        expCard.append(tabRow, pre);
        root.appendChild(expCard);
      }
    }

    const capCard = el('article', 'flat-block');
    capCard.appendChild(
      el('h3', undefined, 'Capability Matrix (Declared / Observed / Inferred / Unavailable)'),
    );
    const capTable = document.createElement('table');
    capTable.className = 'data-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Type', 'Status', 'Evidence', 'Captured', 'Known Limitations']) {
      hr.appendChild(el('th', undefined, h));
    }
    thead.appendChild(hr);
    capTable.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const entry of MOTION_CAPABILITY_MATRIX) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', undefined, entry.label));
      tr.appendChild(el('td', undefined, entry.status));
      tr.appendChild(el('td', undefined, entry.evidenceClass));
      tr.appendChild(el('td', undefined, entry.whatIsCaptured));
      tr.appendChild(el('td', undefined, entry.limitations));
      tbody.appendChild(tr);
    }
    capTable.appendChild(tbody);
    capCard.appendChild(capTable);
    root.appendChild(capCard);

    container.appendChild(root);
  };

  render();
  return cleanup;
}
