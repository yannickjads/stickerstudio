// Pack backup: export packs to a .zip you can keep anywhere (Files, iCloud,
// AirDrop) and load back later — on this phone or a new one. Deliberately stores
// the finished sticker images plus a small manifest, so a restore always produces
// exactly the pack you exported, at a size that's practical to share.
import JSZip from 'jszip';
import { File } from 'expo-file-system';
import type { Pack, Sticker } from './types';
import { PACK_MAX } from './types';
import {
  listPacks, listStickers, createPack, addSticker, ensurePackSlots,
  setStickerEmoji, setPackCover, deletePack,
} from './db';
import { writeTempBytes, writeExport, deleteFile } from './storage';

export const BACKUP_VERSION = 1;

// Everything here describes CONTENT, never app state. A restore should add packs
// and nothing else — a backup that quietly changes unrelated settings is the kind
// of surprise that makes people distrust restores.
// Every field added after v1 must be optional on read, so old backups keep working.
type ManifestSticker = {
  file: string; slot: number; width: number; height: number;
  emoji?: string; createdAt?: number; animated?: boolean;
};
type ManifestPack = {
  name: string; author: string; createdAt?: number;
  coverFile?: string; // which sticker is the pack icon
  stickers: ManifestSticker[];
};
type Manifest = { app: 'sticker-studio'; version: number; exportedAt: number; packs: ManifestPack[] };

const extOf = (uri: string) => {
  const m = uri.match(/\.(\w{2,5})(?:\?|$)/);
  return (m ? m[1] : 'png').toLowerCase();
};

// ------------------------------------------------------------------ export
export async function exportPacksToZip(
  packs: Pack[], onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const zip = new JSZip();
  const folder = zip.folder('stickers')!;
  const manifest: Manifest = {
    app: 'sticker-studio', version: BACKUP_VERSION, exportedAt: Date.now(), packs: [],
  };

  let done = 0;
  const total = (await Promise.all(packs.map((p) => listStickers(p.id))))
    .reduce((n, l) => n + l.length, 0);

  for (const p of packs) {
    const stickers = await listStickers(p.id);
    const entry: ManifestPack = { name: p.name, author: p.author, createdAt: p.createdAt, stickers: [] };
    for (const s of stickers) {
      const ext = extOf(s.uri);
      const name = `${s.id}.${ext}`;
      const f = new File(s.uri);
      if (!f.exists) continue; // skip anything whose file went missing
      folder.file(name, await f.bytes());
      entry.stickers.push({
        file: name, slot: s.sortIndex, width: s.width, height: s.height,
        emoji: s.emoji || undefined, createdAt: s.createdAt, animated: ext === 'gif',
      });
      if (p.coverStickerId === s.id) entry.coverFile = name;
      onProgress?.(++done, total);
    }
    manifest.packs.push(entry);
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  // Date AND time, so several backups on the same day never look identical.
  const stamp = new Date(manifest.exportedAt).toISOString()
    .slice(0, 19).replace('T', '-').replace(/:/g, '');
  const label = packs.length === 1 ? safeName(packs[0].name) : 'all-packs';
  return writeExport(bytes, `stickerstudio-${label}-${stamp}.zip`);
}

export async function exportAllPacks(onProgress?: (d: number, t: number) => void): Promise<string> {
  const packs = await listPacks();
  if (!packs.length) throw new Error('There are no packs to back up yet.');
  return exportPacksToZip(packs, onProgress);
}

// ------------------------------------------------------------------ import
export type ImportResult = { packs: number; stickers: number; skipped: number };

export async function importPacksFromZip(
  uri: string, onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const src = new File(uri);
  const zip = await JSZip.loadAsync(await src.bytes());

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('That zip is not a Sticker Studio backup.');
  const manifest = JSON.parse(await manifestFile.async('string')) as Manifest;
  if (manifest.app !== 'sticker-studio' || !Array.isArray(manifest.packs)) {
    throw new Error('That zip is not a Sticker Studio backup.');
  }
  if (manifest.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of Sticker Studio.');
  }

  const total = manifest.packs.reduce((n, p) => n + p.stickers.length, 0);
  let done = 0, restored = 0, skipped = 0;

  let packsMade = 0;
  for (const mp of manifest.packs) {
    const pack = await createPack(mp.name, mp.author ?? '');
    await ensurePackSlots(pack.id);
    let inThisPack = 0;
    for (const ms of mp.stickers.slice(0, PACK_MAX)) {
      const entry = zip.file(`stickers/${ms.file}`);
      onProgress?.(++done, total);
      if (!entry) { skipped++; continue; }
      // Land the bytes on disk first, then let the repository own the copy.
      let tmp = '';
      try {
        tmp = await writeTempBytes(await entry.async('uint8array'), extOf(ms.file));
        const added = await addSticker(pack.id, tmp, ms.width || 512, ms.height || 512, null,
          Number.isInteger(ms.slot) ? ms.slot : null);
        if (ms.emoji) await setStickerEmoji(added.id, ms.emoji);
        if (mp.coverFile === ms.file) await setPackCover(pack.id, added.id);
        restored++; inThisPack++;
      } catch {
        // One unreadable sticker must not abort the whole restore.
        skipped++;
      } finally {
        if (tmp) await deleteFile(tmp);
      }
    }
    // Don't leave an empty shell behind if nothing in it could be read.
    if (inThisPack === 0) await deletePack(pack.id);
    else packsMade++;
  }
  return { packs: packsMade, stickers: restored, skipped };
}

// ------------------------------------------------------------------ helpers
function safeName(s: string): string {
  return (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pack').slice(0, 40);
}
