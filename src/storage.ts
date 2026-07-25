// File-system storage for sticker PNGs. Uses the stable legacy expo-file-system API.
import {
  documentDirectory, makeDirectoryAsync, copyAsync, deleteAsync, getInfoAsync,
  writeAsStringAsync, EncodingType, readDirectoryAsync,
} from 'expo-file-system/legacy';
import { File } from 'expo-file-system';

const ROOT = `${documentDirectory}studio/`;
const RENDERS = `${ROOT}renders/`;
const ASSETS = `${ROOT}assets/`;
const EXPORTS = `${ROOT}exports/`; // backup zips staged for the share sheet

let ready: Promise<void> | null = null;
export function initStorage(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      for (const dir of [ROOT, RENDERS, ASSETS, EXPORTS]) {
        const info = await getInfoAsync(dir);
        if (!info.exists) await makeDirectoryAsync(dir, { intermediates: true });
      }
      // Sweep temp files a previous run left behind (crash / interrupted export).
      try {
        const entries = await readDirectoryAsync(ROOT);
        for (const name of entries) {
          if (name.startsWith('tmp-')) await deleteFile(`${ROOT}${name}`);
        }
      } catch {
        // best-effort
      }
    })();
  }
  return ready;
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------- path model
// iOS changes the app's container UUID on every reinstall/update, so an absolute
// path saved by a previous install points at a directory that no longer exists.
// Everything persisted (DB rows) therefore stores paths RELATIVE to the studio
// dir ("renders/x.png"), resolved against the CURRENT container when read.
const MARK = 'studio/';

export function toRel(uri: string | null | undefined): string {
  if (!uri) return '';
  const i = uri.lastIndexOf(MARK);
  return i >= 0 ? uri.slice(i + MARK.length) : uri;
}

export function toAbs(path: string | null | undefined): string {
  if (!path) return '';
  const i = path.lastIndexOf(MARK);
  if (i >= 0) return `${ROOT}${path.slice(i + MARK.length)}`; // heals stale absolutes
  if (path.startsWith('file://') || path.startsWith('/')) return path; // foreign file, leave as-is
  return `${ROOT}${path}`;
}

// Copy a (temporary) rendered file into permanent app storage, preserving its
// extension (renders are .png for static stickers, .gif for animated ones).
export async function saveRender(fromUri: string, id: string): Promise<string> {
  await initStorage();
  const m = fromUri.match(/\.(\w{2,5})(?:\?|$)/);
  const ext = (m ? m[1] : 'png').toLowerCase();
  const dest = `${RENDERS}${id}.${ext}`;
  await copyAsync({ from: fromUri, to: dest });
  return dest;
}

// Copy an imported source image into permanent asset storage, preserving extension.
export async function saveAsset(fromUri: string, id: string): Promise<string> {
  await initStorage();
  const m = fromUri.match(/\.(\w{2,5})(?:\?|$)/);
  const ext = (m ? m[1] : 'jpg').toLowerCase();
  const dest = `${ASSETS}${id}.${ext}`;
  await copyAsync({ from: fromUri, to: dest });
  return dest;
}

// Write a base64 PNG (e.g. a Skia canvas snapshot) to a temp file; caller resizes
// it with the image manipulator and then deletes it.
export async function writeTempPng(base64: string): Promise<string> {
  await initStorage();
  const dest = `${ROOT}tmp-${newId()}.png`;
  await writeAsStringAsync(dest, base64, { encoding: EncodingType.Base64 });
  return dest;
}

// Write raw bytes (e.g. an encoded GIF) to a temp file via the modern File API.
// Atomic-ish: a failed write removes the empty file instead of leaving a stub.
export async function writeTempBytes(bytes: Uint8Array, ext: string): Promise<string> {
  await initStorage();
  const dest = `${ROOT}tmp-${newId()}.${ext}`;
  const f = new File(dest);
  f.create({ intermediates: true, overwrite: true });
  try {
    f.write(bytes);
  } catch (e) {
    try { f.delete(); } catch {}
    throw e;
  }
  return dest;
}

// Stage a file the user is about to share (a backup zip), under a name they'll
// actually recognise in the share sheet. Previous exports are cleared first so
// they never pile up in app storage.
export async function writeExport(bytes: Uint8Array, filename: string): Promise<string> {
  await initStorage();
  try {
    for (const n of await readDirectoryAsync(EXPORTS)) await deleteFile(`${EXPORTS}${n}`);
  } catch {
    // best-effort
  }
  const dest = `${EXPORTS}${filename}`;
  const f = new File(dest);
  f.create({ intermediates: true, overwrite: true });
  try {
    f.write(bytes);
  } catch (e) {
    try { f.delete(); } catch {}
    throw e;
  }
  return dest;
}

export async function deleteFile(uri: string): Promise<void> {
  try {
    await deleteAsync(uri, { idempotent: true });
  } catch {
    // ignore
  }
}

// Back-compat alias (used for rendered PNGs and temp files).
export const deleteRender = deleteFile;
