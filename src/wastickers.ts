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
import { imageKind, isAnimatedBytes, extensionFor } from './editor/imageKind';

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
    let src = '';
    try {
      const bytes = await zip.files[entries[i]].async('uint8array');
      // Store the file exactly as it came. A .wastickers pack is already WebP —
      // the format WhatsApp wants, that Skia decodes and the grid displays — so
      // decoding and re-encoding each sticker only burns time and quality.
      const kind = imageKind(bytes);
      if (kind === 'unknown') { skipped++; continue; }
      src = await writeTempBytes(bytes, extensionFor(kind));
      await addSticker(pack.id, src, 512, 512, null, i, isAnimatedBytes(bytes));
      ok++;
    } catch {
      skipped++;
    } finally {
      if (src) await deleteFile(src);
    }
    // Let the UI breathe between stickers.
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
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
