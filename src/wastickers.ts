// .wastickers — the interchange format used by third-party sticker apps.
// A flat ZIP: title.txt, author.txt, cover.png (96x96 tray) and sticker-NN.webp.
// Supporting it both ways means packs made here open in other apps, and packs
// people already have can be brought in.
import JSZip from 'jszip';
import { File } from 'expo-file-system';
import type { Pack, Sticker } from './types';
import { PACK_MAX } from './types';
import { addSticker, createPack, ensurePackSlots, deletePack, setPackTrayImage } from './db';
import { writeExport, writeTempBytes, deleteFile } from './storage';
import {
  staticWebpBase64, animatedWebpBase64, trayPngBase64, isAnimatedSticker,
} from './editor/whatsappExport';
import { base64ToBytes } from './editor/webpMux';
import { imageKind, isAnimatedBytes, extensionFor } from './editor/imageKind';
import { stickerEntries, trayEntries } from './packArchive';

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
// `dropped` is what didn't fit: a pack can hold 30, and quietly binning the rest
// would look like the import had simply lost them.
export type WaImportResult = {
  name: string; stickers: number; skipped: number; dropped: number;
  tray: boolean; // whether the archive's own icon was recognised and kept
};

const entriesOf = (zip: JSZip) =>
  stickerEntries(Object.keys(zip.files), (n) => zip.files[n].dir);

export async function importWastickers(
  uri: string, onProgress?: (done: number, total: number) => void,
): Promise<WaImportResult> {
  const zip = await JSZip.loadAsync(await new File(uri).bytes());

  const read = async (name: string) => {
    const f = zip.file(name);
    return f ? (await f.async('string')).trim() : '';
  };
  const entries = entriesOf(zip);
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

  // The tray icon travels with the pack and is NOT one of its stickers, so keep it
  // as the pack's own icon rather than dropping it on the floor (or, worse,
  // importing it as sticker 1 and spending a slot on it).
  let tray = false;
  const trayName = trayEntries(Object.keys(zip.files), (n) => zip.files[n].dir)[0];
  if (trayName) {
    let tmp = '';
    try {
      const bytes = await zip.files[trayName].async('uint8array');
      const kind = imageKind(bytes);
      if (kind !== 'unknown') {
        tmp = await writeTempBytes(bytes, extensionFor(kind));
        await setPackTrayImage(pack.id, tmp);
        tray = true;
      }
    } catch (e) {
      console.warn('could not keep the pack icon from that file:', e);
    } finally {
      if (tmp) await deleteFile(tmp);
    }
  }
  return { name: pack.name, stickers: ok, skipped, tray, dropped: Math.max(0, entries.length - PACK_MAX) };
}

// Does this file look like a sticker pack we can read?
export function isWastickersFile(uri: string): boolean {
  return /\.wastickers(\?|$)/i.test(uri);
}

export type ArchiveKind = 'backup' | 'stickers' | 'unknown';

/**
 * What is actually inside the file, regardless of what it is called.
 *
 * Sharing a pack out of another app hands us whatever extension that app chose —
 * the share sheet shows it as a plain "Archive" — so routing on the extension
 * sent perfectly good packs to the backup reader and vice versa. Open it and look.
 */
export async function archiveKind(uri: string): Promise<ArchiveKind> {
  try {
    const zip = await JSZip.loadAsync(await new File(uri).bytes());
    if (zip.file('manifest.json')) return 'backup';
    return entriesOf(zip).length ? 'stickers' : 'unknown';
  } catch {
    return 'unknown';
  }
}
