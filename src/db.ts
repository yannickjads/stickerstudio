// SQLite repository for packs & stickers (metadata). PNG blobs live on disk (storage.ts).
import * as SQLite from 'expo-sqlite';
import type { Pack, Sticker, Asset, EditorDocument } from './types';
import { PACK_MAX } from './types';
import { newId, saveRender, saveAsset, deleteRender, deleteFile, toAbs, toRel } from './storage';

const SCHEMA_VERSION = 5;

// Rows store paths relative to the studio dir (see storage.ts) — resolve on read.
const mapSticker = (s: Sticker): Sticker => ({ ...s, uri: toAbs(s.uri) });
const mapAsset = (a: Asset): Asset => ({ ...a, localUri: toAbs(a.localUri) });

let dbP: Promise<SQLite.SQLiteDatabase> | null = null;
function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbP) {
    dbP = (async () => {
      const d = await SQLite.openDatabaseAsync('stickerstudio.db');
      await d.execAsync(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
      const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      const version = row?.user_version ?? 0;
      if (version < 1) {
        await d.execAsync(`
          CREATE TABLE IF NOT EXISTS packs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            coverStickerId TEXT,
            sortIndex REAL NOT NULL,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS stickers (
            id TEXT PRIMARY KEY,
            packId TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
            uri TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            sortIndex REAL NOT NULL,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers(packId);
        `);
      }
      if (version < 3 && version >= 1) {
        // v3: pack author (for WhatsApp pack metadata). Fresh installs get it via v1 below.
        try { await d.execAsync(`ALTER TABLE packs ADD COLUMN author TEXT NOT NULL DEFAULT ''`); } catch {}
      }
      if (version < 2) {
        // P2: non-destructive edit model — source assets + per-sticker documents.
        await d.execAsync(`
          ALTER TABLE stickers ADD COLUMN documentId TEXT;
          CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            localUri TEXT NOT NULL,
            originalUri TEXT,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            createdAt INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            schemaVersion INTEGER NOT NULL,
            json TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
          );
        `);
      }
      if (version < 4) {
        // v4: iOS reassigns the app's container UUID on every reinstall, so absolute
        // paths written by an earlier install are dead ("grey" stickers). Rewrite
        // every stored path to be relative to the studio dir; the files themselves
        // are untouched and become reachable again.
        await d.execAsync(`
          UPDATE stickers SET uri = substr(uri, instr(uri, 'studio/') + 7)
            WHERE instr(uri, 'studio/') > 0;
          UPDATE assets SET localUri = substr(localUri, instr(localUri, 'studio/') + 7)
            WHERE instr(localUri, 'studio/') > 0;
        `);
      }
      if (version < 5) {
        // v5: an emoji per sticker. Telegram requires at least one; WhatsApp uses
        // them to make stickers searchable.
        try { await d.execAsync(`ALTER TABLE stickers ADD COLUMN emoji TEXT NOT NULL DEFAULT ''`); } catch {}
      }
      await d.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      return d;
    })();
  }
  return dbP;
}

const STEP = 1000;
const ORDER = 'sortIndex ASC, createdAt ASC, id ASC';

// -------------------------------------------------------------- packs
export async function listPacks(): Promise<Pack[]> {
  const d = await db();
  // Cover = the sticker the user picked, else the first one in the pack.
  // Two separate lookups on purpose: SQLite does NOT resolve an outer column
  // (p.coverStickerId) inside a subquery's ORDER BY — doing so throws
  // "no such column" and takes the whole screen down with it.
  const rows = await d.getAllAsync<Pack>(`
    SELECT p.*,
      (SELECT COUNT(*) FROM stickers s WHERE s.packId = p.id) AS count,
      COALESCE(
        (SELECT sc.uri FROM stickers sc WHERE sc.id = p.coverStickerId AND sc.packId = p.id),
        (SELECT s2.uri FROM stickers s2 WHERE s2.packId = p.id ORDER BY s2.${ORDER} LIMIT 1)
      ) AS cover
    FROM packs p
    ORDER BY p.${ORDER}
  `);
  return rows.map((p) => ({ ...p, cover: p.cover ? toAbs(p.cover) : null }));
}

export async function getPack(id: string): Promise<Pack | null> {
  const d = await db();
  return (await d.getFirstAsync<Pack>(`SELECT * FROM packs WHERE id=?`, [id])) ?? null;
}

export async function createPack(name: string, author = ''): Promise<Pack> {
  const d = await db();
  const now = Date.now();
  const row = await d.getFirstAsync<{ m: number }>(`SELECT COALESCE(MAX(sortIndex), 0) AS m FROM packs`);
  const pack: Pack = {
    id: newId(), name: name.trim() || 'New pack', author: author.trim(), coverStickerId: null,
    sortIndex: (row?.m ?? 0) + STEP, createdAt: now, updatedAt: now,
  };
  await d.runAsync(
    `INSERT INTO packs (id,name,author,coverStickerId,sortIndex,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`,
    [pack.id, pack.name, pack.author, null, pack.sortIndex, now, now],
  );
  return pack;
}

// One emoji per sticker: Telegram requires at least one, WhatsApp searches by it.
export async function setStickerEmoji(stickerId: string, emoji: string): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE stickers SET emoji=?, updatedAt=? WHERE id=?`,
    [Array.from(emoji.trim())[0] ?? '', Date.now(), stickerId]);
}

// The pack's tray/cover icon. Set once, reused by the pack grid, WhatsApp's tray,
// Telegram's thumbnail and .wastickers' cover.png — never asked at export time.
export async function setPackCover(packId: string, stickerId: string | null): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE packs SET coverStickerId=?, updatedAt=? WHERE id=?`,
    [stickerId, Date.now(), packId]);
}

// Sticker to use as the pack's icon: the chosen one, else the first in the pack.
// Deliberately two plain queries rather than a JOIN — joining packs and stickers
// makes `createdAt` (and `id`) ambiguous in the shared ORDER clause.
export async function getPackCoverSticker(packId: string): Promise<Sticker | null> {
  const d = await db();
  const pack = await d.getFirstAsync<{ coverStickerId: string | null }>(
    `SELECT coverStickerId FROM packs WHERE id=?`, [packId],
  );
  if (pack?.coverStickerId) {
    const chosen = await d.getFirstAsync<Sticker>(
      `SELECT * FROM stickers WHERE id=? AND packId=?`, [pack.coverStickerId, packId],
    );
    if (chosen) return mapSticker(chosen);
  }
  const first = await d.getFirstAsync<Sticker>(
    `SELECT * FROM stickers WHERE packId=? ORDER BY ${ORDER} LIMIT 1`, [packId],
  );
  return first ? mapSticker(first) : null;
}

export async function updatePack(id: string, name: string, author: string): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE packs SET name=?, author=?, updatedAt=? WHERE id=?`,
    [name.trim() || 'Untitled', author.trim(), Date.now(), id]);
}

export async function deletePack(id: string): Promise<void> {
  const d = await db();
  const stickers = await d.getAllAsync<Sticker>(`SELECT uri, documentId FROM stickers WHERE packId=?`, [id]);
  await d.runAsync(`DELETE FROM packs WHERE id=?`, [id]); // stickers cascade
  for (const s of stickers) {                              // best-effort file + doc/asset cleanup
    await deleteRender(toAbs(s.uri));
    await deleteDocumentAndAssets(s.documentId);
  }
}

export async function duplicatePack(id: string): Promise<Pack> {
  const d = await db();
  const src = await d.getFirstAsync<Pack>(`SELECT * FROM packs WHERE id=?`, [id]);
  if (!src) throw new Error('Pack not found');
  const copy = await createPack(`${src.name} copy`, src.author);
  const stickers = await d.getAllAsync<Sticker>(`SELECT * FROM stickers WHERE packId=? ORDER BY ${ORDER}`, [id]);
  const copiedFiles: string[] = [];
  const copiedDocs: string[] = [];
  try {
    for (const s of stickers) {
      const nid = newId();
      const uri = await saveRender(toAbs(s.uri), nid);
      copiedFiles.push(uri);
      // deep-copy the editable document (assets + layers) so the copy stays editable
      const newDocId = s.documentId ? await cloneDocumentDeep(s.documentId) : null;
      if (newDocId) copiedDocs.push(newDocId);
      const now = Date.now();
      await d.runAsync(
        `INSERT INTO stickers (id,packId,uri,documentId,width,height,sortIndex,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`,
        [nid, copy.id, toRel(uri), newDocId, s.width, s.height, s.sortIndex, now, now],
      );
    }
    return copy;
  } catch (e) {
    // roll back: remove the copy pack (cascades rows) + its copied files + cloned docs/assets
    await d.runAsync(`DELETE FROM packs WHERE id=?`, [copy.id]);
    for (const f of copiedFiles) await deleteRender(f);
    for (const docId of copiedDocs) await deleteDocumentAndAssets(docId);
    throw e;
  }
}

export async function reorderPacks(orderedIds: string[]): Promise<void> {
  const d = await db();
  await d.withExclusiveTransactionAsync(async (txn) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await txn.runAsync(`UPDATE packs SET sortIndex=? WHERE id=?`, [(i + 1) * STEP, orderedIds[i]]);
    }
  });
}

// -------------------------------------------------------------- stickers
export async function listStickers(packId: string): Promise<Sticker[]> {
  const d = await db();
  const rows = await d.getAllAsync<Sticker>(`SELECT * FROM stickers WHERE packId=? ORDER BY ${ORDER}`, [packId]);
  return rows.map(mapSticker);
}

export async function countStickers(packId: string): Promise<number> {
  const d = await db();
  const row = await d.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM stickers WHERE packId=?`, [packId]);
  return row?.n ?? 0;
}

// Stickers occupy fixed slots 0..PACK_MAX-1 (sortIndex = slot). Legacy rows used
// STEP-based sortIndexes — normalize them once into compact slots.
export async function ensurePackSlots(packId: string): Promise<void> {
  const d = await db();
  const rows = await d.getAllAsync<Sticker>(`SELECT * FROM stickers WHERE packId=? ORDER BY ${ORDER}`, [packId]);
  const used = new Set<number>();
  let needs = false;
  for (const s of rows) {
    if (!Number.isInteger(s.sortIndex) || s.sortIndex < 0 || s.sortIndex >= PACK_MAX || used.has(s.sortIndex)) { needs = true; break; }
    used.add(s.sortIndex);
  }
  if (!needs) return;
  await d.withExclusiveTransactionAsync(async (txn) => {
    for (let i = 0; i < rows.length; i++) {
      await txn.runAsync(`UPDATE stickers SET sortIndex=? WHERE id=?`, [i, rows[i].id]);
    }
  });
}

// Free slot numbers (ascending) for a pack.
export async function freeSlots(packId: string): Promise<number[]> {
  const d = await db();
  const rows = await d.getAllAsync<{ sortIndex: number }>(`SELECT sortIndex FROM stickers WHERE packId=?`, [packId]);
  const used = new Set(rows.map((r) => r.sortIndex));
  return Array.from({ length: PACK_MAX }, (_, i) => i).filter((i) => !used.has(i));
}

export async function addSticker(
  packId: string, permanentUri: string, width: number, height: number,
  documentId: string | null = null, slot: number | null = null,
): Promise<Sticker> {
  const d = await db();
  const id = newId();
  const now = Date.now();
  // Fixed-slot model: use the requested slot if it's free, else the first free slot.
  const free = await freeSlots(packId);
  if (free.length === 0) throw new Error('This pack is full.');
  const useSlot = slot != null && free.includes(slot) ? slot : free[0];
  const uri = await saveRender(permanentUri, id); // copy temp render -> permanent
  const sticker: Sticker = { id, packId, uri, documentId, emoji: '', width, height, sortIndex: useSlot, createdAt: now, updatedAt: now };
  try {
    await d.runAsync(
      `INSERT INTO stickers (id,packId,uri,documentId,width,height,sortIndex,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, packId, toRel(uri), documentId, width, height, sticker.sortIndex, now, now],
    );
    await d.runAsync(`UPDATE packs SET updatedAt=? WHERE id=?`, [now, packId]);
  } catch (e) {
    await deleteRender(uri); // don't orphan the file if the insert failed
    throw e;
  }
  return sticker;
}

// -------------------------------------------------------------- assets & documents (P2)
export async function getSticker(id: string): Promise<Sticker | null> {
  const d = await db();
  const r = await d.getFirstAsync<Sticker>(`SELECT * FROM stickers WHERE id=?`, [id]);
  return r ? mapSticker(r) : null;
}

export async function getAsset(id: string): Promise<Asset | null> {
  const d = await db();
  const r = await d.getFirstAsync<Asset>(`SELECT * FROM assets WHERE id=?`, [id]);
  return r ? mapAsset(r) : null;
}

// Replace a sticker's rendered PNG (after an edit). Writes a fresh file, swaps the
// uri, then deletes the old one — a new path busts any <Image> uri cache.
export async function updateStickerImage(
  stickerId: string, newTempUri: string, width: number, height: number,
): Promise<void> {
  const d = await db();
  const s = await d.getFirstAsync<Sticker>(`SELECT * FROM stickers WHERE id=?`, [stickerId]);
  if (!s) throw new Error('Sticker not found');
  const newUri = await saveRender(newTempUri, newId());
  const now = Date.now();
  try {
    await d.runAsync(`UPDATE stickers SET uri=?, width=?, height=?, updatedAt=? WHERE id=?`,
      [toRel(newUri), width, height, now, stickerId]);
    await d.runAsync(`UPDATE packs SET updatedAt=? WHERE id=?`, [now, s.packId]);
  } catch (e) {
    await deleteRender(newUri);
    throw e;
  }
  const oldUri = toAbs(s.uri);
  if (newUri !== oldUri) await deleteRender(oldUri); // drop the stale render
}

export async function createAsset(sourceUri: string, width: number, height: number): Promise<Asset> {
  const d = await db();
  const id = newId();
  const localUri = await saveAsset(sourceUri, id); // permanent copy of the source image
  const now = Date.now();
  const asset: Asset = { id, kind: 'image', localUri, originalUri: sourceUri, width, height, createdAt: now };
  try {
    await d.runAsync(
      `INSERT INTO assets (id,kind,localUri,originalUri,width,height,createdAt) VALUES (?,?,?,?,?,?,?)`,
      [id, 'image', toRel(localUri), sourceUri, width, height, now],
    );
  } catch (e) {
    await deleteFile(localUri);
    throw e;
  }
  return asset;
}

export async function createDocument(doc: EditorDocument): Promise<void> {
  const d = await db();
  await d.runAsync(
    `INSERT INTO documents (id,schemaVersion,json,createdAt,updatedAt) VALUES (?,?,?,?,?)`,
    [doc.id, doc.schemaVersion, JSON.stringify(doc), doc.createdAt, doc.updatedAt],
  );
}

export async function linkStickerDocument(stickerId: string, documentId: string): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE stickers SET documentId=? WHERE id=?`, [documentId, stickerId]);
}

export async function getDocument(id: string): Promise<EditorDocument | null> {
  const d = await db();
  const row = await d.getFirstAsync<{ json: string }>(`SELECT json FROM documents WHERE id=?`, [id]);
  return row ? (JSON.parse(row.json) as EditorDocument) : null;
}

export async function updateDocument(doc: EditorDocument): Promise<void> {
  const d = await db();
  const now = Date.now();
  await d.runAsync(`UPDATE documents SET json=?, updatedAt=? WHERE id=?`, [JSON.stringify({ ...doc, updatedAt: now }), now, doc.id]);
}

export async function deleteSticker(id: string): Promise<void> {
  const d = await db();
  const s = await d.getFirstAsync<Sticker>(`SELECT * FROM stickers WHERE id=?`, [id]);
  await d.runAsync(`DELETE FROM stickers WHERE id=?`, [id]); // row first
  if (s) {
    await d.runAsync(`UPDATE packs SET updatedAt=? WHERE id=?`, [Date.now(), s.packId]);
    await deleteRender(toAbs(s.uri));             // then best-effort render file
    await deleteDocumentAndAssets(s.documentId);  // and the editable doc + its source assets
  }
}

// Delete a document row plus every source asset (row + file) it references.
// Assets are private per-document (createAsset/cloneDocumentDeep always copy), so this is safe.
export async function deleteDocumentAndAssets(documentId: string | null): Promise<void> {
  if (!documentId) return;
  const d = await db();
  const doc = await getDocument(documentId);
  if (doc) {
    const assetIds = new Set<string>();
    for (const l of doc.layers) if (l.type === 'image') assetIds.add(l.assetId);
    for (const aid of assetIds) {
      const a = await d.getFirstAsync<Asset>(`SELECT * FROM assets WHERE id=?`, [aid]);
      await d.runAsync(`DELETE FROM assets WHERE id=?`, [aid]);
      if (a) await deleteFile(toAbs(a.localUri));
    }
  }
  await d.runAsync(`DELETE FROM documents WHERE id=?`, [documentId]);
}

// Remove a single asset row + file (idempotent; used for orphan cleanup when a
// document row was never created).
export async function deleteAssetById(id: string): Promise<void> {
  const d = await db();
  const a = await d.getFirstAsync<Asset>(`SELECT * FROM assets WHERE id=?`, [id]);
  await d.runAsync(`DELETE FROM assets WHERE id=?`, [id]);
  if (a) await deleteFile(toAbs(a.localUri));
}

// Deep-copy a document: clone each referenced asset (new row + copied file), remap
// assetIds in the layers, and create a fresh document. Returns the new document id.
export async function cloneDocumentDeep(srcDocId: string): Promise<string> {
  const d = await db();
  const src = await getDocument(srcDocId);
  if (!src) throw new Error('Document not found');
  const now = Date.now();
  const assetMap: Record<string, string> = {};
  const createdFiles: string[] = [];
  const createdAssetIds: string[] = [];
  try {
    const ids = new Set<string>();
    for (const l of src.layers) if (l.type === 'image') ids.add(l.assetId);
    for (const aid of ids) {
      const a = await d.getFirstAsync<Asset>(`SELECT * FROM assets WHERE id=?`, [aid]);
      if (!a) continue;
      const nid = newId();
      const localUri = await saveAsset(toAbs(a.localUri), nid); // copy the source file
      createdFiles.push(localUri); createdAssetIds.push(nid);
      await d.runAsync(
        `INSERT INTO assets (id,kind,localUri,originalUri,width,height,createdAt) VALUES (?,?,?,?,?,?,?)`,
        [nid, a.kind, toRel(localUri), a.originalUri, a.width, a.height, now],
      );
      assetMap[aid] = nid;
    }
    const layers = src.layers.map((l) => (l.type === 'image' ? { ...l, assetId: assetMap[l.assetId] ?? l.assetId } : l));
    const newDoc: EditorDocument = { ...src, id: newId(), layers, createdAt: now, updatedAt: now };
    await createDocument(newDoc);
    return newDoc.id;
  } catch (e) {
    for (const aid of createdAssetIds) { try { await d.runAsync(`DELETE FROM assets WHERE id=?`, [aid]); } catch {} }
    for (const f of createdFiles) await deleteFile(f);
    throw e;
  }
}

export async function reorderStickers(packId: string, orderedIds: string[]): Promise<void> {
  const d = await db();
  await d.withExclusiveTransactionAsync(async (txn) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await txn.runAsync(`UPDATE stickers SET sortIndex=? WHERE id=? AND packId=?`, [(i + 1) * STEP, orderedIds[i], packId]);
    }
  });
}
