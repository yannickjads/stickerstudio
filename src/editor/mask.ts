// Pixel-level background removal — pure functions over typed arrays, no Skia and
// no React, so every one of them is unit-tested in Node against real images.
//
// A mask is one byte per pixel: 255 keeps the pixel, 0 removes it. The source
// pixels are never modified, so a removal is always reversible and the wand
// always judges the ORIGINAL colour of a pixel, even one already erased.

export type Mask = Uint8Array;

export const fullMask = (w: number, h: number): Mask => new Uint8Array(w * h).fill(255);

// Start from what the automatic cut-out produced: its transparency is the mask.
export function maskFromAlpha(rgba: Uint8Array, w: number, h: number): Mask {
  const m = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < m.length; i++, p += 4) m[i] = rgba[p];
  return m;
}

// Tolerance is 0–100 as the UI shows it; compare in the same units as a colour
// channel so "20" means "within about a fifth of the range on average".
const threshold = (tolerance: number) => {
  const t = Math.min(100, Math.max(0, tolerance)) * 2.55;
  return t * t; // squared, to keep the inner loop free of sqrt
};

// Squared mean channel distance, 0..65025 — the same scale as `threshold`.
const dist2 = (rgba: Uint8Array, p: number, r: number, g: number, b: number) => {
  const dr = rgba[p] - r, dg = rgba[p + 1] - g, db = rgba[p + 2] - b;
  return (dr * dr + dg * dg + db * db) / 3;
};

export type WandOptions = {
  /** Only the patch under the finger, rather than that colour across the frame. */
  connected?: boolean;
  /** Give the boundary a partial alpha instead of a hard 1-bit edge. */
  soften?: boolean;
};

/**
 * Magic wand: remove the pixels whose colour is close to the one under the finger.
 *
 * Every pixel is judged against the SEED colour, not against its neighbour: a
 * neighbour-relative test creeps across a soft gradient and swallows the subject.
 *
 * `connected` picks between the two useful meanings of a tap. Connected is a
 * scanline flood fill — safe and literal, but it cannot reach a pocket of wall
 * fenced in by hair, and those pockets are exactly what makes a hand cut-out look
 * botched. The default takes the colour everywhere, which is what someone tapping
 * a wall means; Restore is there for when it takes too much.
 *
 * `soften` gives the one-pixel rim where subject and background blend a partial
 * alpha instead of keeping it whole. Without it every cut-out carries a thin halo
 * of the old background, and no amount of blurring afterwards removes it —
 * the halo is real picture, not a hard edge.
 *
 * Returns how many pixels it removed.
 */
export function floodRemove(
  rgba: Uint8Array, w: number, h: number, mask: Mask,
  seedX: number, seedY: number, tolerance: number, opts: WandOptions = {},
): number {
  const { connected = false, soften = true } = opts;
  const x0 = Math.round(seedX), y0 = Math.round(seedY);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return 0;

  const thr = threshold(tolerance);
  const seed = (y0 * w + x0) * 4;
  const r = rgba[seed], g = rgba[seed + 1], b = rgba[seed + 2], a = rgba[seed + 3];

  // Transparent regions have no meaningful colour; treat "already invisible" as
  // its own class so tapping an empty margin doesn't select the whole picture.
  const transparentSeed = a < 8;
  const match = (i: number) => {
    const p = i * 4;
    if (transparentSeed) return rgba[p + 3] < 8;
    if (rgba[p + 3] < 8) return false;
    return dist2(rgba, p, r, g, b) <= thr;
  };

  const hit = new Uint8Array(w * h); // selected, independent of the current mask

  if (connected) {
    // Scanline fill: whole rows at a time, so a 512² image is a couple of
    // milliseconds rather than a stack a quarter of a million frames deep.
    const stack: number[] = [x0, y0];
    while (stack.length) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      let i = y * w + x;
      if (hit[i] || !match(i)) continue;

      while (x > 0 && !hit[i - 1] && match(i - 1)) { x--; i--; }
      let upRun = false, downRun = false;
      for (; x < w && !hit[i] && match(i); x++, i++) {
        hit[i] = 1;
        if (y > 0) {
          const on = !hit[i - w] && match(i - w);
          if (on && !upRun) { stack.push(x, y - 1); upRun = true; }
          else if (!on) upRun = false;
        }
        if (y < h - 1) {
          const on = !hit[i + w] && match(i + w);
          if (on && !downRun) { stack.push(x, y + 1); downRun = true; }
          else if (!on) downRun = false;
        }
      }
    }
  } else {
    for (let i = 0; i < hit.length; i++) if (match(i)) hit[i] = 1;
  }

  // Counted in visible pixels: a tap that only clears alpha nobody could see is a
  // tap that did nothing, and the caller uses this to decide whether the action
  // is worth an undo step.
  let removed = 0;
  for (let i = 0; i < hit.length; i++) {
    if (hit[i] && mask[i] !== 0) {
      if (mask[i] >= 8) removed++;
      mask[i] = 0;
    }
  }

  // The rim: kept pixels touching a removed one are part background. How much
  // reads straight off how far past the threshold their colour sits — at the
  // threshold they are background, half again beyond it they are all subject.
  if (soften && removed > 0 && !transparentSeed) {
    const edge = Math.sqrt(thr);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (hit[i] || mask[i] === 0) continue;
        const touches = (x > 0 && hit[i - 1]) || (x < w - 1 && hit[i + 1])
          || (y > 0 && hit[i - w]) || (y < h - 1 && hit[i + w]);
        if (!touches) continue;
        const p = i * 4;
        if (rgba[p + 3] < 8) continue;
        const t = Math.sqrt(dist2(rgba, p, r, g, b)) / edge; // > 1 by construction
        const v = Math.min(255, Math.max(0, ((t - 1) / 0.5) * 255)) | 0;
        if (v < mask[i]) mask[i] = v;
      }
    }
  }
  return removed;
}

// A brush stamp along one finger movement. Stamping every pixel of the segment
// (rather than only its endpoints) is what keeps a fast swipe from turning into
// a dotted line. `value` is 0 to erase, 255 to bring pixels back.
// Returns the touched bounds so the preview only has to redraw that patch.
export type Dirty = { x0: number; y0: number; x1: number; y1: number } | null;

export function paintStroke(
  mask: Mask, w: number, h: number,
  ax: number, ay: number, bx: number, by: number,
  radius: number, value: number,
): Dirty {
  const r = Math.max(0.5, radius);
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (r * 0.4)));
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const r2 = r * r;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t;
    const lo = Math.max(0, Math.floor(cx - r)), hi = Math.min(w - 1, Math.ceil(cx + r));
    const top = Math.max(0, Math.floor(cy - r)), bot = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = top; y <= bot; y++) {
      const dy = y - cy;
      const row = y * w;
      for (let x = lo; x <= hi; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy > r2) continue;
        const i = row + x;
        if (mask[i] === value) continue;
        mask[i] = value;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

/**
 * Soften the cut. A hard 1-bit edge is what makes a manual cut-out look pasted
 * on; one box-blur pass gives every boundary pixel a partial alpha while leaving
 * solid interiors untouched (all nine neighbours agree there).
 *
 * The blur may only ever take alpha away, never add it. A plain box blur is
 * symmetric, so it lifts removed pixels next to kept ones from 0 up to ~85 —
 * which paints a partial-alpha halo of the background back on, the exact thing
 * the cut-out existed to get rid of. Clamping to the original value turns the
 * blur into a one-sided erode.
 *
 * Radius 0 returns the mask unchanged.
 */
export function feather(mask: Mask, w: number, h: number, radius = 1): Mask {
  if (radius <= 0) return mask;
  let src = mask;
  for (let pass = 0; pass < radius; pass++) {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        let sum = 0;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) sum += src[row + xx];
        }
        const n = (y1 - y0 + 1) * (x1 - x0 + 1);
        const i = y * w + x;
        const blurred = (sum / n) | 0;
        out[i] = blurred < src[i] ? blurred : src[i];
      }
    }
    src = out;
  }
  return src;
}

/**
 * Source pixels with the mask folded into their alpha — both the on-screen
 * preview and, at the end, the saved cut-out. Passing `into` + `dirty` rewrites
 * only the patch the brush just touched, which is what keeps a drag at 60fps:
 * a full 512² rebuild is ~1.5ms, a brush move ~0.05ms.
 *
 * The mask caps the alpha rather than scaling it. For an opaque photo — every
 * ordinary sticker — the two are identical, but capping is what makes editing a
 * cut-out a second time safe: the mask starts life as a copy of the source alpha
 * (see maskFromAlpha), so scaling would square every partial edge and eat the
 * anti-aliasing a little more on each visit.
 */
export function compositeInto(
  rgba: Uint8Array, mask: Mask, w: number, h: number,
  into?: Uint8Array, dirty?: Dirty,
): Uint8Array {
  const buf = into && into.length === rgba.length ? into : new Uint8Array(rgba.length);
  const partial = Boolean(into && dirty && buf === into);
  const x0 = partial ? dirty!.x0 : 0;
  const x1 = partial ? dirty!.x1 : w - 1;
  const y0 = partial ? dirty!.y0 : 0;
  const y1 = partial ? dirty!.y1 : h - 1;
  for (let y = y0; y <= y1; y++) {
    let i = y * w + x0;
    let p = i * 4;
    for (let x = x0; x <= x1; x++, i++, p += 4) {
      const m = mask[i], a = rgba[p + 3];
      buf[p] = rgba[p]; buf[p + 1] = rgba[p + 1]; buf[p + 2] = rgba[p + 2];
      buf[p + 3] = m < a ? m : a;
    }
  }
  return buf;
}

// Bake the mask into a copy of the source pixels — the actual cut-out.
export const applyMask = (rgba: Uint8Array, mask: Mask, w: number, h: number): Uint8Array =>
  compositeInto(rgba, mask, w, h);

// How much of the picture is left — used to warn before saving an empty sticker.
export function keptFraction(mask: Mask): number {
  let kept = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) kept++;
  return kept / mask.length;
}
