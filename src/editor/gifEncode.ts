// Pure GIF assembly from RGBA frames — no Skia imports, so this exact module is
// unit-tested in Node (scripts/test-gif-encode). Streaming: one frame in memory at
// a time (a 512² RGBA frame is 1 MB; buffering a whole GIF would be 50-150 MB).
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export type GifStreamEncoder = {
  addFrame(rgba: Uint8Array, delayMs: number): void;
  finish(): Uint8Array;
};

export function createGifEncoder(width: number, height: number): GifStreamEncoder {
  const gif = GIFEncoder();
  return {
    addFrame(rgba: Uint8Array, delayMs: number) {
      // GIF transparency is 1-bit — binarize alpha so edges don't get dirty fringes.
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] < 128 ? 0 : 255;
      const palette = quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true });
      const index = applyPalette(rgba, palette, 'rgba4444');
      const ti = palette.findIndex((p) => p[3] === 0);
      gif.writeFrame(index, width, height, {
        palette,
        delay: Math.max(20, Math.round(delayMs)), // browsers/apps clamp <20ms anyway
        transparent: ti >= 0,
        transparentIndex: ti >= 0 ? ti : 0,
        dispose: 2, // restore-to-background so transparent regions don't smear
      });
    },
    finish() {
      gif.finish();
      return gif.bytes();
    },
  };
}
