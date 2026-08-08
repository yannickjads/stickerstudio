import React from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SymbolView } from 'expo-symbols';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { C } from './theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * Apple's own icons.
 *
 * SF Symbols are drawn by the system, so they carry iOS's weights, optical sizes
 * and alignment rather than approximating them — which is most of why a screen
 * reads as made-for-the-platform instead of merely styled like it.
 *
 * The mapping lives in one table: a name that turns out to be wrong is one edit
 * rather than a hunt through the screens. Every entry also names an Ionicon,
 * which renders instead if the symbol is missing on this OS version, so a bad
 * guess degrades to the old icon rather than to an empty square.
 */
const SYMBOLS = {
  back: ['chevron.left', 'chevron-back'],
  forward: ['chevron.right', 'chevron-forward'],
  more: ['ellipsis', 'ellipsis-horizontal'],
  add: ['plus', 'add'],
  search: ['magnifyingglass', 'search'],
  star: ['star.fill', 'star'],
  photo: ['photo', 'image-outline'],
  photos: ['photo.on.rectangle', 'images-outline'],
  packs: ['square.stack', 'albums-outline'],
  pencil: ['pencil', 'pencil'],
  warning: ['exclamationmark.triangle', 'alert-circle-outline'],
  close: ['xmark', 'close'],
  gear: ['gearshape', 'settings-outline'],
} as const satisfies Record<string, readonly [string, IconName]>;

export type SymName = keyof typeof SYMBOLS;

export function Sym({
  name, size = 20, color = C.accent, style,
}: { name: SymName; size?: number; color?: string; style?: any }) {
  const [sf, ion] = SYMBOLS[name];
  return (
    <SymbolView
      name={sf as never}
      size={size}
      tintColor={color}
      type="monochrome"
      style={[{ width: size, height: size }, style]}
      fallback={<Ionicons name={ion} size={size} color={color} style={style} />}
    />
  );
}

// iOS-native metrics: 50pt buttons, 17pt semibold labels, continuous corners,
// ≥44pt hit targets everywhere.
export function Btn(props: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  style?: any;
}) {
  const { label, onPress, kind = 'primary', disabled, busy, style } = props;
  const dark = kind === 'primary';
  return (
    <Pressable
      style={({ pressed }) => [
        dark ? S.primary : S.ghost,
        (disabled || busy) && S.disabled,
        pressed && !disabled && !busy && { opacity: 0.75 },
        style,
      ]}
      onPress={onPress}
      disabled={disabled || busy}
    >
      {busy ? (
        <ActivityIndicator color={dark ? C.ink : C.text} />
      ) : (
        <Text style={dark ? S.primaryTxt : S.ghostTxt} numberOfLines={1}>{label}</Text>
      )}
    </Pressable>
  );
}

// Text action in a nav bar (e.g. "Centre all") — 17pt semibold tint, 44pt target.
export function NavText({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8}
      style={({ pressed }) => [S.navText, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.55 }]}>
      <Text style={S.navTextTxt} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

// Circular tinted symbol button (iOS 17 toolbar style) — for "+", "…", etc.
export function NavCircle({ icon, onPress, disabled }: { icon: SymName; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6}
      style={({ pressed }) => [S.navCircle, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.6 }]}>
      <Sym name={icon} size={19} />
    </Pressable>
  );
}

// Inline navigation header (sub-screens): centered 17pt title, glass back circle.
export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={S.header}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} style={({ pressed }) => [S.headerSide, S.back, pressed && { opacity: 0.55 }]}>
          <BlurView intensity={25} tint="dark" style={S.backCircle}>
            <Sym name="back" size={17} color={C.text} />
          </BlurView>
        </Pressable>
      ) : (
        <View style={S.headerSide} />
      )}
      <Text style={S.headerTitle} numberOfLines={1}>{title}</Text>
      <View style={[S.headerSide, { alignItems: 'flex-end' }]}>{right}</View>
    </View>
  );
}

// Large-title header (root screen), Apple style: bold 34pt left, action right.
export function LargeHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={S.largeHeader}>
      <Text style={S.largeTitle} numberOfLines={1}>{title}</Text>
      {right}
    </View>
  );
}

// Inset grouped list, the way iOS presents a set of actions on one object:
// a single rounded card, hairline separators inset to the label, no icons unless
// they carry meaning.
export function ListGroup({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={S.group}>
      {items.map((child, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <View style={S.sep} /> : null}
          {child}
        </React.Fragment>
      ))}
    </View>
  );
}

export function Row({
  label, value, onPress, destructive, disabled, icon,
}: {
  label: string; value?: string | null; onPress: () => void;
  destructive?: boolean; disabled?: boolean; icon?: SymName;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [S.row, pressed && !disabled && { backgroundColor: C.surface2 }, disabled && S.disabled]}
    >
      {icon ? <Sym name={icon} size={19} color={destructive ? C.bad : C.accent} style={{ marginRight: 10 }} /> : null}
      <Text style={[S.rowLabel, destructive && { color: C.bad }]} numberOfLines={1}>{label}</Text>
      {value ? <Text style={S.rowValue} numberOfLines={1}>{value}</Text> : null}
      {destructive ? null : <Sym name="forward" size={14} color={C.muted} />}
    </Pressable>
  );
}

const CORNER = Platform.OS === 'ios' ? { borderCurve: 'continuous' as const } : null;

export const EDGE = 20; // one margin for the whole app: headers, grids, footers
export const ACTION_H = 54;
export const ACTION_R = 14;
export const TAB_BAR_H = 64;

export type TabId = 'library' | 'settings';

export function TabBar({ tab, onTabChange }: { tab: TabId; onTabChange: (t: TabId) => void }) {
  const insets = useSafeAreaInsets();
  const go = (t: TabId) => { if (t !== tab) { Haptics.selectionAsync(); onTabChange(t); } };
  return (
    <BlurView intensity={80} tint="dark"
      style={[TB.bar, { bottom: Math.max(insets.bottom, 8) }]}>
      <Pressable style={[TB.tab, tab === 'library' && TB.tabActive]} onPress={() => go('library')}>
        <Sym name="packs" size={22} color={tab === 'library' ? C.accent : C.muted} />
        <Text style={[TB.label, tab === 'library' && TB.labelActive]}>Library</Text>
      </Pressable>
      <Pressable style={[TB.tab, tab === 'settings' && TB.tabActive]} onPress={() => go('settings')}>
        <Sym name="gear" size={22} color={tab === 'settings' ? C.accent : C.muted} />
        <Text style={[TB.label, tab === 'settings' && TB.labelActive]}>Settings</Text>
      </Pressable>
    </BlurView>
  );
}

const TB = StyleSheet.create({
  bar: {
    position: 'absolute', left: EDGE, right: EDGE,
    flexDirection: 'row',
    borderRadius: 22, borderCurve: 'continuous', overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    padding: 5, gap: 5,
  },
  tab: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, gap: 4,
    borderRadius: 17, borderCurve: 'continuous',
  },
  tabActive: { backgroundColor: 'rgba(255,255,255,0.10)' },
  label: { color: C.muted, fontSize: 10, fontWeight: '600' },
  labelActive: { color: C.accent },
});

export const S = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: EDGE,
    height: 48, gap: 4,
  },
  // Flexible rather than a fixed width: a fixed side clips or wraps any label
  // that happens to be longer than it. The title still centres in what's left.
  headerSide: { minWidth: 44, justifyContent: 'center' },
  back: { height: 44, justifyContent: 'center', marginLeft: -4 },
  backCircle: {
    width: 34, height: 34, borderRadius: 17, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  headerTitle: {
    flex: 1, textAlign: 'center', color: C.text, fontSize: 17, fontWeight: '600',
    letterSpacing: -0.2, marginHorizontal: 4,
  },

  largeHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: EDGE, paddingTop: 8, paddingBottom: 14,
  },
  largeTitle: { color: C.text, fontSize: 34, fontWeight: '700', letterSpacing: 0.2, flexShrink: 1 },

  navText: { height: 44, justifyContent: 'center', paddingHorizontal: 4 },
  navTextTxt: { color: C.accent, fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  navCircle: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: C.tint,
    alignItems: 'center', justifyContent: 'center',
  },

  primary: {
    backgroundColor: C.accent, borderRadius: ACTION_R, height: ACTION_H,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, ...CORNER,
  },
  primaryTxt: { color: C.ink, fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  ghost: {
    backgroundColor: C.surface2, borderRadius: ACTION_R, height: ACTION_H,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, ...CORNER,
  },
  ghostTxt: { color: C.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  disabled: { opacity: 0.4 },

  group: {
    backgroundColor: C.surface, borderRadius: 14, ...CORNER, overflow: 'hidden',
    marginHorizontal: EDGE,
  },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 16, gap: 10 },
  rowLabel: { color: C.text, fontSize: 16, fontWeight: '500', flex: 1 },
  rowValue: { color: C.muted, fontSize: 16, maxWidth: '45%' },
  // Inset to the label, not the card edge — the iOS convention.
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 16 },

  h2: { fontSize: 20, fontWeight: '700', color: C.text },
  muted: { color: C.muted, fontWeight: '600' },
  hint: { color: C.muted, fontSize: 13 },
  pad: { paddingHorizontal: EDGE },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 40, gap: 16 },
  emptyTxt: { color: C.muted, fontSize: 16, textAlign: 'center', lineHeight: 22 },
  footer: { paddingHorizontal: EDGE, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.bg },
  footerNote: { color: C.muted, fontSize: 13, textAlign: 'center', marginTop: 10 },
});
