import { buildShortSelector, isPageSiftElement, parsePixelValue } from './dom-utils.js';
import type { BoxSides } from './inspect-engine.js';

export interface MeasuredBoxMetrics {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  pageX: number;
  pageY: number;
  padding: BoxSides;
  margin: BoxSides;
  border: BoxSides;
}

export interface ElementDistanceMetrics {
  horizontalGap: number;
  verticalGap: number;
  centerDistance: number;
  isOverlapping: boolean;
  guideLines: {
    horizontal: { x1: number; y1: number; x2: number; y2: number; distance: number };
    vertical: { x1: number; y1: number; x2: number; y2: number; distance: number };
  };
}

export interface MeasureReport {
  primary: MeasuredBoxMetrics;
  secondary: MeasuredBoxMetrics | null;
  distance: ElementDistanceMetrics | null;
  viewport: {
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
}

function measureSingleElement(el: Element, win: Window): MeasuredBoxMetrics {
  if (isPageSiftElement(el)) {
    throw new Error('Cannot measure PageSift internal UI element');
  }
  if (!el.isConnected) {
    throw new Error('Measured element is detached from document');
  }
  const rect = el.getBoundingClientRect();
  const style = win.getComputedStyle(el);

  return {
    selector: buildShortSelector(el),
    x: Number(rect.x.toFixed(2)),
    y: Number(rect.y.toFixed(2)),
    width: Number(rect.width.toFixed(2)),
    height: Number(rect.height.toFixed(2)),
    top: Number(rect.top.toFixed(2)),
    right: Number(rect.right.toFixed(2)),
    bottom: Number(rect.bottom.toFixed(2)),
    left: Number(rect.left.toFixed(2)),
    pageX: Number((rect.left + win.scrollX).toFixed(2)),
    pageY: Number((rect.top + win.scrollY).toFixed(2)),
    padding: {
      top: parsePixelValue(style.paddingTop),
      right: parsePixelValue(style.paddingRight),
      bottom: parsePixelValue(style.paddingBottom),
      left: parsePixelValue(style.paddingLeft),
    },
    margin: {
      top: parsePixelValue(style.marginTop),
      right: parsePixelValue(style.marginRight),
      bottom: parsePixelValue(style.marginBottom),
      left: parsePixelValue(style.marginLeft),
    },
    border: {
      top: parsePixelValue(style.borderTopWidth),
      right: parsePixelValue(style.borderRightWidth),
      bottom: parsePixelValue(style.borderBottomWidth),
      left: parsePixelValue(style.borderLeftWidth),
    },
  };
}

function computeDistance(a: MeasuredBoxMetrics, b: MeasuredBoxMetrics): ElementDistanceMetrics {
  let horizontalGap = 0;
  let hx1 = a.left + a.width / 2;
  let hx2 = b.left + b.width / 2;
  const hy = (a.top + a.height / 2 + (b.top + b.height / 2)) / 2;

  if (a.right < b.left) {
    horizontalGap = Number((b.left - a.right).toFixed(2));
    hx1 = a.right;
    hx2 = b.left;
  } else if (b.right < a.left) {
    horizontalGap = Number((a.left - b.right).toFixed(2));
    hx1 = b.right;
    hx2 = a.left;
  }

  let verticalGap = 0;
  let vy1 = a.top + a.height / 2;
  let vy2 = b.top + b.height / 2;
  const vx = (a.left + a.width / 2 + (b.left + b.width / 2)) / 2;

  if (a.bottom < b.top) {
    verticalGap = Number((b.top - a.bottom).toFixed(2));
    vy1 = a.bottom;
    vy2 = b.top;
  } else if (b.bottom < a.top) {
    verticalGap = Number((a.top - b.bottom).toFixed(2));
    vy1 = b.bottom;
    vy2 = a.top;
  }

  const isOverlapping =
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  const acx = a.left + a.width / 2;
  const acy = a.top + a.height / 2;
  const bcx = b.left + b.width / 2;
  const bcy = b.top + b.height / 2;
  const centerDistance = Number(Math.hypot(bcx - acx, bcy - acy).toFixed(2));

  return {
    horizontalGap,
    verticalGap,
    centerDistance,
    isOverlapping,
    guideLines: {
      horizontal: {
        x1: Number(hx1.toFixed(2)),
        y1: Number(hy.toFixed(2)),
        x2: Number(hx2.toFixed(2)),
        y2: Number(hy.toFixed(2)),
        distance: horizontalGap,
      },
      vertical: {
        x1: Number(vx.toFixed(2)),
        y1: Number(vy1.toFixed(2)),
        x2: Number(vx.toFixed(2)),
        y2: Number(vy2.toFixed(2)),
        distance: verticalGap,
      },
    },
  };
}

export function measureElements(
  primaryEl: Element,
  secondaryEl: Element | null,
  win: Window,
): MeasureReport {
  const primary = measureSingleElement(primaryEl, win);
  const secondary = secondaryEl ? measureSingleElement(secondaryEl, win) : null;
  const distance = secondary ? computeDistance(primary, secondary) : null;

  return {
    primary,
    secondary,
    distance,
    viewport: {
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      devicePixelRatio: win.devicePixelRatio || 1,
    },
  };
}
