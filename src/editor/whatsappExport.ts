// Build a WhatsApp third-party sticker-pack payload from a pack's stickers.
// WhatsApp requirements (github.com/WhatsApp/stickers):
//   static sticker: 512×512 WebP ≤ 100 KB · animated: animated WebP ≤ 500 KB
//   tray icon: 96×96 PNG ≤ 50 KB · pack: 3..30 stickers, uniform static/animated
import { Skia, ImageFormat, type SkImage } from '@shopify/react-native-skia';
import type { Pack, Sticker } from '../types';
import { loadSkImage } from './renderCrop';
import { muxAnimatedWebp, base64ToBytes, bytesToBase64, type WebpFrame } from './webpMux';

const STATIC_LIMIT = 100 * 1024;
const ANIM_LIMIT = 500 * 1024;
const SIZE = 512;

export const WA_MIN_STICKERS = 3;

export function isAnimatedSticker(s: Sticker): boolean {
  // Recorded when the sticker was made, from the file's own bytes.
  return s.animated || s.uri.toLowerCase().endsWith('.gif');
}

const b64Bytes = (b64: string) => Math.floor(b64.length * 3 / 4);

export async function staticWebpBase64(uri: string): Promise<string> {
  const img = await loadSkImage(uri);
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
async function stillAsAnimatedWebpBase64(uri: string): Promise<string> {
  const img = await loadSkImage(uri);
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
      const img = anim.getCurrentFrame();
      if (img) frames.push({ img, delayMs: d });
      if (i < total - 1 && anim.decodeNextFrame() < 0) break;
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    if (frames.length < 2) throw new Error('Not animated.');
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
    name: pack.name.slice(0, 128),
    publisher: (pack.author || 'Sticker Studio').slice(0, 128),
    tray_image: await trayPngBase64(trayUri || stickers[0].uri),
    animated_sticker_pack: animated,
    ios_app_store_link: '',
    android_play_store_link: '',
    stickers: images.map((s) => ({ image_data: s.data, emojis: s.emojis })),
  };
  return JSON.stringify(payload);
}
