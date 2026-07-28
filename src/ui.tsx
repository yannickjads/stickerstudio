import React from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Platform, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

// Inline navigation header (sub-screens): centered 17pt title, chevron back.
export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={S.header}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} style={({ pressed }) => [S.headerSide, S.back, pressed && { opacity: 0.55 }]}>
          <Sym name="back" size={22} />
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
 * A bottom sheet, built rather than borrowed.
 *
 * ActionSheetIOS was the obvious choice and it misbehaved here in two ways at
 * once: no Cancel appeared, and a tap outside it went straight through to
 * whatever was underneath — so dismissing the pack menu over a sticker slot
 * opened that slot. Both are things a menu must never do, and neither is fixable
 * from this side of the bridge.
 *
 * So: a Modal, which captures every touch by construction, holding the same
 * shapes iOS uses — a grouped card of actions, destructive in red, and Cancel on
 * its own card below. One sheet exists at a time; asking for another simply
 * replaces it, which means there is no presentation race to serialise and no
 * flag that can get stuck and lock out every later menu.
 *
 * `sheet()` is callable from anywhere; SheetHost renders it, mounted once at the
 * app root.
 */
export type SheetRequest = { title?: string; message?: string; options: SheetOption[] };

let deliver: ((r: SheetRequest | null) => void) | null = null;

export function sheet(request: SheetRequest) {
  deliver?.(request);
}

export function SheetHost() {
  const insets = useSafeAreaInsets();
  const [req, setReq] = React.useState<SheetRequest | null>(null);
  React.useEffect(() => {
    deliver = setReq;
    return () => { deliver = null; };
  }, []);

  const close = () => setReq(null);
  const pick = (o: SheetOption) => {
    setReq(null);
    // After the modal is down, so an action that opens a picker is not fighting
    // a dismissal.
    setTimeout(() => o.onPress?.(), 60);
  };

  return (
    <Modal visible={!!req} transparent animationType="fade" onRequestClose={close}
      statusBarTranslucent>
      <Pressable style={S.sheetDim} onPress={close}>
        {/* Stops a tap inside the sheet from reaching the dimmer behind it. */}
        {/* Clear of the home indicator, whatever the device. */}
        <Pressable style={[S.sheetBody, { paddingBottom: insets.bottom + 8 }]} onPress={() => {}}>
          <View style={S.sheetCard}>
            {req?.title || req?.message ? (
              <View style={S.sheetHead}>
                {req?.title ? <Text style={S.sheetTitle}>{req.title}</Text> : null}
                {req?.message ? <Text style={S.sheetMessage}>{req.message}</Text> : null}
              </View>
            ) : null}
            {(req?.options ?? []).map((o, i) => (
              <React.Fragment key={o.label}>
                {i > 0 || req?.title || req?.message ? <View style={S.sheetLine} /> : null}
                <Pressable
                  onPress={() => pick(o)}
                  style={({ pressed }) => [S.sheetItem, pressed && { backgroundColor: C.surface2 }]}
                >
                  <Text style={[S.sheetItemTxt, o.destructive && { color: C.bad }]}>{o.label}</Text>
                </Pressable>
              </React.Fragment>
            ))}
          </View>

          <Pressable
            onPress={close}
            style={({ pressed }) => [S.sheetCard, S.sheetItem, pressed && { backgroundColor: C.surface2 }]}
          >
            <Text style={[S.sheetItemTxt, { fontWeight: '700' }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
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
// One height and one radius for every full-width action, wherever it appears. The
// pinned "Add to WhatsApp" and the sheet's Cancel are the same shape of thing —
// a full-width button at the bottom of the screen — and looked like two different
// controls only because they were built in different places.
export const ACTION_H = 54;
export const ACTION_R = 14;

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

  // The sheet. Sized and spaced to iOS's own: 17pt actions on ~57pt rows, two
  // grouped cards with the cancel apart, and hairlines between the choices.
  sheetDim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  // Inset to the app's own margin, so the Cancel lines up with the buttons
  // pinned at the bottom of the screens behind it.
  sheetBody: { paddingHorizontal: EDGE, paddingTop: 8, gap: 8 },
  sheetCard: {
    backgroundColor: C.surface, borderRadius: ACTION_R, ...CORNER, overflow: 'hidden',
  },
  sheetHead: { paddingHorizontal: 16, paddingVertical: 14, alignItems: 'center', gap: 3 },
  sheetTitle: { color: C.text, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  sheetMessage: { color: C.muted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  sheetLine: { height: StyleSheet.hairlineWidth, backgroundColor: C.line },
  sheetItem: { minHeight: ACTION_H, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  sheetItemTxt: { color: C.accent, fontSize: 17, fontWeight: '500', textAlign: 'center' },

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
