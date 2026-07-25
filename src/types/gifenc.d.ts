declare module 'gifenc' {
  export type GifPalette = number[][];
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): GifPalette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
  export function GIFEncoder(opts?: { auto?: boolean }): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: GifPalette;
        delay?: number;           // ms
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
        repeat?: number;          // 0 = loop forever (first frame)
        first?: boolean;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
