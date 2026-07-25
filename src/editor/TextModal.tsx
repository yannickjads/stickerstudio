import React, { useState } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { Btn } from '../ui';
import type { TextLayer } from '../types';

export const FONTS = [
  'Arial Rounded MT Bold', 'Helvetica Neue', 'Futura', 'Georgia',
  'Chalkboard SE', 'Marker Felt', 'Snell Roundhand', 'Menlo',
];
export const PALETTE = [
  '#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759',
  '#00c7be', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff2d55', '#8e8e93',
];

export type TextDraft = Pick<TextLayer, 'text' | 'fontFamily' | 'fontSize' | 'fillColor' | 'stroke'>;

export default function TextModal({
  visible, initial, onCancel, onSave,
}: {
  visible: boolean;
  initial: TextDraft;
  onCancel: () => void;
  onSave: (d: TextDraft) => void;
}) {
  const [text, setText] = useState(initial.text);
  const [fontFamily, setFontFamily] = useState(initial.fontFamily);
  const [fontSize, setFontSize] = useState(initial.fontSize);
  const [fillColor, setFillColor] = useState(initial.fillColor);
  const [strokeColor, setStrokeColor] = useState(initial.stroke?.color ?? '#000000');
  const [strokeWidth, setStrokeWidth] = useState(initial.stroke?.width ?? 0);

  // Re-seed local state whenever a different layer opens the sheet.
  const key = `${visible}`;
  const [seed, setSeed] = useState(key);
  if (seed !== key) {
    setSeed(key);
    setText(initial.text); setFontFamily(initial.fontFamily); setFontSize(initial.fontSize);
    setFillColor(initial.fillColor); setStrokeColor(initial.stroke?.color ?? '#000000');
    setStrokeWidth(initial.stroke?.width ?? 0);
  }

  const save = () =>
    onSave({
      text: text.trim() || 'Text',
      fontFamily, fontSize, fillColor,
      stroke: strokeWidth > 0 ? { color: strokeColor, width: strokeWidth } : undefined,
    });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.grabber} />
          <TextInput
            style={s.input} value={text} onChangeText={setText} placeholder="Your text"
            placeholderTextColor={C.muted} autoFocus multiline
          />

          <Text style={s.label}>Font</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
            {FONTS.map((f) => (
              <Pressable key={f} onPress={() => setFontFamily(f)}
                style={[s.chip, fontFamily === f && s.chipOn]}>
                <Text style={[s.chipTxt, fontFamily === f && s.chipTxtOn]}>{f.split(' ')[0]}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={s.between}>
            <Text style={s.label}>Size {Math.round(fontSize)}</Text>
            <View style={s.stepper}>
              <Pressable style={s.stepBtn} onPress={() => setFontSize((v) => Math.max(16, v - 6))}><Ionicons name="remove" size={20} color={C.text} /></Pressable>
              <Pressable style={s.stepBtn} onPress={() => setFontSize((v) => Math.min(220, v + 6))}><Ionicons name="add" size={20} color={C.text} /></Pressable>
            </View>
          </View>

          <Text style={s.label}>Fill</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
            {PALETTE.map((c) => (
              <Pressable key={c} onPress={() => setFillColor(c)}
                style={[s.swatch, { backgroundColor: c }, fillColor === c && s.swatchOn]} />
            ))}
          </ScrollView>

          <View style={s.between}>
            <Text style={s.label}>Outline {strokeWidth > 0 ? Math.round(strokeWidth) : 'off'}</Text>
            <View style={s.stepper}>
              <Pressable style={s.stepBtn} onPress={() => setStrokeWidth((v) => Math.max(0, v - 3))}><Ionicons name="remove" size={20} color={C.text} /></Pressable>
              <Pressable style={s.stepBtn} onPress={() => setStrokeWidth((v) => Math.min(30, v + 3))}><Ionicons name="add" size={20} color={C.text} /></Pressable>
            </View>
          </View>
          {strokeWidth > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
              {PALETTE.map((c) => (
                <Pressable key={c} onPress={() => setStrokeColor(c)}
                  style={[s.swatch, { backgroundColor: c }, strokeColor === c && s.swatchOn]} />
              ))}
            </ScrollView>
          ) : null}

          <View style={s.actions}>
            <Btn label="Cancel" kind="ghost" onPress={onCancel} style={{ flex: 1 }} />
            <Btn label="Done" onPress={save} style={{ flex: 1 }} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 30, gap: 6 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 8 },
  input: {
    backgroundColor: C.surface2, borderRadius: 12, borderWidth: 1, borderColor: C.line,
    color: C.text, fontSize: 18, padding: 14, minHeight: 54, maxHeight: 120,
  },
  label: { color: C.muted, fontSize: 13, fontWeight: '700', marginTop: 10 },
  row: { gap: 8, paddingVertical: 6, paddingRight: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.line },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
  chipTxtOn: { color: C.ink },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: C.line },
  swatchOn: { borderColor: C.accent, transform: [{ scale: 1.12 }] },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: { flexDirection: 'row', gap: 8 },
  stepBtn: { width: 40, height: 34, borderRadius: 9, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 18 },
});
