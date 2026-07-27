import React from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Platform, ActionSheetIOS, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from './theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

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
export function NavCircle({ icon, onPress, disabled }: { icon: IconName; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6}
      style={({ pressed }) => [S.navCircle, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.6 }]}>
      <Ionicons name={icon} size={20} color={C.accent} />
    </Pressable>
  );
}

// Inline navigation header (sub-screens): centered 17pt title, chevron back.
export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={S.header}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} style={({ pressed }) => [S.headerSide, S.back, pressed && { opacity: 0.55 }]}>
          <Ionicons name="chevron-back" size={28} color={C.accent} />
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

export type SheetOption = {
  label: string;
  onPress?: () => void;
  destructive?: boolean;
};

/**
 * A real iOS action sheet — the panel that slides up from the bottom — rather
 * than Alert.alert, which draws a centred box.
 *
 * The distinction is not decoration: an alert is for something the system needs
 * to tell you, a sheet is for choosing between actions, and iOS users read the
 * difference without thinking about it. Sheets also put the destructive choice
 * in red and the cancel apart from the rest, both of which Alert cannot do with
 * a list of buttons.
 *
 * Falls back to an alert off iOS, where ActionSheetIOS does not exist.
 */
export function sheet(opts: { title?: string; message?: string; options: SheetOption[] }) {
  const { title, message, options } = opts;
  if (Platform.OS !== 'ios') {
    Alert.alert(title ?? '', message, [
      ...options.map((o) => ({
        text: o.label,
        style: o.destructive ? ('destructive' as const) : undefined,
        onPress: o.onPress,
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
    return;
  }
  const labels = [...options.map((o) => o.label), 'Cancel'];
  const destructive = options.findIndex((o) => o.destructive);
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title, message,
      options: labels,
      cancelButtonIndex: labels.length - 1,
      ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
      userInterfaceStyle: 'dark',
    },
    (i) => { options[i]?.onPress?.(); },
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
  destructive?: boolean; disabled?: boolean; icon?: IconName;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [S.row, pressed && !disabled && { backgroundColor: C.surface2 }, disabled && S.disabled]}
    >
      {icon ? <Ionicons name={icon} size={19} color={destructive ? C.bad : C.accent} style={{ marginRight: 10 }} /> : null}
      <Text style={[S.rowLabel, destructive && { color: C.bad }]} numberOfLines={1}>{label}</Text>
      {value ? <Text style={S.rowValue} numberOfLines={1}>{value}</Text> : null}
      {destructive ? null : <Ionicons name="chevron-forward" size={16} color={C.muted} />}
    </Pressable>
  );
}

const CORNER = Platform.OS === 'ios' ? { borderCurve: 'continuous' as const } : null;

export const EDGE = 20; // one margin for the whole app: headers, grids, footers

export const S = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: EDGE,
    height: 48, gap: 4,
  },
  // Flexible rather than a fixed width: a fixed side clips or wraps any label
  // that happens to be longer than it. The title still centres in what's left.
  headerSide: { minWidth: 44, justifyContent: 'center' },
  // pull the chevron's ink onto the shared margin (the glyph has side bearing)
  back: { height: 44, justifyContent: 'center', marginLeft: -8 },
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
    backgroundColor: C.accent, borderRadius: 14, height: 50,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, ...CORNER,
  },
  primaryTxt: { color: C.ink, fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  ghost: {
    backgroundColor: C.surface2, borderRadius: 14, height: 50,
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
