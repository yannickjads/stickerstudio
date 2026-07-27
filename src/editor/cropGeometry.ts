// The crop rectangle, as a fraction of the image (0..1 on both axes).
//
// Normalised rather than measured in points or pixels so that it survives the
// image being laid out at a different size, the shape being changed, and the
// screen being rotated — and so that all of this can be unit-tested in Node
// without a renderer.

export type NRect = { x: number; y: number; w: number; h: number };
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Smallest crop, as a fraction of the image. Keeps the four grips apart. */
export const MIN_FRAC = 0.08;

/**
 * The aspect a crop must hold, expressed in IMAGE PIXELS (width / height).
 * `null` means freeform. Note this is not the rect's w/h, which are fractions of
 * a possibly non-square image: a square crop of a 3:2 photo has w/h = 2/3.
 */
export type Aspect = number | null;

/** The rect's pixel aspect, given the image it sits on. */
export const pixelAspect = (r: NRect, imgW: number, imgH: number) =>
  (r.w * imgW) / (r.h * imgH);

/** The largest rect of `ar` that fits, centred. `null` fills the frame. */
export function centredRect(ar: Aspect, imgW: number, imgH: number): NRect {
  if (ar == null) return { x: 0, y: 0, w: 1, h: 1 };
  // In fractions: w/h = ar * imgH/imgW.
  const k = (ar * imgH) / imgW;
  let w = 1, h = 1 / k;
  if (h > 1) { h = 1; w = k; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Slide the rect, keeping every edge inside the image. */
export function moveRect(r: NRect, dx: number, dy: number): NRect {
  return {
    ...r,
    x: clamp(r.x + dx, 0, 1 - r.w),
    y: clamp(r.y + dy, 0, 1 - r.h),
  };
}

/**
 * Drag one corner. The opposite corner is the anchor and never moves, which is
 * what makes the gesture feel like grabbing a sheet of paper rather than
 * scaling it about its middle.
 *
 * With an aspect to hold, the axis that moved further wins and the other follows
 * — dragging mostly sideways changes the width and lets the height come along,
 * so the rect never fights the finger.
 *
 * Everything is clamped so the result stays inside the image AND keeps its
 * aspect; when the two conflict, aspect wins and the rect stops growing.
 */
export function resizeRect(
  r: NRect, corner: Corner, dx: number, dy: number,
  ar: Aspect, imgW: number, imgH: number,
): NRect {
  const left = corner === 'tl' || corner === 'bl';
  const top = corner === 'tl' || corner === 'tr';

  // The anchor: the corner diagonally opposite the one being dragged.
  const ax = left ? r.x + r.w : r.x;
  const ay = top ? r.y + r.h : r.y;

  // Where the dragged corner wants to be.
  let cx = (left ? r.x : r.x + r.w) + dx;
  let cy = (top ? r.y : r.y + r.h) + dy;

  cx = clamp(cx, 0, 1);
  cy = clamp(cy, 0, 1);

  // Signed, then floored at zero — NOT an absolute value. Dragging a corner past
  // its anchor should collapse the rect to its minimum, whereas abs() would
  // mirror it and make it grow again on the far side.
  let w = Math.max(0, left ? ax - cx : cx - ax);
  let h = Math.max(0, top ? ay - cy : cy - ay);

  if (ar != null) {
    const k = (ar * imgH) / imgW;   // the w/h the FRACTIONS must hold
    // Follow whichever axis the finger committed to.
    if (Math.abs(dx) * imgW >= Math.abs(dy) * imgH) h = w / k;
    else w = h * k;

    // Growing past an edge would break the aspect, so shrink to whatever fits.
    const roomX = left ? ax : 1 - ax;
    const roomY = top ? ay : 1 - ay;
    if (w > roomX) { w = roomX; h = w / k; }
    if (h > roomY) { h = roomY; w = h * k; }

    // And never below the minimum, in the smaller dimension.
    if (w < MIN_FRAC) { w = MIN_FRAC; h = w / k; }
    if (h < MIN_FRAC) { h = MIN_FRAC; w = h * k; }
    // If the minimum itself does not fit, the aspect cannot be honoured here.
    if (w > roomX || h > roomY) return r;
  } else {
    w = clamp(w, MIN_FRAC, left ? ax : 1 - ax);
    h = clamp(h, MIN_FRAC, top ? ay : 1 - ay);
  }

  return {
    x: left ? ax - w : ax,
    y: top ? ay - h : ay,
    w, h,
  };
}

/**
 * The integer pixel rect to actually crop, fully inside the image.
 *
 * Rounds the width first and derives the height from the aspect, rather than
 * rounding both: rounding each independently pulls the rect off its shape, and
 * visibly so when it is only a few dozen pixels across.
 */
export function toPixels(
  r: NRect, imgW: number, imgH: number, ar: Aspect,
): { x: number; y: number; width: number; height: number } {
  let w = Math.round(r.w * imgW);
  let h = ar != null ? Math.round(w / ar) : Math.round(r.h * imgH);

  w = clamp(w, 1, imgW);
  h = clamp(h, 1, imgH);
  if (ar != null) {
    // The derived side may not fit; step back down the other one to match.
    if (h > imgH) { h = imgH; w = clamp(Math.round(h * ar), 1, imgW); }
    if (w > imgW) { w = imgW; h = clamp(Math.round(w / ar), 1, imgH); }
  }

  return {
    x: clamp(Math.round(r.x * imgW), 0, imgW - w),
    y: clamp(Math.round(r.y * imgH), 0, imgH - h),
    width: w,
    height: h,
  };
}

/** The rect a stored pixel crop came from — for reopening an existing sticker. */
export function fromPixels(
  c: { x: number; y: number; width: number; height: number }, imgW: number, imgH: number,
): NRect {
  return { x: c.x / imgW, y: c.y / imgH, w: c.width / imgW, h: c.height / imgH };
}
