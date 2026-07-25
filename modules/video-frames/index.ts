import { requireOptionalNativeModule } from 'expo-modules-core';

export type VideoInfo = { durationMs: number; width: number; height: number };

type Native = {
  info(uri: string): Promise<VideoInfo>;
  extract(uri: string, startMs: number, durationMs: number, count: number, maxSize: number): Promise<string[]>;
};

const native = requireOptionalNativeModule<Native>('VideoFrames');

export const hasVideoSupport = () => native != null;

export async function videoInfo(uri: string): Promise<VideoInfo | null> {
  if (!native) return null;
  try { return await native.info(uri); } catch { return null; }
}

// Returns file:// urls of `count` frames spanning the chosen range, in order.
export async function extractFrames(
  uri: string, startMs: number, durationMs: number, count: number, maxSize = 720,
): Promise<string[]> {
  if (!native) throw new Error('Video support is not available in this build.');
  return native.extract(uri, startMs, durationMs, count, maxSize);
}
