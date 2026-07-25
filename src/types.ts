export type Pack = {
  id: string;
  name: string;
  author: string;
  coverStickerId: string | null;
  sortIndex: number;
  createdAt: number;
  updatedAt: number;
  // derived (from joins), present when listing:
  count?: number;
  cover?: string | null;
};

// WhatsApp allows at most 30 stickers per pack — used for capacity display + auto-split.
export const PACK_MAX = 30;

export type Sticker = {
  id: string;
  packId: string;
  uri: string;          // permanent flattened PNG in app storage (for display/thumbnail/export)
  documentId: string | null; // the editable document behind this sticker (P2+)
  width: number;
  height: number;
  sortIndex: number;
  createdAt: number;
  updatedAt: number;
};

// ---------------------------------------------------------------- editor model
export type Asset = {
  id: string;
  kind: 'image';
  localUri: string;      // permanent copy in app storage
  originalUri: string | null;
  width: number;
  height: number;
  createdAt: number;
};

export type Transform = { x: number; y: number; scaleX: number; scaleY: number; rotation: number };

export type BaseLayer = {
  id: string;
  type: 'image' | 'text';
  visible: boolean;
  locked: boolean;
  opacity: number;
  transform: Transform;
  zIndex: number;
};

// Non-destructive shape mask applied to an image layer's fitted box.
export type MaskShape = 'circle' | 'rounded' | 'squircle';

export type ImageLayer = BaseLayer & {
  type: 'image';
  assetId: string;
  fit: 'contain' | 'cover' | 'stretch' | 'center';
  // crop rect in the asset's own pixel coordinates (non-destructive):
  crop?: { x: number; y: number; width: number; height: number };
  mask?: MaskShape;
};

export type TextLayer = BaseLayer & {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: string;
  fillColor: string;
  stroke?: { color: string; width: number };
  align: 'left' | 'center' | 'right';
};

export type Layer = ImageLayer | TextLayer;

export type EditorDocument = {
  id: string;
  schemaVersion: number;
  canvas: { width: number; height: number; background: 'transparent' | string };
  layers: Layer[];
  createdAt: number;
  updatedAt: number;
};

export const DOC_SCHEMA_VERSION = 1;
