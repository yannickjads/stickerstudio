// Build a WhatsApp third-party sticker-pack payload from a pack's stickers.
// WhatsApp requirements (github.com/WhatsApp/stickers):
//   static sticker: 512×512 WebP ≤ 100 KB · animated: animated WebP ≤ 500 KB
//   tray icon: 96×96 PNG ≤ 50 KB · pack: 3..30 stickers, uniform static/animated
import { Skia, ImageFormat, type SkImage } from '@shopify/react-native-skia';
import type { Pack, Sticker } from '../types';
import { loadSkImage } from './renderCrop';
import { fitSize } from './geometry';
import { muxAnimatedWebp, base64ToBytes, bytesToBase64, frameDurationMs, type WebpFrame } from './webpMux';
import { MAX_ANIM_MS } from './renderAnimated';

const STATIC_LIMIT = 100 * 1024;
const ANIM_LIMIT = 500 * 1024;
const SIZE = 512;

export const WA_MIN_STICKERS = 3;

export function isAnimatedSticker(s: Sticker): boolean {
  // Recorded when the sticker was made, from the file's own bytes.
  return s.animated || s.uri.toLowerCase().endsWith('.gif');
}

const b64Bytes = (b64: string) => Math.floor(b64.length * 3 / 4);

// 128 characters, counted as characters. String.slice counts UTF-16 units and
// will happily cut a surrogate pair in half, which turns the last emoji of a pack
// name into a replacement character.
export const clamp128 = (s: string) => Array.from(s).slice(0, 128).join('');

/**
 * Exactly 512×512 — the spec says "exactly", not "at most".
 *
 * Stickers made in this app already are, but one imported from another pack is
 * stored byte-for-byte at whatever size it arrived, and an animated source is
 * decoded at its own size too. Encoding those unchanged produced stickers
 * WhatsApp rejects, and — worse — animated ones whose frames disagreed with the
 * 512×512 canvas the muxer writes around them.
 *
 * Returns the image untouched when it is already the right size, so the common
 * case allocates nothing; callers dispose the result only when it differs.
 */
function to512(img: SkImage): SkImage {
  if (img.width() === SIZE && img.height() === SIZE) return img;
  const surface = Skia.Surface.Make(SIZE, SIZE);
  if (!surface) throw new Error('Could not render the sticker.');
  const { dw, dh } = fitSize(img.width(), img.height(), SIZE, SIZE, 'contain');
  surface.getCanvas().drawImageRect(
    img,
    Skia.XYWHRect(0, 0, img.width(), img.height()),
    Skia.XYWHRect((SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh),
    Skia.Paint(),
  );
  const snap = surface.makeImageSnapshot();
  surface.dispose();
  return snap;
}

export async function staticWebpBase64(uri: string): Promise<string> {
  const decoded = await loadSkImage(uri);
  const img = to512(decoded);
  if (img !== decoded) decoded.dispose();
  for (const q of [90, 75, 55, 35]) {
    const b64 = img.encodeToBase64(ImageFormat.WEBP, q);
    if (!b64 || b64.length < 8) throw new Error('WebP encoding is not available.');
    if (b64Bytes(b64) <= STATIC_LIMIT) return b64;
  }
  throw new Error('Sticker could not be compressed under WhatsApp’s 100 KB limit.');
}

// A still sticker inside an ANIMATED pack: WhatsApp requires every sticker in an
// animated pack to be animated, so wrap the image as two identical frames (the
// standard trick — it simply doesn't move).
export async function stillAsAnimatedWebpBase64(uri: string): Promise<string> {
  const decoded = await loadSkImage(uri);
  const img = to512(decoded);
  if (img !== decoded) decoded.dispose();
  for (const q of [80, 60, 45, 30]) {
    const b64 = img.encodeToBase64(ImageFormat.WEBP, q);
    if (!b64 || b64.length < 8) throw new Error('WebP encoding is not available.');
    const frame = base64ToBytes(b64);
    const muxed = muxAnimatedWebp(
      [{ webp: frame, delayMs: 700 }, { webp: frame, delayMs: 700 }], SIZE, SIZE,
    );
    if (muxed.length <= ANIM_LIMIT) return bytesToBase64(muxed);
  }
  throw new Error('Sticker could not be compressed under WhatsApp’s 500 KB limit.');
}

// Decode our 512×512 GIF render and re-encode as animated WebP under 500 KB,
// dropping quality (and finally sampling every 2nd frame) until it fits.
export async function animatedWebpBase64(uri: string): Promise<string> {
  const data = await Skia.Data.fromURI(uri);
  const anim = Skia.AnimatedImage.MakeAnimatedImageFromEncoded(data);
  if (!anim) throw new Error('Could not decode the animated sticker.');
  try {
    const total = anim.getFrameCount();
    if (total <= 1) throw new Error('Not animated.');
    // Collect frames once as SkImages + delays.
    const frames: { img: SkImage; delayMs: number }[] = [];
    for (let i = 0; i < total; i++) {
      const d = anim.currentFrameDuration();
      if (d < 0) break;
      const frame = anim.getCurrentFrame();
      if (frame) {
        // Normalised here, once: the muxer writes a 512×512 canvas header, so a
        // frame of any other size would be composited against a canvas it does
        // not fill.
        const img = to512(frame);
        if (img !== frame) frame.dispose();
        frames.push({ img, delayMs: d });
      }
      if (i < total - 1 && anim.decodeNextFrame() < 0) break;
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    if (frames.length < 2) throw new Error('Not animated.');
    // Ten seconds is WhatsApp's ceiling. Our own renders already respect it, but a
    // sticker imported from another app's pack is stored byte-for-byte and can be
    // any length, so trim here too rather than hand over something it will refuse.
    //
    // Counted in the durations the MUXER will write, not the ones we were handed:
    // it floors every frame at 20ms, so an animation of 5ms frames measures as a
    // quarter of its real length and would sail past the limit.
    let ms = 0, keep = 0;
    while (keep < frames.length && ms + frameDurationMs(frames[keep].delayMs) <= MAX_ANIM_MS) {
      ms += frameDurationMs(frames[keep].delayMs);
      keep++;
    }
    // Two frames is the minimum that still counts as animated; if even those two
    // exceed the ceiling the delays are absurd, so cap them instead of giving up.
    if (keep < 2) {
      for (let i = 2; i < frames.length; i++) frames[i].img.dispose();
      frames.length = Math.min(2, frames.length);
      for (const f of frames) f.delayMs = Math.floor(MAX_ANIM_MS / frames.length);
    } else if (keep < frames.length) {
      for (let i = keep; i < frames.length; i++) frames[i].img.dispose();
      frames.length = keep;
    }
    try {
      const attempts: { q: number; step: number }[] = [
        { q: 80, step: 1 }, { q: 60, step: 1 }, { q: 40, step: 1 }, { q: 40, step: 2 }, { q: 25, step: 2 },
      ];
      for (const { q, step } of attempts) {
        const parts: WebpFrame[] = [];
        for (let i = 0; i < frames.length; i += step) {
          const b64 = frames[i].img.encodeToBase64(ImageFormat.WEBP, q);
          if (!b64 || b64.length < 8) throw new Error('WebP encoding is not available.');
          let delay = 0;
          for (let k = i; k < Math.min(i + step, frames.length); k++) delay += frames[k].delayMs;
          parts.push({ webp: base64ToBytes(b64), delayMs: delay });
          if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
        }
        const muxed = muxAnimatedWebp(parts, SIZE, SIZE);
        if (muxed.length <= ANIM_LIMIT) return bytesToBase64(muxed);
      }
      throw new Error('Animated sticker could not be compressed under WhatsApp’s 500 KB limit.');
    } finally {
      for (const f of frames) f.img.dispose();
    }
  } finally {
    anim.dispose();
  }
}

export async function trayPngBase64(uri: string): Promise<string> {
  const img = await loadSkImage(uri); // first frame for GIFs
  const surface = Skia.Surface.Make(96, 96);
  if (!surface) throw new Error('Could not render the tray icon.');
  surface.getCanvas().drawImageRect(
    img, Skia.XYWHRect(0, 0, img.width(), img.height()), Skia.XYWHRect(0, 0, 96, 96), Skia.Paint(),
  );
  const snap = surface.makeImageSnapshot();
  const b64 = snap.encodeToBase64(ImageFormat.PNG, 100);
  snap.dispose();
  surface.dispose();
  return b64;
}

// Builds the pasteboard JSON for a whole pack. If ANY sticker is animated the pack
// is exported as an animated pack, with still stickers wrapped as 2-frame
// animations — so mixed packs work in one go (like other sticker apps).
export async function buildWhatsAppPayload(
  pack: Pack, stickers: Sticker[], animated: boolean,
  onProgress?: (done: number, total: number) => void,
  trayUri?: string, // the pack's cover sticker; falls back to the first one
): Promise<string> {
  const images: { data: string; emojis: string[] }[] = [];
  for (let i = 0; i < stickers.length; i++) {
    const s = stickers[i];
    const data = !animated
      ? await staticWebpBase64(s.uri)
      : isAnimatedSticker(s)
        ? await animatedWebpBase64(s.uri)
        : await stillAsAnimatedWebpBase64(s.uri);
    // WhatsApp uses these to make a sticker findable in its search field.
    images.push({ data, emojis: s.emoji ? [s.emoji] : [] });
    onProgress?.(i + 1, stickers.length);
  }
  const payload = {
    identifier: `${pack.id}-${animated ? 'anim' : 'still'}`,
    name: clamp128(pack.name),
    publisher: clamp128(pack.author || 'Sticker Studio'),
    tray_image: await trayPngBase64(trayUri || stickers[0].uri),
    animated_sticker_pack: animated,
    ios_app_store_link: '',
    android_play_store_link: '',
    stickers: images.map((s) => ({ image_data: s.data, emojis: s.emojis })),
  };
  return JSON.stringify(payload);
}
