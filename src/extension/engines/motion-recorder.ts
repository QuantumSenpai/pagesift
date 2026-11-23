export type VisualRecorderMethod = 'tab_capture' | 'display_media' | 'none';

export type VisualRecordingOutcomeStatus =
  | 'recorded'
  | 'permission_denied'
  | 'unsupported'
  | 'cancelled'
  | 'failed';

export interface VisualRecorderCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualRecordingStartOptions {
  targetTabId?: number;
  preferTabCapture?: boolean;
  maxDurationMs?: number;
  fps?: number;
  cropRect?: VisualRecorderCropRect | null;
  devicePixelRatio?: number;
}

export interface VisualSampledFrame {
  tMs: number;
  mimeType: 'image/png' | 'image/webp';
  width: number;
  height: number;
  blob: Blob;
}

export interface VisualRecordingResult {
  status: VisualRecordingOutcomeStatus;
  method: VisualRecorderMethod;
  mimeType: string;
  videoBlob: Blob | null;
  byteLength: number;
  startedAtMs: number;
  stoppedAtMs: number;
  durationMs: number;
  frameTimestampsMs: number[];
  sampledFrames: VisualSampledFrame[];
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  cropRect: VisualRecorderCropRect | null;
  message: string;
}

export const MOTION_RECORDER_MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MOTION_RECORDER_DEFAULT_FPS = 30;
export const MOTION_RECORDER_MAX_SAMPLED_POSTERS = 16;

function chooseSupportedVideoMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'video/webm';
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const mime of candidates) {
    if (
      typeof MediaRecorder.isTypeSupported === 'function' &&
      MediaRecorder.isTypeSupported(mime)
    ) {
      return mime;
    }
  }
  return 'video/webm';
}

function classifyMediaError(err: unknown): VisualRecordingOutcomeStatus {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (
    msg.includes('NotAllowedError') ||
    msg.includes('PermissionDenied') ||
    msg.toLowerCase().includes('denied') ||
    msg.toLowerCase().includes('permission')
  ) {
    return 'permission_denied';
  }
  if (
    msg.includes('AbortError') ||
    msg.toLowerCase().includes('cancelled') ||
    msg.toLowerCase().includes('canceled')
  ) {
    return 'cancelled';
  }
  if (
    msg.includes('NotSupportedError') ||
    msg.toLowerCase().includes('not supported') ||
    msg.toLowerCase().includes('unavailable')
  ) {
    return 'unsupported';
  }
  return 'failed';
}

export function stopAllStreamTracks(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      continue;
    }
  }
}

export class MotionVisualRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private totalBytes = 0;
  private method: VisualRecorderMethod = 'none';
  private mimeType = 'video/webm';
  private startedAtMs = 0;
  private frameTimestampsMs: number[] = [];
  private sampledFrames: VisualSampledFrame[] = [];
  private rafId: number | null = null;
  private autoStopTimerId: number | null = null;
  private stopPromise: Promise<VisualRecordingResult> | null = null;
  private resolveStop: ((res: VisualRecordingResult) => void) | null = null;
  private cropRect: VisualRecorderCropRect | null = null;
  private devicePixelRatio = 1;
  private viewport = { width: 1280, height: 800 };
  private isFinished = false;
  private videoEl: HTMLVideoElement | null = null;

  public async start(options: VisualRecordingStartOptions): Promise<{
    started: boolean;
    status: VisualRecordingOutcomeStatus | 'recording';
    method: VisualRecorderMethod;
    message: string;
  }> {
    this.dispose();
    this.isFinished = false;
    this.chunks = [];
    this.totalBytes = 0;
    this.frameTimestampsMs = [];
    this.sampledFrames = [];
    this.cropRect = options.cropRect ?? null;
    this.devicePixelRatio =
      options.devicePixelRatio ??
      (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    this.viewport = {
      width: typeof window !== 'undefined' ? window.innerWidth : 1280,
      height: typeof window !== 'undefined' ? window.innerHeight : 800,
    };

    if (typeof navigator === 'undefined' || typeof MediaRecorder === 'undefined') {
      return {
        started: false,
        status: 'unsupported',
        method: 'none',
        message: 'MediaDevices or MediaRecorder API is unavailable in this browser context.',
      };
    }

    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
    if (!mediaDevices) {
      return {
        started: false,
        status: 'unsupported',
        method: 'none',
        message: 'MediaDevices API is unavailable in this browser context.',
      };
    }

    let acquiredStream: MediaStream | null = null;
    let chosenMethod: VisualRecorderMethod = 'none';

    const chromeRef = (
      globalThis as unknown as {
        chrome?: {
          tabCapture?: {
            getMediaStreamId?: (opts: { targetTabId: number }) => Promise<string>;
          };
          permissions?: {
            contains?: (q: { permissions: string[] }) => Promise<boolean>;
            request?: (q: { permissions: string[] }) => Promise<boolean>;
          };
        };
      }
    ).chrome;

    if (options.preferTabCapture && typeof options.targetTabId === 'number' && chromeRef) {
      try {
        const permGranted = await this.requestOptionalTabCapturePermission();
        if (!permGranted) {
          return {
            started: false,
            status: 'permission_denied',
            method: 'tab_capture',
            message: 'Optional "tabCapture" permission was declined by the user.',
          };
        }
        const tabCapApi = chromeRef.tabCapture;
        if (tabCapApi?.getMediaStreamId) {
          const streamId = await tabCapApi.getMediaStreamId({ targetTabId: options.targetTabId });
          const constraints: MediaStreamConstraints = {
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
              },
            } as unknown as MediaTrackConstraints,
          };
          acquiredStream = await mediaDevices.getUserMedia(constraints);
          chosenMethod = 'tab_capture';
        }
      } catch (err) {
        const status = classifyMediaError(err);
        if (status === 'permission_denied') {
          return {
            started: false,
            status,
            method: 'tab_capture',
            message: err instanceof Error ? err.message : 'Tab capture permission was denied.',
          };
        }
      }
    }

    if (!acquiredStream && typeof mediaDevices.getDisplayMedia === 'function') {
      try {
        acquiredStream = await mediaDevices.getDisplayMedia({
          audio: false,
          video: {
            frameRate: {
              ideal: options.fps ?? MOTION_RECORDER_DEFAULT_FPS,
              max: 60,
            },
          },
        });
        chosenMethod = 'display_media';
      } catch (err) {
        const status = classifyMediaError(err);
        return {
          started: false,
          status,
          method: 'display_media',
          message:
            status === 'permission_denied' || status === 'cancelled'
              ? 'Screen/tab recording permission was denied or cancelled by the user.'
              : err instanceof Error
                ? err.message
                : 'Display capture failed.',
        };
      }
    }

    if (!acquiredStream) {
      return {
        started: false,
        status: 'unsupported',
        method: 'none',
        message:
          'Visual capture requires tabCapture or getDisplayMedia support in an extension page.',
      };
    }

    for (const audioTrack of acquiredStream.getAudioTracks()) {
      audioTrack.stop();
      acquiredStream.removeTrack(audioTrack);
    }

    this.stream = acquiredStream;
    this.method = chosenMethod;
    this.mimeType = chooseSupportedVideoMimeType();
    this.startedAtMs = performance.now();

    try {
      this.recorder = new MediaRecorder(acquiredStream, {
        mimeType: this.mimeType,
        videoBitsPerSecond: 2_500_000,
      });
    } catch {
      this.recorder = new MediaRecorder(acquiredStream);
      this.mimeType = this.recorder.mimeType || 'video/webm';
    }

    this.stopPromise = new Promise<VisualRecordingResult>((resolve) => {
      this.resolveStop = resolve;
    });

    this.recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) {
        if (this.totalBytes + ev.data.size <= MOTION_RECORDER_MAX_VIDEO_BYTES) {
          this.chunks.push(ev.data);
          this.totalBytes += ev.data.size;
        }
      }
    };

    this.recorder.onstop = () => {
      this.finalizeResult('recorded', 'Visual recording completed locally with zero audio tracks.');
    };

    this.recorder.onerror = () => {
      this.finalizeResult('failed', 'MediaRecorder encountered an error during recording.');
    };

    const videoTrack = acquiredStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => {
        if (!this.isFinished) {
          void this.stop('cancelled');
        }
      });
    }

    this.startFrameSampling(acquiredStream);
    this.recorder.start(250);

    const maxDurationMs = Math.min(15000, Math.max(500, options.maxDurationMs ?? 5000));
    this.autoStopTimerId = globalThis.setTimeout(() => {
      void this.stop('recorded');
    }, maxDurationMs) as unknown as number;

    return {
      started: true,
      status: 'recording',
      method: this.method,
      message: `Recording local visual evidence via ${this.method === 'tab_capture' ? 'tabCapture' : 'getDisplayMedia'} (audio disabled).`,
    };
  }

  public async stop(
    reason: VisualRecordingOutcomeStatus = 'recorded',
  ): Promise<VisualRecordingResult> {
    if (this.isFinished && this.stopPromise) {
      return this.stopPromise;
    }

    this.clearTimers();

    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        if (reason !== 'recorded') {
          this.recorder.onstop = () => {
            this.finalizeResult(reason, 'Visual recording stopped.');
          };
        }
        this.recorder.stop();
      } catch {
        this.finalizeResult(reason, 'Visual recording terminated.');
      }
    } else {
      this.finalizeResult(reason, 'Visual recording stopped cleanly.');
    }

    if (this.stopPromise) {
      return this.stopPromise;
    }

    return {
      status: reason,
      method: this.method,
      mimeType: this.mimeType,
      videoBlob: null,
      byteLength: 0,
      startedAtMs: this.startedAtMs,
      stoppedAtMs: performance.now(),
      durationMs: Math.max(0, performance.now() - this.startedAtMs),
      frameTimestampsMs: [...this.frameTimestampsMs],
      sampledFrames: [...this.sampledFrames],
      viewport: this.viewport,
      devicePixelRatio: this.devicePixelRatio,
      cropRect: this.cropRect,
      message: 'No active recording.',
    };
  }

  public dispose(): void {
    this.clearTimers();
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        this.recorder = null;
      }
    }
    this.recorder = null;
    stopAllStreamTracks(this.stream);
    this.stream = null;
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }
  }

  private async requestOptionalTabCapturePermission(): Promise<boolean> {
    const perms = (
      globalThis as unknown as {
        chrome?: {
          permissions?: {
            contains?: (q: { permissions: string[] }) => Promise<boolean>;
            request?: (q: { permissions: string[] }) => Promise<boolean>;
          };
        };
      }
    ).chrome?.permissions;
    if (!perms?.contains || !perms.request) return false;
    const already = await perms.contains({ permissions: ['tabCapture'] });
    if (already) return true;
    return perms.request({ permissions: ['tabCapture'] });
  }

  private startFrameSampling(stream: MediaStream): void {
    if (typeof document === 'undefined') return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.videoEl = video;
    void video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let lastPosterAt = -1000;

    const sampleLoop = () => {
      if (this.isFinished || !this.stream) return;
      const elapsed = performance.now() - this.startedAtMs;
      this.frameTimestampsMs.push(elapsed);

      if (
        ctx &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        this.sampledFrames.length < MOTION_RECORDER_MAX_SAMPLED_POSTERS &&
        elapsed - lastPosterAt >= 200
      ) {
        lastPosterAt = elapsed;
        const sx = this.cropRect
          ? Math.max(
              0,
              Math.min(video.videoWidth - 1, Math.round(this.cropRect.x * this.devicePixelRatio)),
            )
          : 0;
        const sy = this.cropRect
          ? Math.max(
              0,
              Math.min(video.videoHeight - 1, Math.round(this.cropRect.y * this.devicePixelRatio)),
            )
          : 0;
        const sw = this.cropRect
          ? Math.max(
              1,
              Math.min(
                video.videoWidth - sx,
                Math.round(this.cropRect.width * this.devicePixelRatio),
              ),
            )
          : video.videoWidth;
        const sh = this.cropRect
          ? Math.max(
              1,
              Math.min(
                video.videoHeight - sy,
                Math.round(this.cropRect.height * this.devicePixelRatio),
              ),
            )
          : video.videoHeight;

        const targetW = Math.min(480, sw);
        const targetH = Math.max(1, Math.round((sh * targetW) / Math.max(1, sw)));
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
        const capturedT = elapsed;
        canvas.toBlob(
          (blob) => {
            if (
              blob &&
              !this.isFinished &&
              this.sampledFrames.length < MOTION_RECORDER_MAX_SAMPLED_POSTERS
            ) {
              this.sampledFrames.push({
                tMs: capturedT,
                mimeType: 'image/webp',
                width: targetW,
                height: targetH,
                blob,
              });
            }
          },
          'image/webp',
          0.8,
        );
      }

      if (typeof requestAnimationFrame === 'function') {
        this.rafId = requestAnimationFrame(sampleLoop);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(sampleLoop);
    }
  }

  private clearTimers(): void {
    if (this.autoStopTimerId !== null) {
      globalThis.clearTimeout(this.autoStopTimerId);
      this.autoStopTimerId = null;
    }
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private finalizeResult(status: VisualRecordingOutcomeStatus, message: string): void {
    if (this.isFinished) return;
    this.isFinished = true;
    this.clearTimers();
    stopAllStreamTracks(this.stream);
    this.stream = null;
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }
    const stoppedAtMs = performance.now();
    const videoBlob =
      this.chunks.length > 0 ? new Blob(this.chunks, { type: this.mimeType }) : null;
    this.chunks = [];
    this.resolveStop?.({
      status,
      method: this.method,
      mimeType: this.mimeType,
      videoBlob,
      byteLength: videoBlob ? videoBlob.size : 0,
      startedAtMs: this.startedAtMs,
      stoppedAtMs,
      durationMs: Math.max(0, stoppedAtMs - this.startedAtMs),
      frameTimestampsMs: [...this.frameTimestampsMs],
      sampledFrames: [...this.sampledFrames],
      viewport: this.viewport,
      devicePixelRatio: this.devicePixelRatio,
      cropRect: this.cropRect,
      message,
    });
  }
}
