// Animated pipeline: decode a GIF / animated WebP with Skia, apply the SAME square
// crop to every frame (identical geometry to the static PNG path), and re-encode as
// a looping 512×512 GIF on-device.
import { Skia, ColorType, AlphaType } from '@shopify/react-native-skia';
import { fitSize, type Rect } from './geometry';
import { createGifEncoder } from './gifEncode';
import { writeTempBytes } from '../storage';
import { STICKER_SIZE } from './renderCrop';

// Cap on ENCODED frames. Longer sources are frame-sampled (every k-th frame with
// summed delays) so they keep their full duration instead of being cut short.
export const MAX_GIF_FRAMES = 100;
const MAX_SOURCE_FRAMES = 600; // hard stop for absurd inputs

// Returns the uri of a temp .gif, or null when the source isn't actually animated
// (0-1 frames) — the caller then falls back to the static PNG path.
export async function renderCroppedGif(
  srcUri: string, crop: Rect, onProgress?: (done: number, total: number) => void,
): Promise<string | null> {
  const data = await Skia.Data.fromURI(srcUri);
  const anim = Skia.AnimatedImage.MakeAnimatedImageFromEncoded(data);
  if (!anim) return null;
  try {
    const total = Math.min(anim.getFrameCount(), MAX_SOURCE_FRAMES);
    if (total <= 1) return null;

    const S = STICKER_SIZE;
    const { dw, dh } = fitSize(crop.width, crop.height, S, S, 'contain');
    const dst = Skia.XYWHRect((S - dw) / 2, (S - dh) / 2, dw, dh);
    const src = Skia.XYWHRect(crop.x, crop.y, crop.width, crop.height);
    const info = { width: S, height: S, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
    const paint = Skia.Paint();
    const step = Math.max(1, Math.ceil(total / MAX_GIF_FRAMES));

    const enc = createGifEncoder(S, S);
    // Sampled frame is held until its whole delay-bucket (its own delay + the
    // skipped frames') is known, then encoded with the summed delay.
    let held: Uint8Array | null = null;
    let heldDelay = 0;
    let written = 0;

    const flushHeld = () => {
      if (held) { enc.addFrame(held, heldDelay); written++; held = null; heldDelay = 0; }
    };

    for (let i = 0; i < total; i++) {
      const delay = anim.currentFrameDuration();
      if (delay < 0) break; // decoder hit the end / an error — stop cleanly
      if (i % step === 0) {
        flushHeld();
        const frame = anim.getCurrentFrame();
        if (frame) {
          const surface = Skia.Surface.Make(S, S);
          if (!surface) throw new Error('Could not create a canvas.');
          surface.getCanvas().drawImageRect(frame, src, dst, paint);
          const snap = surface.makeImageSnapshot();
          const px = snap.readPixels(0, 0, info);
          if (px && px instanceof Uint8Array) held = px;
          snap.dispose();
          surface.dispose();
          frame.dispose();
        }
      }
      heldDelay += delay;
      if (i < total - 1 && anim.decodeNextFrame() < 0) break; // corrupt/truncated source
      // Encoding is heavy, synchronous JS (slower on Hermes than Node) — yield every
      // couple of frames so the UI thread's JS side stays alive and can show progress.
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
      onProgress?.(i + 1, total);
    }
    flushHeld();

    if (written <= 1) return null;
    return await writeTempBytes(enc.finish(), 'gif');
  } finally {
    anim.dispose();
  }
}

// Cheap pre-filter so we only attempt animated decode for plausible formats.
export function maybeAnimatedSource(uri: string, mimeType?: string | null): boolean {
  const m = (mimeType ?? '').toLowerCase();
  const u = uri.toLowerCase();
  return m.includes('gif') || m.includes('webp') || u.endsWith('.gif') || u.endsWith('.webp');
}
