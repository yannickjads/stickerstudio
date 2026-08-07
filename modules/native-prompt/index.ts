import { requireOptionalNativeModule } from 'expo-modules-core';
import { Alert } from 'react-native';

type Native = {
  prompt(
    title: string, message: string | null, placeholders: string[], values: string[],
    confirmText: string, cancelText: string,
  ): Promise<string[] | null>;
  actionSheet(
    title: string | null, message: string | null, labels: string[], destructive: number[],
  ): Promise<number | null>;
};

const native = requireOptionalNativeModule<Native>('NativePrompt');

export type PromptField = { placeholder: string; value?: string };

export async function nativePrompt(opts: {
  title: string;
  message?: string;
  fields: PromptField[];
  confirmText?: string;
  cancelText?: string;
}): Promise<string[] | null> {
  const { title, message, fields, confirmText = 'Save', cancelText = 'Cancel' } = opts;
  if (native) {
    return native.prompt(
      title, message ?? null,
      fields.map((f) => f.placeholder),
      fields.map((f) => f.value ?? ''),
      confirmText, cancelText,
    );
  }
  return new Promise((resolve) => {
    Alert.prompt(title, message, [
      { text: cancelText, style: 'cancel', onPress: () => resolve(null) },
      { text: confirmText, onPress: (v?: string) => resolve([v ?? '']) },
    ], 'plain-text', fields[0]?.value ?? '');
  });
}

export type ActionSheetOption = {
  label: string;
  onPress?: () => void;
  destructive?: boolean;
};

let _setBlocking: ((v: boolean) => void) | null = null;

export function registerBlocker(setter: (v: boolean) => void) {
  _setBlocking = setter;
}

export async function nativeActionSheet(opts: {
  title?: string;
  message?: string;
  options: ActionSheetOption[];
}): Promise<void> {
  const { title, message, options } = opts;
  if (!native) return;
  const labels = options.map((o) => o.label);
  const destructive = options
    .map((o, i) => (o.destructive ? i : -1))
    .filter((i) => i >= 0);
  _setBlocking?.(true);
  let picked: number | null = null;
  try {
    picked = await native.actionSheet(
      title ?? null, message ?? null, labels, destructive,
    );
  } finally {
    _setBlocking?.(false);
  }
  if (picked != null) options[picked]?.onPress?.();
}
