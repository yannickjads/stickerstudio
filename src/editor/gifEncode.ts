// Pure GIF assembly from RGBA frames — no Skia imports, so this exact module is
// unit-tested in Node. Streaming: one frame in memory at a time (a 512² RGBA frame
// is 1 MB; buffering a whole GIF would be 50-150 MB).
//
// Size control is done with the two levers that cannot go wrong: how many frames
// the caller feeds in, and how many colours each frame may use. Inter-frame
// differencing (ezgif's "optimize") was tried and produced visibly wrong output,
// so it is deliberately absent rather than shipped broken.
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export type GifStreamEncoder = {
  addFrame(rgba: Uint8Array, delayMs: number): void;
  finish(): Uint8Array;
};

export function createGifEncoder(
  width: number, height: number, opts: { colors?: number } = {},
): GifStreamEncoder {
  const colors = Math.max(2, Math.min(256, opts.colors ?? 256));
  const gif = GIFEncoder();
  return {
    addFrame(rgba: Uint8Array, delayMs: number) {
      // GIF transparency is 1-bit — binarize alpha so edges don't get dirty fringes.
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] < 128 ? 0 : 255;
      const palette = quantize(rgba, colors, { format: 'rgba4444', oneBitAlpha: true });
      const index = applyPalette(rgba, palette, 'rgba4444');
      const ti = palette.findIndex((p) => p[3] === 0);
      gif.writeFrame(index, width, height, {
        palette,
        delay: Math.max(20, Math.round(delayMs)), // browsers/apps clamp <20ms anyway
        transparent: ti >= 0,
        transparentIndex: ti >= 0 ? ti : 0,
        dispose: 2, // restore to background so a moving subject never smears
      });
    },
    finish() {
      gif.finish();
      return gif.bytes();
    },
  };
}
