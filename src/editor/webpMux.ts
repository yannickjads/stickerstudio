// Animated-WebP muxer: combines single-frame WebP files (as encoded by Skia) into
// one looping animated WebP (RIFF/VP8X/ANIM/ANMF). Pure byte manipulation — no
// Skia imports, unit-tested in Node (scripts compiled via tsc).
//
// Container spec: https://developers.google.com/speed/webp/docs/riff_container

export type WebpFrame = { webp: Uint8Array; delayMs: number };

/**
 * What this muxer will actually write for a frame. WhatsApp's floor is 8 ms, but
 * a GIF stores delays in centiseconds and 0 is common, which every decoder in
 * practice plays back at about 100 ms — 20 is the usual compromise and matches
 * what browsers do.
 *
 * Exported because a caller trimming an animation to a duration limit has to
 * count the durations that get WRITTEN, not the ones it started with: raw delays
 * of 5 ms look like a 500 ms clip and come out four times longer.
 */
export const frameDurationMs = (delayMs: number) => Math.max(20, Math.round(delayMs));

const te = new TextEncoder();

function fourcc(s: string): Uint8Array { return te.encode(s); }

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; b[2] = (n >>> 16) & 0xff; b[3] = (n >>> 24) & 0xff;
  return b;
}

function u24(n: number): Uint8Array {
  const b = new Uint8Array(3);
  b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; b[2] = (n >>> 16) & 0xff;
  return b;
}

type Chunk = { id: string; data: Uint8Array };

// Parse the chunks of a single WebP file (skips RIFF/WEBP header).
export function parseWebpChunks(bytes: Uint8Array): Chunk[] {
  if (bytes.length < 12) throw new Error('Not a WebP file (too short)');
  const id4 = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (id4(0) !== 'RIFF' || id4(8) !== 'WEBP') throw new Error('Not a WebP file');
  const chunks: Chunk[] = [];
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = id4(o);
    const size = bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24);
    const data = bytes.subarray(o + 8, o + 8 + size);
    chunks.push({ id, data });
    o += 8 + size + (size & 1); // chunks are even-padded
  }
  return chunks;
}

// The image payload of a frame = its bitstream chunks (ALPH? + VP8) or (VP8L),
// re-serialized with chunk headers + even padding.
function frameImageChunks(chunks: Chunk[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  const alph = chunks.find((c) => c.id === 'ALPH');
  const vp8 = chunks.find((c) => c.id === 'VP8 ');
  const vp8l = chunks.find((c) => c.id === 'VP8L');
  const emit = (c: Chunk) => {
    out.push(fourcc(c.id), u32(c.data.length), c.data);
    if (c.data.length & 1) out.push(new Uint8Array(1));
  };
  if (vp8l) emit(vp8l);
  else if (vp8) { if (alph) emit(alph); emit(vp8); }
  else throw new Error('WebP frame has no VP8/VP8L bitstream');
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Mux frames (all width×height, full-canvas) into a looping animated WebP.
export function muxAnimatedWebp(frames: WebpFrame[], width: number, height: number): Uint8Array {
  if (frames.length < 2) throw new Error('Need at least 2 frames');
  const parts: Uint8Array[] = [];

  // VP8X: feature flags — animation (bit 1) + alpha (bit 4); canvas size minus one.
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0b00010010;
  vp8x.set(u24(width - 1), 4);
  vp8x.set(u24(height - 1), 7);
  parts.push(fourcc('VP8X'), u32(10), vp8x);

  // ANIM: background color (transparent) + loop count 0 = forever.
  const anim = new Uint8Array(6); // 4 bytes BGRA background + 2 bytes loop count
  parts.push(fourcc('ANIM'), u32(6), anim);

  for (const f of frames) {
    const image = concat(frameImageChunks(parseWebpChunks(f.webp)));
    // ANMF header: 16 bytes — x/2, y/2, w-1, h-1 (24-bit each), duration (24-bit ms),
    // flags byte: blending=1 (do not blend), disposal=1 (dispose to background).
    const head = new Uint8Array(16);
    head.set(u24(0), 0);                    // frame x / 2
    head.set(u24(0), 3);                    // frame y / 2
    head.set(u24(width - 1), 6);
    head.set(u24(height - 1), 9);
    head.set(u24(frameDurationMs(f.delayMs)), 12);
    head[15] = 0b00000011;                  // no-blend + dispose-to-background
    const size = 16 + image.length;
    parts.push(fourcc('ANMF'), u32(size), head, image);
    if (size & 1) parts.push(new Uint8Array(1));
  }

  const body = concat(parts);
  return concat([fourcc('RIFF'), u32(4 + body.length), fourcc('WEBP'), body]);
}

// ---- small base64 helpers (Hermes-safe, chunked; no Buffer/atob dependency) ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64REV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64REV[B64[i]] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out.push(B64[a >> 2]);
    out.push(B64[((a & 3) << 4) | ((b ?? 0) >> 4)]);
    out.push(i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=');
    out.push(i + 2 < bytes.length ? B64[c & 63] : '=');
  }
  return out.join('');
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i + 3 < clean.length || i + 1 < clean.length; i += 4) {
    const n = (B64REV[clean[i]] << 18) | (B64REV[clean[i + 1]] << 12)
      | ((B64REV[clean[i + 2]] ?? 0) << 6) | (B64REV[clean[i + 3]] ?? 0);
    out[o++] = (n >> 16) & 0xff;
    if (clean[i + 2] !== undefined) out[o++] = (n >> 8) & 0xff;
    if (clean[i + 3] !== undefined) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}
