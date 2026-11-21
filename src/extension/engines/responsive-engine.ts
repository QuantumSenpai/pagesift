export interface ResponsiveViewportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  category: 'mobile' | 'tablet' | 'laptop' | 'desktop';
}

export const DEFAULT_RESPONSIVE_PRESETS: ResponsiveViewportPreset[] = [
  { id: 'mobile-sm', label: 'Mobile (375×812)', width: 375, height: 812, category: 'mobile' },
  { id: 'tablet-md', label: 'Tablet (768×1024)', width: 768, height: 1024, category: 'tablet' },
  { id: 'laptop-lg', label: 'Laptop (1280×800)', width: 1280, height: 800, category: 'laptop' },
  {
    id: 'desktop-xl',
    label: 'Desktop (1440×900)',
    width: 1440,
    height: 900,
    category: 'desktop',
  },
];

export interface ResponsiveInspectionPlan {
  targetUrl: string;
  viewports: ResponsiveViewportPreset[];
  strategy: 'controlled_popup_windows';
  synchronizationSupported: boolean;
  limitationsDisclosure: string[];
}

export function createResponsiveInspectionPlan(
  targetUrl: string,
  customViewports?: ResponsiveViewportPreset[],
): ResponsiveInspectionPlan {
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Responsive inspection requires an http:// or https:// page URL');
  }

  const viewports = (
    customViewports && customViewports.length > 0 ? customViewports : DEFAULT_RESPONSIVE_PRESETS
  ).map((vp) => ({
    ...vp,
    width: Math.max(240, Math.min(3840, Math.round(vp.width))),
    height: Math.max(320, Math.min(2160, Math.round(vp.height))),
  }));

  return {
    targetUrl: parsed.toString(),
    viewports,
    strategy: 'controlled_popup_windows',
    synchronizationSupported: true,
    limitationsDisclosure: [
      'Uses controlled browser popup windows at target CSS pixel dimensions so top-level media queries execute natively without violating X-Frame-Options or CSP frame-ancestors.',
      'Does not emulate touch hardware events, mobile GPU shaders, or server-side User-Agent sniffing without debugger attachment.',
      'Synchronized scrolling operates across controllable HTTP(S) tabs where the PageSift content script is active.',
    ],
  };
}

export class ResponsiveScrollSynchronizer {
  private lastSourceTabId: number | null = null;
  private lastEventTimestampMs = 0;
  private readonly echoSuppressionWindowMs: number;
  private readonly managedTabIds = new Set<number>();

  public constructor(echoSuppressionWindowMs = 150) {
    this.echoSuppressionWindowMs = echoSuppressionWindowMs;
  }

  public registerManagedTabs(tabIds: number[]): void {
    for (const id of tabIds) {
      this.managedTabIds.add(id);
    }
  }

  public unregisterTab(tabId: number): void {
    this.managedTabIds.delete(tabId);
  }

  public clearAllManagedTabs(): number[] {
    const ids = Array.from(this.managedTabIds);
    this.managedTabIds.clear();
    this.lastSourceTabId = null;
    this.lastEventTimestampMs = 0;
    return ids;
  }

  public computeBroadcastTargets(params: {
    sourceTabId: number;
    scrollXRatio: number;
    scrollYRatio: number;
    nowMs?: number;
  }): {
    shouldBroadcast: boolean;
    targetTabIds: number[];
    scrollXRatio: number;
    scrollYRatio: number;
  } {
    const now = params.nowMs ?? Date.now();
    if (!this.managedTabIds.has(params.sourceTabId)) {
      return {
        shouldBroadcast: false,
        targetTabIds: [],
        scrollXRatio: 0,
        scrollYRatio: 0,
      };
    }

    if (
      this.lastSourceTabId !== null &&
      this.lastSourceTabId !== params.sourceTabId &&
      now - this.lastEventTimestampMs < this.echoSuppressionWindowMs
    ) {
      return {
        shouldBroadcast: false,
        targetTabIds: [],
        scrollXRatio: 0,
        scrollYRatio: 0,
      };
    }

    this.lastSourceTabId = params.sourceTabId;
    this.lastEventTimestampMs = now;

    const targetTabIds = Array.from(this.managedTabIds).filter((id) => id !== params.sourceTabId);

    return {
      shouldBroadcast: targetTabIds.length > 0,
      targetTabIds,
      scrollXRatio: Math.max(0, Math.min(1, params.scrollXRatio)),
      scrollYRatio: Math.max(0, Math.min(1, params.scrollYRatio)),
    };
  }
}
