// Pure geometry helpers for the editor (no Skia imports -> unit-testable).
import type { ImageLayer, Transform, MaskShape } from '../types';

export type Fit = ImageLayer['fit'];
export type Rect = { x: number; y: number; width: number; height: number };

// Size of a src rectangle drawn into a canvas under an object-fit rule.
export function fitSize(srcW: number, srcH: number, cw: number, ch: number, fit: Fit): { dw: number; dh: number } {
  if (srcW <= 0 || srcH <= 0) return { dw: cw, dh: ch };
  switch (fit) {
    case 'stretch': return { dw: cw, dh: ch };
    case 'center':  return { dw: srcW, dh: srcH };
    case 'contain': {
      const s = Math.min(cw / srcW, ch / srcH);
      return { dw: srcW * s, dh: srcH * s };
    }
    case 'cover':
    default: {
      const s = Math.max(cw / srcW, ch / srcH);
      return { dw: srcW * s, dh: srcH * s };
    }
  }
}

// How to draw a (possibly cropped) image, centered at the layer origin (0,0),
// clipped to its fitted destination box. Full image is drawn + clipped so the
// crop rect maps exactly onto the destination — avoids needing SkImage.makeSubset.
export function imageDraw(layer: ImageLayer, imgW: number, imgH: number, cw: number, ch: number) {
  const crop: Rect = layer.crop ?? { x: 0, y: 0, width: imgW, height: imgH };
  const { dw, dh } = fitSize(crop.width, crop.height, cw, ch, layer.fit);
  const sx = dw / crop.width;
  const sy = dh / crop.height;
  return {
    // clip box (centered at origin)
    clip: { x: -dw / 2, y: -dh / 2, width: dw, height: dh } as Rect,
    // full-image placement so crop.(x,y) lands at the clip's top-left
    imgX: -dw / 2 - crop.x * sx,
    imgY: -dh / 2 - crop.y * sy,
    imgW: imgW * sx,
    imgH: imgH * sy,
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Corner radius (px) for a shape mask on a w×h box. Single source of truth so the
// live preview, editor render, and flattened export always match.
export function maskRadius(shape: MaskShape | undefined, w: number, h: number): number {
  const m = Math.min(w, h);
  switch (shape) {
    case 'circle': return m / 2;
    case 'squircle': return m * 0.3;
    case 'rounded': return m * 0.12;
    default: return 0;
  }
}

// Local (pre-transform) box size of an image layer, centered at origin.
export function imageBox(layer: ImageLayer, imgW: number, imgH: number, cw: number, ch: number): { w: number; h: number } {
  const d = imageDraw(layer, imgW, imgH, cw, ch);
  return { w: d.clip.width, h: d.clip.height };
}

// Is a point (canvas coords) inside a layer whose local box is boxW×boxH, given its transform?
// Inverse-transforms the point into the layer's local space and tests the axis-aligned box.
export function pointInLayer(
  px: number, py: number, t: Transform, boxW: number, boxH: number, cw: number, ch: number, pad = 12,
): boolean {
  const cx = cw / 2 + t.x, cy = ch / 2 + t.y;
  const dx = px - cx, dy = py - cy;
  const cos = Math.cos(-t.rotation), sin = Math.sin(-t.rotation);
  const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
  const sx = rx / (t.scaleX || 1), sy = ry / (t.scaleY || 1);
  return Math.abs(sx) <= boxW / 2 + pad && Math.abs(sy) <= boxH / 2 + pad;
}
