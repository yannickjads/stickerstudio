import { requireOptionalNativeModule } from 'expo-modules-core';

type Native = {
  isSupported(): Promise<boolean>;
  cutout(uri: string): Promise<string | null>;
};

const native = requireOptionalNativeModule<Native>('SubjectCutout');

export async function cutoutSupported(): Promise<boolean> {
  if (!native) return false;
  try { return await native.isSupported(); } catch { return false; }
}

// file:// PNG with a transparent background, same pixel size as the input,
// or null when no subject stands out (or the OS is too old).
export async function cutoutSubject(uri: string): Promise<string | null> {
  if (!native) return null;
  try { return await native.cutout(uri); } catch { return null; }
}
