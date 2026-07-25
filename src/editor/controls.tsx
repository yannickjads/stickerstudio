import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
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

export function Segmented<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={cs.segment}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} style={[cs.segItem, on && cs.segItemOn]}>
            <Text style={[cs.segTxt, on && cs.segTxtOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
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

// Self-contained horizontal slider (no native module). Reports value on drag.
export function Slider({
  value, min, max, onChange, onStart, format,
}: { value: number; min: number; max: number; onChange: (v: number) => void; onStart?: () => void; format?: (v: number) => string }) {
  const [w, setW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const frac = max > min ? (value - min) / (max - min) : 0;

  // Single gesture: onBegin fires on touch-down (tap OR drag start) → one history
  // push + initial value; onUpdate tracks the drag. No separate Tap gesture, so one
  // interaction can never double-push history.
  const begin = (x: number) => { onStart?.(); setFromX(x); };
  const setFromX = (x: number) => {
    if (w <= 0) return;
    const f = Math.min(Math.max(x / w, 0), 1);
    onChange(min + f * (max - min));
  };
  const pan = Gesture.Pan()
    .minDistance(1)
    .onBegin((e) => { 'worklet'; runOnJS(begin)(e.x); })
    .onUpdate((e) => { 'worklet'; runOnJS(setFromX)(e.x); });

  return (
    <View style={cs.sliderWrap}>
      <GestureDetector gesture={pan}>
        <View style={cs.sliderHit} onLayout={onLayout}>
          <View style={cs.track}>
            <View style={[cs.fill, { width: `${frac * 100}%` }]} />
            <View style={[cs.thumb, { left: `${frac * 100}%` }]} />
          </View>
        </View>
      </GestureDetector>
      {format ? <Text style={cs.sliderVal}>{format(value)}</Text> : null}
    </View>
  );
}

const cs = StyleSheet.create({
  tool: { minWidth: 60, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 14 },
  toolActive: { backgroundColor: C.accent },
  toolLabel: { fontSize: 11, fontWeight: '700' },

  segment: { flexDirection: 'row', backgroundColor: C.surface2, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: C.line },
  segItem: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 9 },
  segItemOn: { backgroundColor: C.accent },
  segTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
  segTxtOn: { color: C.ink },

  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: C.line },
  none: { backgroundColor: C.surface2, alignItems: 'center', justifyContent: 'center' },
  swatchOn: { borderColor: C.accent, transform: [{ scale: 1.12 }] },

  sliderWrap: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  sliderHit: { flex: 1, height: 40, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, backgroundColor: C.surface3 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: C.accent },
  thumb: { position: 'absolute', top: -8, width: 22, height: 22, borderRadius: 11, marginLeft: -11, backgroundColor: '#fff', borderWidth: 3, borderColor: C.accent },
  sliderVal: { color: C.text, fontWeight: '700', fontSize: 13, width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
