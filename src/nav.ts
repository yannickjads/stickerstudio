// Where a new sticker comes from. 'photos' covers GIFs too — iOS hands them back
// as images and the app detects the animation itself; there is no GIF-only filter
// in the system picker, so 'files' is the way in for a GIF that isn't in Photos.
// 'mixed' restricts nothing, for picking a run of photos and clips in one go.
export type MediaSource = 'photos' | 'videos' | 'mixed' | 'files';

export type Route =
  | { name: 'packs' }
  | { name: 'pack'; packId: string; packName: string }
  // editStickerId: re-crop an existing sticker from its stored original instead
  // of importing new ones — same screen, same maths, one different ending.
  // source narrows the picker so the app's own capabilities are visible in the
  // menu that opens it, instead of hidden behind "everything".
  | {
      name: 'crop'; packId: string; packName: string; startSlot?: number;
      editStickerId?: string; source?: MediaSource;
      sharedUris?: Array<{ uri: string; w: number; h: number }>;
    }
  | { name: 'sticker'; stickerId: string; packId: string; packName: string }
  // The result comes back through the callback: the screen that opened it decides
  // whether the cut-out becomes a new sticker or replaces an existing one. It is
  // awaited before the screen closes, so the screen underneath always reloads
  // from a database that already has the new image.
  | { name: 'cutout'; uri: string; title?: string; onDone: (result: string) => void | Promise<void> }
  | { name: 'editor'; stickerId: string; packName: string };

export type Nav = {
  push: (r: Route) => void;
  pop: () => void;
  replace: (r: Route) => void;
};
