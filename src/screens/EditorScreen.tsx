import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue, useDerivedValue, runOnJS } from 'react-native-reanimated';
import { Canvas, Group, Fill, useCanvasRef, Skia, type SkImage, type Transforms3d } from '@shopify/react-native-skia';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { C } from '../theme';
import { Header } from '../ui';
import type { Nav } from '../nav';
import type { EditorDocument, Layer, TextLayer, ImageLayer } from '../types';
import { DOC_SCHEMA_VERSION } from '../types';
import {
  getSticker, getDocument, getAsset, createAsset, createDocument,
  updateDocument, updateStickerImage, linkStickerDocument,
} from '../db';
import { newId, deleteFile } from '../storage';
import { ImageLayerView, TextLayerView } from '../editor/layers';
import { SelectionOverlay } from '../editor/SelectionOverlay';
import { snapshotToPng } from '../editor/exportDoc';
import { loadSkImage, ensureDecodableUri } from '../editor/renderCrop';
import TextModal, { type TextDraft } from '../editor/TextModal';
import { ToolButton, Segmented, SwatchRow, Slider } from '../editor/controls';
import { imageBox, pointInLayer } from '../editor/geometry';
import { layoutText } from '../editor/textLayout';

const CANVAS = 512;
const { width: SCREEN_W } = Dimensions.get('window');
const DISPLAY = Math.min(SCREEN_W - 24, 400);
const DISP_SCALE = DISPLAY / CANVAS;
const BG_COLORS = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#5e5ce6', '#ff2d55'];
const NEW_TEXT: TextDraft = { text: 'Text', fontFamily: 'Arial Rounded MT Bold', fontSize: 96, fillColor: '#ffffff', stroke: { color: '#000000', width: 10 } };

const touch = (d: EditorDocument): EditorDocument => ({ ...d, updatedAt: Date.now() });
const updateLayer = (d: EditorDocument, id: string, fn: (l: Layer) => Layer): EditorDocument =>
  touch({ ...d, layers: d.layers.map((l) => (l.id === id ? fn(l) : l)) });
const withLayers = (d: EditorDocument, layers: Layer[]): EditorDocument => touch({ ...d, layers });

type ImgMap = Record<string, SkImage>;
const boxOf = (layer: Layer, imgs: ImgMap) => {
  if (layer.type === 'image') {
    const im = imgs[layer.assetId];
    if (!im) return { w: CANVAS, h: CANVAS };
    return imageBox(layer, im.width(), im.height(), CANVAS, CANVAS);
  }
  const L = layoutText(layer);
  return { w: Math.max(L.width, 12), h: Math.max(L.height, 12) };
};

export default function EditorScreen({ nav, stickerId, packName }: { nav: Nav; stickerId: string; packName: string }) {
  const insets = useSafeAreaInsets();
  const contentRef = useCanvasRef();
  const [doc, setDoc] = useState<EditorDocument | null>(null);
  const [images, setImages] = useState<ImgMap>({});
  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [textEdit, setTextEdit] = useState<{ layerId: string | null } | null>(null);
  const [panel, setPanel] = useState<null | 'opacity' | 'fit' | 'bg'>(null);

  const docRef = useRef<EditorDocument | null>(null);
  const baselineRef = useRef<EditorDocument | null>(null); // last persisted state
  const imagesRef = useRef<ImgMap>({});
  const selRef = useRef<string | null>(null);
  const hist = useRef<EditorDocument[]>([]);
  useEffect(() => { docRef.current = doc; }, [doc]);
  useEffect(() => { imagesRef.current = images; }, [images]);

  // live transform of the selected layer (UI thread)
  const lx = useSharedValue(0), ly = useSharedValue(0), ls = useSharedValue(1), lr = useSharedValue(0);
  const startScale = useSharedValue(1), startRot = useSharedValue(0);
  const activeSel = useSharedValue(false), activeCount = useSharedValue(0);
  const liveTransform = useDerivedValue<Transforms3d>(() => [
    { translateX: CANVAS / 2 + lx.value }, { translateY: CANVAS / 2 + ly.value },
    { rotate: lr.value }, { scale: ls.value },
  ]);

  // Select a layer AND seed the live transform in the same tick (no selection flash).
  const focus = (id: string | null) => {
    selRef.current = id;
    const l = id ? docRef.current?.layers.find((x) => x.id === id) ?? null : null;
    if (l) { lx.value = l.transform.x; ly.value = l.transform.y; ls.value = l.transform.scaleX; lr.value = l.transform.rotation; }
    activeSel.value = !!l;
    setSelId(id);
    setPanel(null);
  };

  // ---- load (preload every image so export is never blank) ----
  useEffect(() => {
    let alive = true;
    (async () => {
      const st = await getSticker(stickerId);
      if (!st) { nav.pop(); return; }
      let document = st.documentId ? await getDocument(st.documentId) : null;
      if (!document) {
        const asset = await createAsset(st.uri, st.width, st.height);
        const now = Date.now();
        document = {
          id: newId(), schemaVersion: DOC_SCHEMA_VERSION,
          canvas: { width: CANVAS, height: CANVAS, background: 'transparent' },
          layers: [{
            id: newId(), type: 'image', assetId: asset.id, fit: 'cover',
            visible: true, locked: false, opacity: 1,
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, zIndex: 0,
          }],
          createdAt: now, updatedAt: now,
        };
        await createDocument(document);
        await linkStickerDocument(st.id, document.id);
      }
      const imgs: ImgMap = {};
      for (const l of document.layers) {
        if (l.type === 'image') {
          const a = await getAsset(l.assetId);
          if (a) { try { imgs[l.assetId] = await loadSkImage(a.localUri); } catch {} }
        }
      }
      if (!alive) return;
      docRef.current = document; baselineRef.current = document; imagesRef.current = imgs;
      setImages(imgs); setDoc(document);
      focus(document.layers[document.layers.length - 1]?.id ?? null);
    })();
    return () => { alive = false; };
  }, [stickerId, nav]);

  // ---- mutate + history (persist only on Save) ----
  // dirty = the doc differs from the last persisted state (reference compare works
  // because undo restores the exact object that was pushed).
  const refreshDirty = () => setDirty(docRef.current !== baselineRef.current);
  const apply = (fn: (d: EditorDocument) => EditorDocument) => {
    const cur = docRef.current; if (!cur) return;
    hist.current.push(cur); if (hist.current.length > 50) hist.current.shift();
    const next = fn(cur); docRef.current = next; setDoc(next); setCanUndo(true); refreshDirty();
  };
  const applyLayer = (id: string, fn: (l: Layer) => Layer) => apply((d) => updateLayer(d, id, fn));
  const applyLive = (fn: (d: EditorDocument) => EditorDocument) => { // no history push (slider drags)
    const cur = docRef.current; if (!cur) return;
    const next = fn(cur); docRef.current = next; setDoc(next); refreshDirty();
  };
  const pushHistoryOnce = () => { const cur = docRef.current; if (cur) { hist.current.push(cur); if (hist.current.length > 50) hist.current.shift(); setCanUndo(true); } };

  const undo = () => {
    const prev = hist.current.pop(); if (!prev) return;
    docRef.current = prev; setDoc(prev); setCanUndo(hist.current.length > 0); refreshDirty();
    const id = selRef.current && prev.layers.find((l) => l.id === selRef.current) ? selRef.current : (prev.layers[prev.layers.length - 1]?.id ?? null);
    focus(id);
  };

  const commitTransform = () => {
    const id = selRef.current; if (!id) return;
    const l = docRef.current?.layers.find((x) => x.id === id); if (!l) return;
    const t = l.transform; // no-op guard: never record a commit that changes nothing
    if (t.x === lx.value && t.y === ly.value && t.scaleX === ls.value && t.rotation === lr.value) return;
    applyLayer(id, (ll) => ({ ...ll, transform: { x: lx.value, y: ly.value, scaleX: ls.value, scaleY: ls.value, rotation: lr.value } }));
  };
  const tapSelect = (x: number, y: number) => {
    const px = x / DISP_SCALE, py = y / DISP_SCALE;
    const layers = docRef.current?.layers ?? [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]; if (!l.visible) continue;
      const b = boxOf(l, imagesRef.current);
      if (pointInLayer(px, py, l.transform, b.w, b.h, CANVAS, CANVAS)) { Haptics.selectionAsync(); focus(l.id); return; }
    }
    focus(null);
  };

  // ---- gestures ----
  // Count only gestures that actually ACTIVATE (onStart), never taps: Pan fires
  // onBegin/onFinalize on a plain touch too, which must not commit or dirty anything.
  const panOn = useSharedValue(false), pinchOn = useSharedValue(false), rotOn = useSharedValue(false);
  const pan = Gesture.Pan()
    .onStart(() => { 'worklet'; if (!activeSel.value) return; panOn.value = true; activeCount.value += 1; })
    .onChange((e) => { 'worklet'; if (!activeSel.value) return; lx.value += e.changeX / DISP_SCALE; ly.value += e.changeY / DISP_SCALE; })
    .onFinalize(() => { 'worklet'; if (!panOn.value) return; panOn.value = false; activeCount.value -= 1; if (activeCount.value === 0) runOnJS(commitTransform)(); });
  const pinch = Gesture.Pinch()
    .onStart(() => { 'worklet'; if (!activeSel.value) return; pinchOn.value = true; activeCount.value += 1; startScale.value = ls.value; })
    .onUpdate((e) => { 'worklet'; if (!pinchOn.value) return; ls.value = Math.min(Math.max(startScale.value * e.scale, 0.1), 8); })
    .onFinalize(() => { 'worklet'; if (!pinchOn.value) return; pinchOn.value = false; activeCount.value -= 1; if (activeCount.value === 0) runOnJS(commitTransform)(); });
  const rotate = Gesture.Rotation()
    .onStart(() => { 'worklet'; if (!activeSel.value) return; rotOn.value = true; activeCount.value += 1; startRot.value = lr.value; })
    .onUpdate((e) => { 'worklet'; if (!rotOn.value) return; lr.value = startRot.value + e.rotation; })
    .onFinalize(() => { 'worklet'; if (!rotOn.value) return; rotOn.value = false; activeCount.value -= 1; if (activeCount.value === 0) runOnJS(commitTransform)(); });
  const tap = Gesture.Tap().maxDistance(12).onEnd((e) => { 'worklet'; runOnJS(tapSelect)(e.x, e.y); });
  const gesture = Gesture.Exclusive(Gesture.Simultaneous(pan, pinch, rotate), tap);

  // ---- toolbar ops ----
  const sel = doc?.layers.find((l) => l.id === selId) ?? null;

  const addTextLayer = (d: TextDraft) => {
    const layer: TextLayer = {
      id: newId(), type: 'text', ...d, align: 'center', visible: true, locked: false, opacity: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, zIndex: (docRef.current?.layers.length ?? 0),
    };
    apply((dd) => withLayers(dd, [...dd.layers, layer])); focus(layer.id); Haptics.selectionAsync();
  };
  const onTextSave = (d: TextDraft) => {
    const te = textEdit; setTextEdit(null); if (!te) return;
    if (te.layerId) applyLayer(te.layerId, (l) => ({ ...(l as TextLayer), ...d }));
    else addTextLayer(d);
  };
  const addImage = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      const srcUri = await ensureDecodableUri(a.uri); // HEIC etc. -> decodable
      const asset = await createAsset(srcUri, a.width ?? CANVAS, a.height ?? CANVAS);
      if (srcUri !== a.uri) await deleteFile(srcUri); // transcode temp no longer needed
      const im = await loadSkImage(asset.localUri);
      imagesRef.current = { ...imagesRef.current, [asset.id]: im }; setImages((p) => ({ ...p, [asset.id]: im }));
      const layer: ImageLayer = {
        id: newId(), type: 'image', assetId: asset.id, fit: 'contain', visible: true, locked: false, opacity: 1,
        transform: { x: 0, y: 0, scaleX: 0.8, scaleY: 0.8, rotation: 0 }, zIndex: (docRef.current?.layers.length ?? 0),
      };
      apply((dd) => withLayers(dd, [...dd.layers, layer])); focus(layer.id); Haptics.selectionAsync();
    } catch (e: any) { Alert.alert('Add photo failed', String(e?.message || e)); }
  };
  const duplicate = () => {
    if (!sel) return;
    const copy = { ...sel, id: newId(), transform: { ...sel.transform, x: sel.transform.x + 28, y: sel.transform.y + 28 } } as Layer;
    apply((dd) => { const i = dd.layers.findIndex((l) => l.id === sel.id); const layers = [...dd.layers]; layers.splice(i + 1, 0, copy); return withLayers(dd, layers); });
    focus(copy.id);
  };
  const removeSel = () => {
    if (!sel || !doc) return;
    if (doc.layers.length <= 1) { Alert.alert('Keep one layer', 'A sticker needs at least one layer.'); return; }
    const idx = doc.layers.findIndex((l) => l.id === sel.id);
    const rest = doc.layers.filter((l) => l.id !== sel.id);
    apply((dd) => withLayers(dd, dd.layers.filter((l) => l.id !== sel.id)));
    focus(rest[Math.max(0, idx - 1)]?.id ?? rest[0]?.id ?? null);
  };
  const reorder = (dir: -1 | 1) => {
    if (!sel || !doc) return;
    const i = doc.layers.findIndex((l) => l.id === sel.id); const j = i + dir;
    if (j < 0 || j >= doc.layers.length) return;
    apply((dd) => { const layers = [...dd.layers]; const [m] = layers.splice(i, 1); layers.splice(j, 0, m); return withLayers(dd, layers); });
  };
  const setBg = (c: string | null) => apply((dd) => touch({ ...dd, canvas: { ...dd.canvas, background: c ?? 'transparent' } }));
  const setFit = (f: ImageLayer['fit']) => { if (sel?.type === 'image') applyLayer(sel.id, (l) => ({ ...(l as ImageLayer), fit: f })); };
  const setOpacity = (v: number) => { if (sel) applyLive((dd) => updateLayer(dd, sel.id, (l) => ({ ...l, opacity: v }))); };

  const fitMeaningful = (l: Layer): boolean => {
    if (l.type !== 'image') return false;
    const im = images[l.assetId]; if (!im) return false;
    const c = l.crop ?? { x: 0, y: 0, width: im.width(), height: im.height() };
    return Math.abs(c.width / c.height - 1) > 0.02;
  };

  // ---- save / back ----
  const onSave = async () => {
    if (!doc || busy) return;
    const missing = doc.layers.some((l) => l.type === 'image' && l.visible && !images[l.assetId]);
    setBusy(true);
    try {
      if (missing) throw new Error('An image is still loading — try again in a moment.');
      const snap = contentRef.current?.makeImageSnapshot();
      if (!snap) throw new Error('Could not render the canvas.');
      const pngUri = await snapshotToPng(snap, CANVAS);
      try { await updateDocument(doc); await updateStickerImage(stickerId, pngUri, CANVAS, CANVAS); }
      finally { await deleteFile(pngUri); }
      baselineRef.current = doc; setDirty(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      nav.pop();
    } catch (e: any) { Alert.alert('Save failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const onBack = () => {
    if (busy) return;
    if (!dirty) { nav.pop(); return; }
    Alert.alert('Save your changes?', undefined, [
      { text: 'Save', onPress: onSave },
      { text: 'Discard', style: 'destructive', onPress: () => nav.pop() },
      { text: 'Keep editing', style: 'cancel' },
    ]);
  };

  if (!doc) {
    return <View style={[st.fill, st.center]}><ActivityIndicator color={C.accent} /></View>;
  }

  const initialDraft: TextDraft = (() => {
    const l = textEdit?.layerId ? (doc.layers.find((x) => x.id === textEdit.layerId) as TextLayer | undefined) : undefined;
    return l ? { text: l.text, fontFamily: l.fontFamily, fontSize: l.fontSize, fillColor: l.fillColor, stroke: l.stroke } : NEW_TEXT;
  })();
  const selBox = sel ? boxOf(sel, images) : null;
  const togglePanel = (p: 'opacity' | 'fit' | 'bg') => setPanel((cur) => (cur === p ? null : p));

  return (
    <View style={[st.fill, { paddingTop: insets.top + 6 }]}>
      <Header title={`Edit · ${packName}`} onBack={onBack} right={
        <View style={st.headerRight}>
          <Pressable onPress={undo} disabled={!canUndo} hitSlop={8} style={[st.undo, !canUndo && { opacity: 0.3 }]}>
            <Ionicons name="arrow-undo" size={20} color={C.text} />
          </Pressable>
          <Pressable onPress={onSave} disabled={busy} style={st.save}>
            {busy ? <ActivityIndicator color={C.ink} /> : <Text style={st.saveTxt}>Save</Text>}
          </Pressable>
        </View>
      } />

      {/* canvas */}
      <View style={st.stage}>
        <View style={{ width: DISPLAY, height: DISPLAY, borderRadius: 16, overflow: 'hidden' }}>
          <Checkerboard size={DISPLAY} />
          <GestureDetector gesture={gesture}>
            <Canvas ref={contentRef} style={{ width: DISPLAY, height: DISPLAY }}>
              <Group transform={[{ scale: DISP_SCALE }]}>
                {doc.canvas.background !== 'transparent' ? <Fill color={doc.canvas.background} /> : null}
                {doc.layers.map((layer) => {
                  const isSel = layer.id === selId;
                  const t = layer.transform;
                  const staticT: Transforms3d = [
                    { translateX: CANVAS / 2 + t.x }, { translateY: CANVAS / 2 + t.y }, { rotate: t.rotation }, { scale: t.scaleX },
                  ];
                  const transform = isSel ? liveTransform : staticT;
                  if (layer.type === 'image') {
                    const im = images[layer.assetId]; if (!im) return null;
                    return <ImageLayerView key={layer.id} layer={layer} image={im} canvasW={CANVAS} canvasH={CANVAS} transform={transform} />;
                  }
                  return <TextLayerView key={layer.id} layer={layer} transform={transform} />;
                })}
              </Group>
            </Canvas>
          </GestureDetector>
          {sel && selBox ? (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <SelectionOverlay box={selBox} transform={liveTransform} dispScale={DISP_SCALE} display={DISPLAY} />
            </View>
          ) : null}
        </View>
      </View>
      <Text style={st.hint}>{sel ? 'drag · pinch · rotate — tap elsewhere to deselect' : 'tap an object to select it'}</Text>

      {/* contextual panel */}
      {panel === 'opacity' && sel ? (
        <View style={st.panel}>
          <Ionicons name="contrast-outline" size={18} color={C.muted} />
          <Slider value={sel.opacity} min={0.1} max={1} onStart={pushHistoryOnce} onChange={setOpacity} format={(v) => `${Math.round(v * 100)}%`} />
        </View>
      ) : null}
      {panel === 'fit' && sel?.type === 'image' ? (
        <View style={st.panel}>
          <Segmented value={sel.fit as 'cover' | 'contain' | 'stretch'} onChange={setFit} options={[{ value: 'cover', label: 'Fill' }, { value: 'contain', label: 'Fit' }, { value: 'stretch', label: 'Stretch' }]} />
        </View>
      ) : null}
      {panel === 'bg' ? (
        <View style={st.panel}>
          <SwatchRow allowNone colors={BG_COLORS} value={doc.canvas.background} onChange={setBg} />
        </View>
      ) : null}

      {/* contextual bottom bar */}
      <View style={[st.bar, { paddingBottom: insets.bottom + 8 }]}>
        {!sel ? (
          <>
            <ToolButton icon="text" label="Text" onPress={() => setTextEdit({ layerId: null })} />
            <ToolButton icon="image-outline" label="Photo" onPress={addImage} />
            <ToolButton icon="color-palette-outline" label="Background" active={panel === 'bg'} onPress={() => togglePanel('bg')} />
          </>
        ) : (
          <>
            {sel.type === 'text'
              ? <ToolButton icon="create-outline" label="Edit" onPress={() => setTextEdit({ layerId: sel.id })} />
              : fitMeaningful(sel)
                ? <ToolButton icon="resize-outline" label="Fit" active={panel === 'fit'} onPress={() => togglePanel('fit')} />
                : <ToolButton icon="image-outline" label="Photo" onPress={addImage} />}
            <ToolButton icon="contrast-outline" label="Opacity" active={panel === 'opacity'} onPress={() => togglePanel('opacity')} />
            <ToolButton icon="copy-outline" label="Duplicate" onPress={duplicate} />
            <ToolButton icon="chevron-up" label="Forward" onPress={() => reorder(1)} />
            <ToolButton icon="chevron-down" label="Back" onPress={() => reorder(-1)} />
            <ToolButton icon="trash-outline" label="Delete" danger onPress={removeSel} />
          </>
        )}
      </View>

      <TextModal visible={!!textEdit} initial={initialDraft} onCancel={() => setTextEdit(null)} onSave={onTextSave} />
    </View>
  );
}

function Checkerboard({ size }: { size: number }) {
  const n = 8, cell = size / n; const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    cells.push(<View key={`${r}-${c}`} style={{ position: 'absolute', left: c * cell, top: r * cell, width: cell, height: cell, backgroundColor: (r + c) % 2 === 0 ? '#e9ecf2' : '#c7cdda' }} />);
  }
  return <View style={StyleSheet.absoluteFill}>{cells}</View>;
}

const st = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  undo: { padding: 4 },
  save: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, minWidth: 60, alignItems: 'center' },
  saveTxt: { color: C.ink, fontWeight: '800', fontSize: 15 },
  stage: { alignItems: 'center', justifyContent: 'center', paddingTop: 10 },
  hint: { color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 12 },
  panel: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, marginHorizontal: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  bar: { marginTop: 'auto', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingTop: 10, paddingHorizontal: 8, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.surface },
});
