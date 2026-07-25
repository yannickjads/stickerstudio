import { requireOptionalNativeModule } from 'expo-modules-core';
import { Alert } from 'react-native';

type Native = {
  prompt(
    title: string, message: string | null, placeholders: string[], values: string[],
    confirmText: string, cancelText: string,
  ): Promise<string[] | null>;
};

const native = requireOptionalNativeModule<Native>('NativePrompt');

export type PromptField = { placeholder: string; value?: string };

// Shows the system's own centred dialog with text fields.
// Resolves with one value per field, or null if the user cancelled.
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
  // Single-field fallback for environments without the native module.
  return new Promise((resolve) => {
    Alert.prompt(title, message, [
      { text: cancelText, style: 'cancel', onPress: () => resolve(null) },
      { text: confirmText, onPress: (v?: string) => resolve([v ?? '']) },
    ], 'plain-text', fields[0]?.value ?? '');
  });
}
