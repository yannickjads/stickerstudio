import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Dimensions, Alert, ActivityIndicator, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  Canvas, Rect, Image as SkiaImage, Circle, Skia, ColorType, AlphaType,
  ImageFormat, type SkImage,
} from '@shopify/react-native-skia';
import { C } from '../theme';
import { Btn, Header, NavText, S } from '../ui';
import { Segmented, Slider } from '../editor/controls';
import { checkerRects } from '../editor/checker';
import type { Nav } from '../nav';
import { loadSkImage } from '../editor/renderCrop';
import { writeTempPng } from '../storage';
import { cutoutSubject, cutoutSupported } from '../../modules/subject-cutout';
import {
  fullMask, maskFromAlpha, floodRemove, paintStroke, feather, applyMask, compositeInto,
  keptFraction, type Mask, type Dirty,
} from '../editor/mask';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// This screen never scrolls — a scroll view under a drawing gesture is a fight
// nobody wins — so the canvas gives way to the controls on a short phone.
const BOX = Math.max(220, Math.min(SCREEN_W - 44, 380, SCREEN_H - 390));
const EDGE = Math.max(20, (SCREEN_W - BOX) / 2);
const MAX_UNDO = 12;

type Tool = 'wand' | 'erase' | 'restore';
const TOOLS: { value: Tool; label: string }[] = [
  { value: 'wand', label: 'Wand' },
  { value: 'erase', label: 'Erase' },
  { value: 'restore', label: 'Restore' },
];
const HINT: Record<Tool, string> = {
  wand: 'Tap a colour to remove it',
  erase: 'Drag to rub the background away',
  restore: 'Drag to paint the picture back',
};

/**
 * Manual background removal. Apple's subject lifting gets it most of the way;
 * this is the rest — tap a patch of background to remove that colour, then tidy
 * the edges with a brush.
 *
 * Nothing here is destructive. The source pixels are read once and never written
 * to; every tool edits a one-byte-per-pixel mask beside them, which is why
 * Restore can bring back exactly what was there and why the wand still judges a
 * pixel on its original colour after you have erased over it.
 */
export default function CutoutScreen({
  nav, uri, title, onDone,
}: { nav: Nav; uri: string; title?: string; onDone: (result: string) => void | Promise<void> }) {
  const insets = useSafeAreaInsets();

  const rgbaRef = useRef<Uint8Array | null>(null); // the source pixels, never modified
  const maskRef = useRef<Mask | null>(null);
  const viewRef = useRef<Uint8Array | null>(null); // source ⊗ mask, the preview pixels
  const sizeRef = useRef({ w: 0, h: 0 });
  const history = useRef<Mask[]>([]);

  const [img, setImg] = useState<SkImage | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('wand');
  const [tolerance, setTolerance] = useState(20);
  // Tapping a wall means "this colour is background". Taking it everywhere also
  // clears the pockets fenced in by hair or by an arm, which a connected fill can
  // never reach and which are what make a hand cut-out look botched.
  const [everywhere, setEverywhere] = useState(true);
  const [brush, setBrush] = useState(28);
  const [canUndo, setCanUndo] = useState(false);
  const [canAuto, setCanAuto] = useState(false);
  const [ranAuto, setRanAuto] = useState(false);
  const [touch, setTouch] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => { cutoutSupported().then(setCanAuto); }, []);

  // ---------------------------------------------------------------- pixels
  const makeImage = useCallback((bytes: Uint8Array) => {
    const { w, h } = sizeRef.current;
    return Skia.Image.MakeImage(
      { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
      Skia.Data.fromBytes(bytes), w * 4,
    );
  }, []);

  // Redraws are coalesced to one per frame and, for a brush, cover only the
  // patch the finger touched — a full 512² recomposite every move would stutter.
  const raf = useRef<number | null>(null);
  const pending = useRef<Dirty | 'full'>(null);
  const flush = useCallback(() => {
    raf.current = null;
    const rgba = rgbaRef.current, mask = maskRef.current, view = viewRef.current;
    if (!rgba || !mask || !view) return;
    const { w, h } = sizeRef.current;
    const d = pending.current;
    pending.current = null;
    compositeInto(rgba, mask, w, h, view, d === 'full' ? undefined : d ?? undefined);
    setImg(makeImage(view));
  }, [makeImage]);

  const invalidate = useCallback((d: Dirty | 'full') => {
    if (d === 'full' || pending.current === 'full') pending.current = 'full';
    else if (d) {
      const p = pending.current;
      pending.current = p
        ? { x0: Math.min(p.x0, d.x0), y0: Math.min(p.y0, d.y0), x1: Math.max(p.x1, d.x1), y1: Math.max(p.y1, d.y1) }
        : d;
    }
    if (raf.current == null) raf.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);

  // A brush drag builds a new image every frame, each holding a megabyte of
  // pixels. The cleanup runs only once React has already committed the NEXT
  // image, so the one being freed is guaranteed to be off-screen by then.
  useEffect(() => {
    const shown = img;
    return () => { try { shown?.dispose(); } catch {} };
  }, [img]);

  // ---------------------------------------------------------------- load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const src = await loadSkImage(uri);
        const w = src.width(), h = src.height();
        const rgba = src.readPixels(0, 0, {
          width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul,
        });
        src.dispose(); // everything from here on is drawn from `view`, not the source
        if (!(rgba instanceof Uint8Array)) throw new Error('Could not read this image.');
        if (!alive) return;
        rgbaRef.current = rgba;
        sizeRef.current = { w, h };
        // Whatever is already transparent starts out removed, so opening this on
        // an existing cut-out continues from where it left off.
        maskRef.current = maskFromAlpha(rgba, w, h);
        viewRef.current = compositeInto(rgba, maskRef.current, w, h);
        setImg(makeImage(viewRef.current));
        setReady(true);
      } catch (e: any) {
        // The alert pops a screen; if the user already left, it would pop theirs.
        if (!alive) return;
        Alert.alert('Could not open this image', String(e?.message || e), [{ text: 'OK', onPress: nav.pop }]);
      }
    })();
    return () => { alive = false; };
  }, [uri, makeImage, nav]);

  // ---------------------------------------------------------------- history
  // Snapshot first, commit only once the edit turns out to have changed something:
  // pushing then popping would silently drop the OLDEST step whenever the stack is
  // full, so a no-op tap would quietly cost you an undo.
  const snapshot = useCallback(() => {
    const m = maskRef.current;
    return m ? new Uint8Array(m) : null;
  }, []);

  const commit = useCallback((before: Uint8Array | null) => {
    if (!before) return;
    history.current.push(before);
    if (history.current.length > MAX_UNDO) history.current.shift();
    setCanUndo(true);
  }, []);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return;
    maskRef.current = prev;
    setCanUndo(history.current.length > 0);
    invalidate('full');
    Haptics.selectionAsync();
  }, [invalidate]);

  const reset = useCallback(() => {
    const rgba = rgbaRef.current;
    if (!rgba) return;
    commit(snapshot());
    const { w, h } = sizeRef.current;
    maskRef.current = fullMask(w, h);
    invalidate('full');
  }, [snapshot, commit, invalidate]);

  // ---------------------------------------------------------------- auto
  const auto = useCallback(async () => {
    if (busy) return;
    setBusy('finding the subject');
    try {
      const cut = await cutoutSubject(uri);
      if (!cut) { Alert.alert('Nothing stood out', 'Try removing the background by tapping it instead.'); return; }
      const im = await loadSkImage(cut);
      const { w, h } = sizeRef.current;
      const px = im.readPixels(0, 0, {
        width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul,
      });
      im.dispose();
      if (!(px instanceof Uint8Array)) throw new Error('Could not read the cut-out.');
      commit(snapshot());
      maskRef.current = maskFromAlpha(px, w, h);
      invalidate('full');
      setRanAuto(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Automatic cut-out failed', String(e?.message || e));
    } finally { setBusy(null); }
  }, [busy, uri, snapshot, commit, invalidate]);

  // ---------------------------------------------------------------- editing
  // The settings the touch handlers read live in refs, so the gesture below can
  // be built once and never replaced. Rebuilding a gesture object mid-drag — which
  // is what happens if it depends on state that changes on every touch move — is
  // how a brush stroke ends up cut in half.
  // Screen points -> image pixels, per axis. The source is square in every path
  // that exists today, but one shared factor would silently shear a picture that
  // isn't, and that is not a failure worth discovering on a device.
  const sx = () => sizeRef.current.w / BOX;
  const sy = () => sizeRef.current.h / BOX;
  const toolRef = useRef(tool);
  const brushRef = useRef(brush);
  const tolRef = useRef(tolerance);
  const everywhereRef = useRef(everywhere);
  const blockedRef = useRef(true);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => { tolRef.current = tolerance; }, [tolerance]);
  useEffect(() => { everywhereRef.current = everywhere; }, [everywhere]);
  useEffect(() => { blockedRef.current = !ready || !!busy; }, [ready, busy]);

  const wandAt = useCallback((x: number, y: number) => {
    const rgba = rgbaRef.current, mask = maskRef.current;
    if (!rgba || !mask) return;
    const { w, h } = sizeRef.current;
    const before = snapshot();
    const n = floodRemove(rgba, w, h, mask, x * sx(), y * sy(), tolRef.current,
      { connected: !everywhereRef.current });
    if (n === 0) return; // nothing matched: not an edit, so not an undo step
    commit(before);
    invalidate('full');
    Haptics.selectionAsync();
  }, [snapshot, commit, invalidate]);

  const last = useRef<{ x: number; y: number } | null>(null);
  const down = useRef<{ x: number; y: number; moved: number } | null>(null);
  const before = useRef<Uint8Array | null>(null);  // mask as it was when the stroke began
  const painted = useRef(false);

  const paintTo = useCallback((x: number, y: number) => {
    const mask = maskRef.current;
    if (!mask) return;
    const { w, h } = sizeRef.current;
    const px = x * sx(), py = y * sy();
    // From the previous point, so a fast swipe is a band and not a dotted line.
    const a = last.current ?? { x: px, y: py };
    const d = paintStroke(mask, w, h, a.x, a.y, px, py, brushRef.current,
      toolRef.current === 'erase' ? 0 : 255);
    last.current = { x: px, y: py };
    if (d) { painted.current = true; invalidate(d); }
  }, [invalidate]);

  const onDown = useCallback((x: number, y: number) => {
    if (blockedRef.current) return;
    down.current = { x, y, moved: 0 };
    setTouch({ x, y });      // also for the wand: the loupe is how you aim
    if (toolRef.current === 'wand') return;
    before.current = snapshot();
    painted.current = false;
    last.current = null;
    paintTo(x, y);
  }, [snapshot, paintTo]);

  const onMove = useCallback((x: number, y: number) => {
    const d = down.current;
    if (!d) return;
    d.moved = Math.max(d.moved, Math.hypot(x - d.x, y - d.y));
    setTouch({ x, y });
    if (toolRef.current === 'wand') return;
    paintTo(x, y);
  }, [paintTo]);

  // `success` is false when the system took the touch away — a notification, a
  // phone call, an edge swipe. Finishing the gesture is right either way; acting
  // on it is not.
  const onUp = useCallback((success: boolean) => {
    const d = down.current;
    const was = before.current;
    down.current = null;
    last.current = null;
    before.current = null;
    setTouch(null);
    if (toolRef.current === 'wand') {
      // A wand "tap" is a press that didn't wander — same gesture, different ending.
      if (success && d && d.moved < 12) wandAt(d.x, d.y);
      return;
    }
    // A stroke that changed no pixel is not worth an undo step.
    if (painted.current) commit(was);
    painted.current = false;
  }, [wandAt, commit]);

  // One gesture for all three tools, built once: which one runs is decided inside.
  const gesture = React.useMemo(() => Gesture.Pan()
    .maxPointers(1)
    .minDistance(0)
    .onBegin((e) => { 'worklet'; runOnJS(onDown)(e.x, e.y); })
    .onUpdate((e) => { 'worklet'; runOnJS(onMove)(e.x, e.y); })
    .onFinalize((_e, success) => { 'worklet'; runOnJS(onUp)(success); }),
  [onDown, onMove, onUp]);

  // ---------------------------------------------------------------- save
  const done = useCallback(async () => {
    const rgba = rgbaRef.current, mask = maskRef.current;
    if (!rgba || !mask || busy) return;
    if (keptFraction(mask) < 0.005) {
      Alert.alert('Nothing left', 'Almost the whole picture has been removed — undo a step first.');
      return;
    }
    setBusy('saving');
    try {
      const { w, h } = sizeRef.current;
      // One blur pass before baking: a hard 1-bit edge is what makes a hand-made
      // cut-out look pasted on.
      const out = applyMask(rgba, feather(mask, w, h, 1), w, h);
      const im = makeImage(out);
      if (!im) throw new Error('Could not build the image.');
      const b64 = im.encodeToBase64(ImageFormat.PNG, 100);
      im.dispose();
      const file = await writeTempPng(b64);
      // Awaited: whoever opened this screen writes the result away, and only then
      // does the screen underneath come back and reload.
      await onDone(file);
      nav.pop();
    } catch (e: any) {
      Alert.alert('Could not save', String(e?.message || e));
      setBusy(null);
    }
  }, [busy, makeImage, onDone, nav]);

  // ---------------------------------------------------------------- render
  const checks = React.useMemo(() => checkerRects(BOX), []);

  const brushOnScreen = brush / (sizeRef.current.w || BOX) * BOX;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 6 }}>
      <Header title={title ?? 'Background'} onBack={busy ? undefined : nav.pop}
        right={<NavText label="Done" onPress={done} disabled={!ready || !!busy} />} />

      <Text style={[S.hint, { textAlign: 'center', marginBottom: 10 }]}>
        {busy ?? HINT[tool]}
      </Text>

      <View style={{ width: BOX, height: BOX, alignSelf: 'center' }}>
        {/* The border lives on a sibling overlay, not on the gesture's own view:
            a borderWidth insets the child canvas, which would offset every touch
            coordinate by exactly that many points against the image. */}
        <GestureDetector gesture={gesture}>
          <View style={st.canvasWrap} collapsable={false}>
            <Canvas style={{ width: BOX, height: BOX }}>
              <Rect x={0} y={0} width={BOX} height={BOX} color="#171a23" />
              {checks}
              {img ? <SkiaImage image={img} x={0} y={0} width={BOX} height={BOX} fit="fill" /> : null}
              {/* brush outline, so the size slider means something before you draw */}
              {touch && tool !== 'wand' ? (
                <Circle cx={touch.x} cy={touch.y} r={brushOnScreen} style="stroke" strokeWidth={1.5}
                  color={tool === 'erase' ? C.accent2 : C.accent} />
              ) : null}
            </Canvas>
          </View>
        </GestureDetector>
        <View pointerEvents="none" style={st.border} />

        {!ready ? (
          <View style={[st.canvasWrap, st.loading]}><ActivityIndicator color={C.accent} /></View>
        ) : null}
      </View>

      <View style={st.controls}>
        {/* The one thing most people want, as one button. Everything below it is
            for fixing what the detector got wrong, and is dressed to look it. */}
        {canAuto ? (
          <Btn
            label={ranAuto ? 'Detect subject again' : 'Remove background'}
            onPress={auto}
            busy={busy === 'finding the subject'}
            disabled={!ready || !!busy}
          />
        ) : null}

        <View style={st.toolsHead}>
          <Text style={st.toolsTitle}>{canAuto ? 'Or do it by hand' : 'Remove by hand'}</Text>
          <View style={st.miniRow}>
            <Pressable onPress={undo} disabled={!canUndo || !!busy} hitSlop={8}>
              <Text style={[st.mini, (!canUndo || !!busy) && st.miniOff]}>Undo</Text>
            </Pressable>
            <Pressable onPress={reset} disabled={!ready || !!busy} hitSlop={8}>
              <Text style={[st.mini, (!ready || !!busy) && st.miniOff]}>Reset</Text>
            </Pressable>
          </View>
        </View>

        <Segmented options={TOOLS} value={tool} onChange={setTool} />

        {tool === 'wand' ? (
          <>
            <View style={st.sliderRow}>
              <Text style={st.sliderLabel}>Tolerance</Text>
              <Slider value={tolerance} min={2} max={70} onChange={(v) => setTolerance(Math.round(v))}
                format={(v) => String(Math.round(v))} />
            </View>
            {/* Same shape as the clip-length picker on the crop screen: a quiet
                label on the left, the choice as one pill on the right. */}
            <View style={st.scopeRow}>
              <Text style={st.sliderLabel}>Remove it</Text>
              <View style={st.pills}>
                {[{ on: true, label: 'Everywhere' }, { on: false, label: 'Only here' }].map((o) => (
                  <Pressable key={o.label} onPress={() => setEverywhere(o.on)}
                    style={[st.pill, everywhere === o.on && st.pillOn]}>
                    <Text style={[st.pillTxt, everywhere === o.on && st.pillTxtOn]}>{o.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </>
        ) : (
          <View style={st.sliderRow}>
            <Text style={st.sliderLabel}>Brush</Text>
            <Slider value={brush} min={6} max={90} onChange={(v) => setBrush(Math.round(v))}
              format={(v) => String(Math.round(v))} />
          </View>
        )}

      </View>
    </View>
  );
}

const st = StyleSheet.create({
  canvasWrap: {
    width: BOX, height: BOX, borderRadius: 14, borderCurve: 'continuous', overflow: 'hidden',
    backgroundColor: C.surface,
  },
  border: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 14, borderCurve: 'continuous', borderWidth: 2, borderColor: C.accent,
  },
  loading: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  controls: { paddingHorizontal: EDGE, marginTop: 18, gap: 14 },
  toolsHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 4, marginBottom: -4,
  },
  toolsTitle: { color: C.muted, fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },
  miniRow: { flexDirection: 'row', gap: 18 },
  mini: { color: C.accent, fontSize: 15, fontWeight: '600' },
  miniOff: { opacity: 0.3 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sliderLabel: { color: C.muted, fontSize: 14, fontWeight: '600', width: 74 },
  scopeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: -4 },
  pills: {
    flexDirection: 'row', backgroundColor: C.surface2, borderRadius: 9,
    borderCurve: 'continuous', padding: 2,
  },
  pill: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 7, borderCurve: 'continuous' },
  pillOn: { backgroundColor: C.accent },
  pillTxt: { color: C.text, fontSize: 13, fontWeight: '600' },
  pillTxtOn: { color: C.ink },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, paddingHorizontal: 0 },
});
