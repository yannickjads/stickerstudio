import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import NativeSlider from '@react-native-community/slider';
import { C } from '../theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function ToolButton({
  icon, label, onPress, active, disabled, danger,
}: { icon: IconName; label: string; onPress: () => void; active?: boolean; disabled?: boolean; danger?: boolean }) {
  const color = danger ? C.bad : active ? C.ink : C.text;
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[cs.tool, active && cs.toolActive, disabled && { opacity: 0.3 }]}>
      <Ionicons name={icon} size={22} color={color} />
      <Text numberOfLines={1} style={[cs.toolLabel, { color: active ? C.ink : danger ? C.bad : C.muted }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Apple's own UISegmentedControl rather than a row of pressables dressed up as
 * one. It brings the sliding selection, the press states, the font metrics and
 * the accessibility behaviour for free — all of which a hand-built copy only
 * ever approximates.
 */
export function Segmented<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <SegmentedControl
      values={options.map((o) => o.label)}
      selectedIndex={index}
      onChange={(e) => {
        const i = e.nativeEvent.selectedSegmentIndex;
        const picked = options[i];
        if (picked) onChange(picked.value);
      }}
      appearance="dark"
      tintColor={C.accent}
      backgroundColor={C.surface2}
      fontStyle={{ color: C.text, fontWeight: '600' }}
      activeFontStyle={{ color: C.ink, fontWeight: '700' }}
      style={{ height: 34 }}
    />
  );
}

export function SwatchRow({
  colors, value, onChange, allowNone,
}: { colors: string[]; value: string | null; onChange: (c: string | null) => void; allowNone?: boolean }) {
  return (
    <View style={cs.swatchRow}>
      {allowNone ? (
        <Pressable onPress={() => onChange('transparent')} style={[cs.swatch, cs.none, (value === 'transparent' || value == null) && cs.swatchOn]}>
          <Ionicons name="ban-outline" size={18} color={C.muted} />
        </Pressable>
      ) : null}
      {colors.map((c) => (
        <Pressable key={c} onPress={() => onChange(c)} style={[cs.swatch, { backgroundColor: c }, value === c && cs.swatchOn]} />
      ))}
    </View>
  );
}

/**
 * Apple's UISlider. The hand-rolled one it replaces had to reimplement the thumb,
 * the tap-to-jump, the hit slop and the drag tracking; this gets all of it, plus
 * the system's own feel under the finger.
 */
export function Slider({
  value, min, max, onChange, onStart, format,
}: { value: number; min: number; max: number; onChange: (v: number) => void; onStart?: () => void; format?: (v: number) => string }) {
  return (
    <View style={cs.sliderWrap}>
      <NativeSlider
        style={cs.sliderHit}
        value={value}
        minimumValue={min}
        maximumValue={max}
        onSlidingStart={onStart}
        onValueChange={onChange}
        minimumTrackTintColor={C.accent}
        maximumTrackTintColor={C.surface3}
        thumbTintColor="#ffffff"
      />
      {format ? <Text style={cs.sliderVal}>{format(value)}</Text> : null}
    </View>
  );
}

const cs = StyleSheet.create({
  tool: { minWidth: 60, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 14 },
  toolActive: { backgroundColor: C.accent },
  toolLabel: { fontSize: 11, fontWeight: '700' },

  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: C.line },
  none: { backgroundColor: C.surface2, alignItems: 'center', justifyContent: 'center' },
  swatchOn: { borderColor: C.accent, transform: [{ scale: 1.12 }] },

  sliderWrap: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  sliderHit: { flex: 1, height: 40 },
  sliderVal: { color: C.text, fontWeight: '700', fontSize: 13, width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
