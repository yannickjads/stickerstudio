// Telegram third-party sticker import.
// Payload shape and limits mirror Telegram's own SDK
// (github.com/TelegramMessenger/TelegramStickersImport):
//   pasteboard type org.telegram.third-party.stickerset -> tg://importStickers
//   static stickers are PNG (image/png), 512 on the long side, <= 512 KB
//   every sticker must carry at least one emoji
import { Skia, ImageFormat } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';
import type { Pack, Sticker } from '../types';
import { loadSkImage } from './renderCrop';
import { bytesToBase64 } from './webpMux';
import { isAnimatedSticker } from './whatsappExport';
import { imageKind } from './imageKind';

const SIZE = 512;
const STATIC_LIMIT = 512 * 1024;
export const TG_MAX_STICKERS = 120;
export const TG_DEFAULT_EMOJI = '😀';

// Telegram animates only TGS (vector) or WebM/VP9 — neither can be produced on
// device — so an animated sticker is sent as a still of its first frame.
async function stickerPngBase64(s: Sticker): Promise<string> {
  if (!isAnimatedSticker(s)) {
    const bytes = await new File(s.uri).bytes();
    // Only skip the re-encode when the file really IS a PNG. An imported sticker
    // is stored exactly as it arrived, which is usually WebP — sending those bytes
    // under a PNG label is a lie Telegram has every right to reject.
    if (imageKind(bytes) === 'png' && bytes.length <= STATIC_LIMIT) return bytesToBase64(bytes);
  }
  // Re-encode: first frame of a GIF, or a too-large PNG shrunk by re-encoding.
  const img = await loadSkImage(s.uri);
  const surface = Skia.Surface.Make(SIZE, SIZE);
  if (!surface) throw new Error('Could not render the sticker.');
  surface.getCanvas().drawImageRect(
    img,
    Skia.XYWHRect(0, 0, img.width(), img.height()),
    Skia.XYWHRect(0, 0, SIZE, SIZE),
    Skia.Paint(),
  );
  const snap = surface.makeImageSnapshot();
  const b64 = snap.encodeToBase64(ImageFormat.PNG, 100);
  snap.dispose();
  surface.dispose();
  return b64;
}

export type TelegramBuild = { json: string; animatedAsStill: number };

export async function buildTelegramPayload(
  pack: Pack, stickers: Sticker[],
  onProgress?: (done: number, total: number) => void,
  thumbUri?: string,
): Promise<TelegramBuild> {
  const list = stickers.slice(0, TG_MAX_STICKERS);
  const out: { data: string; mimeType: string; emojis: string[] }[] = [];
  let animatedAsStill = 0;

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (isAnimatedSticker(s)) animatedAsStill++;
    out.push({
      data: await stickerPngBase64(s),
      mimeType: 'image/png',
      emojis: [s.emoji || TG_DEFAULT_EMOJI],
    });
    onProgress?.(i + 1, list.length);
  }

  const payload: Record<string, unknown> = {
    software: 'Sticker Studio',
    isAnimated: false,
    isVideo: false,
    stickers: out,
  };
  if (thumbUri) {
    try { payload.thumbnail = await stickerPngBase64({ ...list[0], uri: thumbUri } as Sticker); } catch {}
  }
  return { json: JSON.stringify(payload), animatedAsStill };
}
