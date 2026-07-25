// Video -> animated sticker. Frames come out of AVFoundation already downscaled,
// then follow exactly the same path as an imported GIF: one crop rect applied to
// every frame, re-encoded as a looping 512×512 GIF.
import { Skia, ColorType, AlphaType } from '@shopify/react-native-skia';
import { extractFrames } from '../../modules/video-frames';
import { fitSize, type Rect } from './geometry';
import { createGifEncoder } from './gifEncode';
import { loadSkImage, STICKER_SIZE } from './renderCrop';
import { writeTempBytes, deleteFile } from '../storage';

// Named the way the choice actually feels, not by frame rate.
export type QualityKey = 'smooth' | 'balanced' | 'small';
export const QUALITY: Record<QualityKey, { fps: number; colors: number; label: string }> = {
  smooth: { fps: 15, colors: 256, label: 'Smooth' },
  balanced: { fps: 10, colors: 128, label: 'Balanced' },
  small: { fps: 8, colors: 64, label: 'Small' },
};

// WhatsApp animated stickers must stay under 500 KB and 3 s is the practical
// ceiling on every platform, so the clip length is capped rather than trusted.
export const MAX_CLIP_MS = 3000;
const MAX_FRAMES = 60;

// The crop is expressed in the video's own pixels, so it carries the size it was
// measured against — extraction hands back smaller frames.
export type VideoCrop = Rect & { videoW: number; videoH: number };

export async function renderVideoSticker(
  uri: string,
  crop: VideoCrop,
  opts: { startMs: number; durationMs: number; quality: QualityKey },
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const { fps, colors } = QUALITY[opts.quality];
  const durationMs = Math.min(opts.durationMs, MAX_CLIP_MS);
  const count = Math.max(2, Math.min(MAX_FRAMES, Math.round((durationMs / 1000) * fps)));

  const frames = await extractFrames(uri, opts.startMs, durationMs, count, 720);
  const S = STICKER_SIZE;
  const enc = createGifEncoder(S, S, { colors });
  const info = { width: S, height: S, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
  const paint = Skia.Paint();
  const delay = durationMs / frames.length;

  let written = 0;
  try {
    for (let i = 0; i < frames.length; i++) {
      const img = await loadSkImage(frames[i]);
      // Frames were downscaled during extraction, so the crop rect — expressed in
      // the video's own pixels — has to be scaled onto the frame we actually got.
      const sx = img.width() / crop.videoW;
      const sy = img.height() / crop.videoH;
      const src = Skia.XYWHRect(crop.x * sx, crop.y * sy, crop.width * sx, crop.height * sy);
      const { dw, dh } = fitSize(crop.width, crop.height, S, S, 'contain');
      const dst = Skia.XYWHRect((S - dw) / 2, (S - dh) / 2, dw, dh);

      const surface = Skia.Surface.Make(S, S);
      if (!surface) throw new Error('Could not create a canvas.');
      surface.getCanvas().drawImageRect(img, src, dst, paint);
      const snap = surface.makeImageSnapshot();
      const px = snap.readPixels(0, 0, info);
      if (px && px instanceof Uint8Array) { enc.addFrame(px, delay); written++; }
      snap.dispose();
      surface.dispose();
      img.dispose();

      onProgress?.(i + 1, frames.length);
      // Encoding is heavy synchronous JS — keep the UI thread's JS side alive.
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    for (const f of frames) await deleteFile(f);
  }

  if (written < 2) throw new Error('That clip produced too few frames.');
  return writeTempBytes(enc.finish(), 'gif');
}
