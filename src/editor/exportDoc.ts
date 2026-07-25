import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { ImageFormat, type SkImage } from '@shopify/react-native-skia';
import { writeTempPng, deleteFile } from '../storage';

// A Skia canvas snapshot -> exact size×size transparent PNG. Returns a temp uri
// (caller persists it via updateStickerImage, then deletes it).
export async function snapshotToPng(snapshot: SkImage, size: number): Promise<string> {
  const b64 = snapshot.encodeToBase64(ImageFormat.PNG, 100);
  const tmp = await writeTempPng(b64);
  try {
    const r = await manipulateAsync(tmp, [{ resize: { width: size, height: size } }], {
      compress: 1, format: SaveFormat.PNG,
    });
    return r.uri;
  } finally {
    await deleteFile(tmp);
  }
}
