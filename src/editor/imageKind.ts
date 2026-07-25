// Deciding what an image file actually is, from its bytes. Pure — unit-tested in
// Node — because the alternative (trusting the file extension) is how a still
// sticker ends up in an animated pack and vice versa.

export type ImageKind = 'gif' | 'webp' | 'png' | 'jpeg' | 'unknown';

const ascii = (b: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...b.subarray(at, at + len));

export function imageKind(b: Uint8Array): ImageKind {
  if (b.length < 12) return 'unknown';
  if (ascii(b, 0, 3) === 'GIF') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  return 'unknown';
}

// True when the file really moves.
export function isAnimatedBytes(b: Uint8Array): boolean {
  switch (imageKind(b)) {
    case 'webp': {
      // An animated WebP is an extended file (VP8X) carrying an ANIM chunk.
      let o = 12;
      while (o + 8 <= b.length) {
        const id = ascii(b, o, 4);
        const size = b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24);
        if (id === 'ANIM') return true;
        if (id === 'VP8 ' || id === 'VP8L') return false; // plain still image
        o += 8 + size + (size & 1);
      }
      return false;
    }
    case 'gif': {
      // More than one Graphic Control Extension means more than one frame.
      let frames = 0;
      for (let i = 0; i + 1 < b.length; i++) {
        if (b[i] === 0x21 && b[i + 1] === 0xf9 && ++frames > 1) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

export const extensionFor = (k: ImageKind) => (k === 'unknown' ? 'png' : k === 'jpeg' ? 'jpg' : k);
