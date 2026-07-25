import { requireOptionalNativeModule } from 'expo-modules-core';

type NativeModule = {
  isWhatsAppInstalled(): Promise<boolean>;
  send(json: string): Promise<boolean>;
} | null;

const native = requireOptionalNativeModule<NonNullable<NativeModule>>('WhatsAppStickers');

export async function isWhatsAppInstalled(): Promise<boolean> {
  if (!native) return false;
  try { return await native.isWhatsAppInstalled(); } catch { return false; }
}

// json = WhatsApp third-party sticker-pack payload (already base64-encoded images).
export async function sendStickerPackToWhatsApp(json: string): Promise<boolean> {
  if (!native) throw new Error('WhatsApp module not available in this build.');
  return native.send(json);
}
