export type Route =
  | { name: 'packs' }
  | { name: 'pack'; packId: string; packName: string }
  // editStickerId: re-crop an existing sticker from its stored original instead
  // of importing new ones — same screen, same maths, one different ending.
  | { name: 'crop'; packId: string; packName: string; startSlot?: number; editStickerId?: string }
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
