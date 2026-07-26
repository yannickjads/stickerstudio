// Working out which files inside a shared pack archive are the stickers.
// Pure list-in, list-out, with no zip library and no file system, so it is
// unit-tested in Node against the layouts real sticker apps actually produce.

const IMAGE = /\.(webp|png|gif|jpe?g)$/i;
const WEBP = /\.webp$/i;
// The tray icon is a pack's thumbnail, not one of its stickers.
const TRAY_NAME = /(^|\/)(tray|cover|icon|thumb\w*)[^/]*$/i;
// Zips made on a Mac carry a shadow copy of every file, and dotfiles generally;
// importing those would double the pack and fill half of it with garbage.
const JUNK = /(^|\/)(__MACOSX\/|\.)/;

const images = (names: string[], isDir: (n: string) => boolean) =>
  names.filter((n) => !isDir(n) && !JUNK.test(n) && IMAGE.test(n));

/**
 * Which entries are the tray icon rather than stickers.
 *
 * Two independent signals, because neither is reliable alone:
 *
 *  - FORMAT. Stickers in a .wastickers pack are WebP — WhatsApp accepts nothing
 *    else — while the tray is a PNG. So an archive of WebP stickers with exactly
 *    ONE image in another format has found its tray, whatever the file is called.
 *    That matters because every app names it differently, and going by name alone
 *    let a pack import with its icon as sticker one.
 *  - NAME. Otherwise, what the file is called: tray / cover / icon / thumbnail.
 *
 * A pack has at most one tray, so the format signal only counts when exactly one
 * image is the odd one out; a genuinely mixed bag of formats is all stickers.
 * And the result never covers every image: if it would, the archive is not built
 * the way we assumed and all of them are stickers.
 */
export function trayEntries(names: string[], isDir: (n: string) => boolean = () => false): string[] {
  const all = images(names, isDir);
  const others = all.filter((n) => !WEBP.test(n));
  const hasWebp = all.length > others.length;
  const byFormat = hasWebp && others.length === 1 ? others : [];
  const byName = all.filter((n) => TRAY_NAME.test(n));
  const tray = new Set([...byFormat, ...byName]);
  return tray.size < all.length ? all.filter((n) => tray.has(n)) : [];
}

/**
 * Every sticker image in a pack archive, in the order they should be laid out.
 *
 * Deliberately not tied to a naming convention. `.wastickers` is a de facto
 * format and every app writes it slightly differently — `sticker-01.webp`,
 * `1.webp`, a uuid, sometimes nested in a folder — so anything that is an image
 * and isn't the tray counts. Insisting on `sticker-NN` is what made packs shared
 * from other sticker apps import as "does not contain any stickers".
 *
 * Ordering uses the LAST number in the file name, so `sticker-2` sorts before
 * `sticker-10` rather than after it. Names with no number at all keep the order
 * the archive listed them in.
 */
export function stickerEntries(names: string[], isDir: (n: string) => boolean = () => false): string[] {
  const all = images(names, isDir);
  const tray = new Set(trayEntries(names, isDir));
  const use = all.filter((n) => !tray.has(n));

  const given = new Map(use.map((n, i) => [n, i]));
  const numberOf = (n: string) => {
    const nums = n.replace(/^.*\//, '').match(/\d+/g);
    return nums ? Number(nums[nums.length - 1]) : Number.NaN;
  };
  return use.slice().sort((a, b) => {
    const na = numberOf(a), nb = numberOf(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return given.get(a)! - given.get(b)!;
    if (Number.isNaN(na)) return 1;   // unnumbered files go last, in archive order
    if (Number.isNaN(nb)) return -1;
    return na - nb || a.localeCompare(b);
  });
}
