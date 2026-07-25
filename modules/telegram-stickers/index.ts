import { requireOptionalNativeModule } from 'expo-modules-core';

type NativeModule = {
  isTelegramInstalled(): Promise<boolean>;
  send(json: string): Promise<boolean>;
} | null;

const native = requireOptionalNativeModule<NonNullable<NativeModule>>('TelegramStickers');

export async function isTelegramInstalled(): Promise<boolean> {
  if (!native) return false;
  try { return await native.isTelegramInstalled(); } catch { return false; }
}

// json = Telegram third-party sticker-set payload (base64 image data inside).
export async function sendStickerSetToTelegram(json: string): Promise<boolean> {
  if (!native) throw new Error('Telegram module not available in this build.');
  return native.send(json);
}
