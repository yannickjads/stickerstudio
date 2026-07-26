// Video -> animated sticker. Frames come out of AVFoundation already downscaled,
// then follow exactly the same path as an imported GIF: one crop rect applied to
// every frame, re-encoded as a looping 512×512 GIF.
import { Skia, ColorType, AlphaType } from '@shopify/react-native-skia';
import { extractFrames } from '../../modules/video-frames';
import { fitSize, type Rect } from './geometry';
import { createGifEncoder, buildPalette } from './gifEncode';
import { loadSkImage, STICKER_SIZE } from './renderCrop';
import { writeTempBytes, deleteFile } from '../storage';

// How many colours the shared palette gets. Frame rate is chosen separately —
// they trade off against each other and against length, and which one to spend
// the budget on depends entirely on the clip.
export type QualityKey = 'smooth' | 'balanced' | 'small';
export const QUALITY: Record<QualityKey, { colors: number; label: string }> = {
  smooth: { colors: 256, label: 'Best colours' },
  balanced: { colors: 128, label: 'Balanced' },
  small: { colors: 64, label: 'Smallest' },
};

export const FPS_CHOICES = [8, 10, 12, 15, 20] as const;
export const DEFAULT_FPS = 12;

// WhatsApp's own limit for an animated sticker, from its third-party pack spec:
// 512x512, at most 10 seconds, and at most 500 KB. The length is the generous
// one — the 500 KB is what actually bites, so the app reports the real size of
// what it produced rather than guessing in advance.
export const MAX_CLIP_MS = 10000;
export const MAX_STICKER_BYTES = 500 * 1024;
// Encoding is synchronous JS, so this is a wall-clock ceiling as much as anything:
// 150 frames is 10s at 15fps, and already takes a while.
const MAX_FRAMES = 150;

// The crop is expressed in the video's own pixels, so it carries the size it was
// measured against — extraction hands back smaller frames.
export type VideoCrop = Rect & { videoW: number; videoH: number };

export async function renderVideoSticker(
  uri: string,
  crop: VideoCrop,
  opts: { startMs: number; durationMs: number; quality: QualityKey; fps?: number; optimize?: boolean },
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const { colors } = QUALITY[opts.quality];
  const fps = opts.fps ?? DEFAULT_FPS;
  const durationMs = Math.min(opts.durationMs, MAX_CLIP_MS);
  const count = Math.max(2, Math.min(MAX_FRAMES, Math.round((durationMs / 1000) * fps)));

  const frames = await extractFrames(uri, opts.startMs, durationMs, count, 720);
  const S = STICKER_SIZE;
  const info = { width: S, height: S, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
  const paint = Skia.Paint();
  const delay = durationMs / frames.length;
  const { dw, dh } = fitSize(crop.width, crop.height, S, S, 'contain');
  const dst = Skia.XYWHRect((S - dw) / 2, (S - dh) / 2, dw, dh);

  // Render one frame to its final 512² pixels.
  const renderFrame = async (path: string): Promise<Uint8Array | null> => {
    const img = await loadSkImage(path);
    // Frames were downscaled during extraction, so the crop rect — expressed in
    // the video's own pixels — has to be scaled onto the frame we actually got.
    const sx = img.width() / crop.videoW;
    const sy = img.height() / crop.videoH;
    const src = Skia.XYWHRect(crop.x * sx, crop.y * sy, crop.width * sx, crop.height * sy);
    const surface = Skia.Surface.Make(S, S);
    if (!surface) { img.dispose(); throw new Error('Could not create a canvas.'); }
    surface.getCanvas().drawImageRect(img, src, dst, paint);
    const snap = surface.makeImageSnapshot();
    const px = snap.readPixels(0, 0, info);
    snap.dispose(); surface.dispose(); img.dispose();
    return px instanceof Uint8Array ? px : null;
  };

  let written = 0;
  try {
    // Pass 1 — one palette for the whole clip, from a handful of frames. Without
    // a shared palette an unchanged background quantises slightly differently in
    // every frame and nothing can be skipped.
    const picks = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => Math.min(frames.length - 1, Math.round(f * (frames.length - 1))));
    const samples: Uint8Array[] = [];
    for (const i of Array.from(new Set(picks))) {
      const px = await renderFrame(frames[i]);
      if (px) samples.push(px);
      await new Promise((r) => setTimeout(r, 0));
    }
    const optimize = opts.optimize !== false;
    const palette = buildPalette(samples, colors, optimize);

    // Pass 2 — encode, writing only what changed from frame to frame.
    const enc = createGifEncoder(S, S, { colors, palette, optimize });
    for (let i = 0; i < frames.length; i++) {
      const px = await renderFrame(frames[i]);
      if (px) { enc.addFrame(px, delay); written++; }
      onProgress?.(i + 1, frames.length);
      // Encoding is heavy synchronous JS — keep the UI thread's JS side alive.
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
    }
    if (written < 2) throw new Error('That clip produced too few frames.');
    return writeTempBytes(enc.finish(), 'gif');

  } finally {
    for (const f of frames) await deleteFile(f);
  }

}
