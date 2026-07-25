// Offscreen Skia render of a crop: source rect -> contained box in a 512×512
// transparent canvas, with an optional shape mask (circle / rounded / squircle).
// Exactly mirrors how ImageLayerView draws the layer (fit 'contain' + mask), so the
// flattened PNG always matches the editor.
import { Skia, ClipOp, ImageFormat, type SkImage } from '@shopify/react-native-skia';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { MaskShape } from '../types';
import { fitSize, maskRadius, type Rect } from './geometry';
import { writeTempPng, deleteFile } from '../storage';

export const STICKER_SIZE = 512;

async function tryDecode(uri: string): Promise<SkImage | null> {
  try {
    const data = await Skia.Data.fromURI(uri);
    return Skia.Image.MakeImageFromEncoded(data);
  } catch {
    return null;
  }
}

// Decode any image into an SkImage. Skia can't read HEIC (default iPhone format),
// so fall back to transcoding via the image manipulator.
export async function loadSkImage(uri: string): Promise<SkImage> {
  const direct = await tryDecode(uri);
  if (direct) return direct;
  const r = await manipulateAsync(uri, [], { compress: 0.95, format: SaveFormat.JPEG });
  const im = await tryDecode(r.uri);
  await deleteFile(r.uri);
  if (!im) throw new Error('This image format is not supported.');
  return im;
}

// Return a uri Skia can decode — transcodes HEIC & friends once, at import time,
// so stored assets are always directly usable.
export async function ensureDecodableUri(uri: string): Promise<string> {
  if (await tryDecode(uri)) return uri;
  const r = await manipulateAsync(uri, [], { compress: 0.95, format: SaveFormat.JPEG });
  return r.uri;
}

export async function renderCroppedPng(
  srcUri: string, crop: Rect, mask?: MaskShape,
): Promise<string> {
  const image = await loadSkImage(srcUri);

  const surface = Skia.Surface.Make(STICKER_SIZE, STICKER_SIZE);
  if (!surface) throw new Error('Could not create a canvas.');
  const canvas = surface.getCanvas();

  const { dw, dh } = fitSize(crop.width, crop.height, STICKER_SIZE, STICKER_SIZE, 'contain');
  const dst = Skia.XYWHRect((STICKER_SIZE - dw) / 2, (STICKER_SIZE - dh) / 2, dw, dh);
  const src = Skia.XYWHRect(crop.x, crop.y, crop.width, crop.height);

  const r = maskRadius(mask, dw, dh);
  if (r > 0) canvas.clipRRect(Skia.RRectXY(dst, r, r), ClipOp.Intersect, true);
  canvas.drawImageRect(image, src, dst, Skia.Paint());

  const snap = surface.makeImageSnapshot();
  const b64 = snap.encodeToBase64(ImageFormat.PNG, 100);
  return writeTempPng(b64);
}
