// .wastickers — the interchange format used by third-party sticker apps.
// A flat ZIP: title.txt, author.txt, cover.png (96x96 tray) and sticker-NN.webp.
// Supporting it both ways means packs made here open in other apps, and packs
// people already have can be brought in.
import JSZip from 'jszip';
import { File } from 'expo-file-system';
import type { Pack, Sticker } from './types';
import { PACK_MAX } from './types';
import { addSticker, createPack, ensurePackSlots, deletePack } from './db';
import { writeExport, writeTempBytes, deleteFile } from './storage';
import {
  staticWebpBase64, animatedWebpBase64, trayPngBase64, isAnimatedSticker,
} from './editor/whatsappExport';
import { base64ToBytes } from './editor/webpMux';
import { loadSkImage, renderCroppedPng } from './editor/renderCrop';
import { renderCroppedGif } from './editor/renderAnimated';

const safeName = (s: string) =>
  (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pack').slice(0, 40);

// ------------------------------------------------------------------ export
export async function exportWastickers(
  pack: Pack, stickers: Sticker[], coverUri?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  if (!stickers.length) throw new Error('This pack has no stickers yet.');
  const zip = new JSZip();
  zip.file('title.txt', (pack.name || 'Stickers').slice(0, 128));
  zip.file('author.txt', (pack.author || 'Sticker Studio').slice(0, 128));
  zip.file('cover.png', base64ToBytes(await trayPngBase64(coverUri || stickers[0].uri)));

  const list = stickers.slice(0, PACK_MAX);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const b64 = isAnimatedSticker(s)
      ? await animatedWebpBase64(s.uri)
      : await staticWebpBase64(s.uri);
    zip.file(`sticker-${String(i + 1).padStart(2, '0')}.webp`, base64ToBytes(b64));
    onProgress?.(i + 1, list.length);
  }

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return writeExport(bytes, `${safeName(pack.name)}.wastickers`);
}

// ------------------------------------------------------------------ import
export type WaImportResult = { name: string; stickers: number; skipped: number };

export async function importWastickers(
  uri: string, onProgress?: (done: number, total: number) => void,
): Promise<WaImportResult> {
  const zip = await JSZip.loadAsync(await new File(uri).bytes());

  const read = async (name: string) => {
    const f = zip.file(name);
    return f ? (await f.async('string')).trim() : '';
  };
  // Sticker files are sticker-01.webp…; accept any order/extension the zip uses.
  // Sort by the NUMBER, not the string: packs written without zero padding
  // ("sticker-2" … "sticker-10") would otherwise come out badly reordered.
  const numberOf = (n: string) => Number(n.match(/sticker[-_]?(\d+)\./i)?.[1] ?? 0);
  const entries = Object.keys(zip.files)
    .filter((n) => /(^|\/)sticker[-_]?\d+\.(webp|png|gif)$/i.test(n) && !zip.files[n].dir)
    .sort((a, b) => numberOf(a) - numberOf(b) || a.localeCompare(b));
  if (!entries.length) throw new Error('That file does not contain any stickers.');

  const title = (await read('title.txt')) || 'Imported pack';
  const author = await read('author.txt');
  const pack = await createPack(title, author);
  await ensurePackSlots(pack.id);

  let ok = 0, skipped = 0;
  for (let i = 0; i < Math.min(entries.length, PACK_MAX); i++) {
    onProgress?.(i + 1, Math.min(entries.length, PACK_MAX));
    const ext = (entries[i].match(/\.(\w{3,4})$/)?.[1] ?? 'webp').toLowerCase();
    let src = '';
    let render: string | null = null;
    try {
      src = await writeTempBytes(await zip.files[entries[i]].async('uint8array'), ext);
      // Re-render into our own canonical sticker (512 PNG, or GIF when animated),
      // using the whole image as the crop.
      const img = await loadSkImage(src);
      const crop = { x: 0, y: 0, width: img.width(), height: img.height() };
      try { render = await renderCroppedGif(src, crop); } catch { render = null; }
      if (!render) render = await renderCroppedPng(src, crop);
      await addSticker(pack.id, render, 512, 512, null, i);
      ok++;
    } catch {
      skipped++;
    } finally {
      if (render) await deleteFile(render);
      if (src) await deleteFile(src);
    }
  }
  // A pack where nothing could be decoded is junk — don't leave it behind.
  if (ok === 0) {
    await deletePack(pack.id);
    throw new Error('None of the stickers in that file could be read.');
  }
  return { name: pack.name, stickers: ok, skipped };
}

// Does this file look like a sticker pack we can read?
export function isWastickersFile(uri: string): boolean {
  return /\.wastickers(\?|$)/i.test(uri);
}
