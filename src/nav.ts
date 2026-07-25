export type Route =
  | { name: 'packs' }
  | { name: 'pack'; packId: string; packName: string }
  | { name: 'crop'; packId: string; packName: string; startSlot?: number }
  | { name: 'editor'; stickerId: string; packName: string };

export type Nav = {
  push: (r: Route) => void;
  pop: () => void;
  replace: (r: Route) => void;
};
