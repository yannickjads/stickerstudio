// Working out which files inside a shared pack archive are the stickers.
// Pure list-in, list-out, with no zip library and no file system, so it is
// unit-tested in Node against the layouts real sticker apps actually produce.

const IMAGE = /\.(webp|png|gif|jpe?g)$/i;
// The tray icon is a pack's thumbnail, not one of its stickers.
const TRAY = /(^|\/)(tray|cover|icon|thumb\w*)[^/]*$/i;
// Zips made on a Mac carry a shadow copy of every file, and dotfiles generally;
// importing those would double the pack and fill half of it with garbage.
const JUNK = /(^|\/)(__MACOSX\/|\.)/;

// The same three tests, used to FIND the tray rather than to exclude it.
export const isTrayFile = (name: string) => IMAGE.test(name) && TRAY.test(name) && !JUNK.test(name);

/**
 * Every sticker image in a pack archive, in the order they should be laid out.
 *
 * Deliberately not tied to a naming convention. `.wastickers` is a de facto
 * format and every app writes it slightly differently — `sticker-01.webp`,
 * `1.webp`, a uuid, sometimes nested in a folder — so anything that is an image
 * and isn't the tray icon counts. Insisting on `sticker-NN` is what made packs
 * shared from other sticker apps import as "does not contain any stickers".
 *
 * Ordering uses the LAST number in the file name, so `sticker-2` sorts before
 * `sticker-10` rather than after it. Names with no number at all keep the order
 * the archive listed them in.
 */
export function stickerEntries(names: string[], isDir: (n: string) => boolean = () => false): string[] {
  const files = names.filter((n) => !isDir(n) && !JUNK.test(n));
  const images = files.filter((n) => IMAGE.test(n));
  // If every image looks like a tray icon, it plainly isn't one.
  const withoutTray = images.filter((n) => !TRAY.test(n));
  const use = withoutTray.length ? withoutTray : images;

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
