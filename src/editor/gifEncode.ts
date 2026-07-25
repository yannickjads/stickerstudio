// Pure GIF assembly from RGBA frames — no Skia imports, so this exact module is
// unit-tested in Node against known-good source frames.
//
// The optimisation that actually pays off (gifsicle's -O2) needs one thing first:
// a palette shared by every frame. With a per-frame palette an unchanged patch of
// background quantises to a marginally different colour each time, so nothing can
// be skipped. With a shared palette, unchanged pixels map to the identical index
// and can be written as transparent, leaving the previous frame showing through.
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export type GifPalette = number[][];

export type GifStreamEncoder = {
  addFrame(rgba: Uint8Array, delayMs: number): void;
  finish(): Uint8Array;
};

export const isFullyOpaque = (rgba: Uint8Array) => {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
};

// One palette for the whole animation, built from a sample of its frames.
// Sampling every 4th pixel keeps the cost down without changing which colours
// dominate — median cut only cares about how the colour cloud is spread.
export function buildPalette(
  samples: Uint8Array[], colors = 256, reserveTransparent = false,
): GifPalette {
  const stride = 4 * 4; // every 4th pixel
  let n = 0;
  for (const s of samples) n += Math.ceil(s.length / stride);
  const merged = new Uint8Array(n * 4);
  let o = 0;
  for (const s of samples) {
    for (let i = 0; i < s.length; i += stride) {
      merged[o] = s[i]; merged[o + 1] = s[i + 1];
      merged[o + 2] = s[i + 2]; merged[o + 3] = s[i + 3] < 128 ? 0 : 255;
      o += 4;
    }
  }
  const want = reserveTransparent ? Math.max(2, colors - 1) : colors;
  const palette = quantize(merged.subarray(0, o), want, { format: 'rgba4444', oneBitAlpha: true });
  // A fully opaque clip yields a palette with no transparent entry — and without
  // one there is no way to say "this pixel did not change", so differencing
  // silently does nothing. Keep a slot for it.
  if (reserveTransparent && !palette.some((p) => p[3] === 0)) palette.push([0, 0, 0, 0]);
  return palette;
}

export function createGifEncoder(
  width: number, height: number,
  opts: { colors?: number; palette?: GifPalette; optimize?: boolean } = {},
): GifStreamEncoder {
  const colors = Math.max(2, Math.min(256, opts.colors ?? 256));
  const gif = GIFEncoder();
  const shared = opts.palette ?? null;
  let wroteFirst = false;
  let prev: Uint8Array | null = null;   // previous frame's palette indices
  let transparentIdx = -1;
  // Differencing needs an unambiguous meaning for "transparent", so it is only
  // used when the source has no transparency of its own — which is exactly the
  // case for video clips and square-cropped animations.
  let differencing = false;

  return {
    addFrame(rgba: Uint8Array, delayMs: number) {
      const opaque = isFullyOpaque(rgba);
      if (!wroteFirst) differencing = Boolean(opts.optimize && shared && opaque);

      // GIF transparency is 1-bit — binarise so edges don't get dirty fringes.
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] < 128 ? 0 : 255;

      const palette = shared ?? quantize(rgba, colors, { format: 'rgba4444', oneBitAlpha: true });
      if (transparentIdx < 0) transparentIdx = palette.findIndex((p) => p[3] === 0);
      const index = applyPalette(rgba, palette, 'rgba4444');

      let out = index;
      if (differencing && prev && opaque && transparentIdx >= 0) {
        out = new Uint8Array(index);
        for (let p = 0; p < out.length; p++) if (out[p] === prev[p]) out[p] = transparentIdx;
      }

      gif.writeFrame(out, width, height, {
        // Written once as the global colour table; passing it again per frame
        // would add a 768-byte local table to every single frame.
        ...(wroteFirst ? {} : { palette }),
        delay: Math.max(20, Math.round(delayMs)),
        transparent: transparentIdx >= 0,
        transparentIndex: transparentIdx >= 0 ? transparentIdx : 0,
        // Differencing needs the canvas left intact; otherwise restore to
        // background so a moving subject never smears.
        dispose: differencing ? 1 : 2,
      });

      prev = index;       // compare against what the decoder now shows
      wroteFirst = true;
    },
    finish() {
      gif.finish();
      return gif.bytes();
    },
  };
}
