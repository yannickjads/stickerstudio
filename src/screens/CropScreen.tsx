import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { File } from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { Btn, Header, S } from '../ui';
import type { Nav, MediaSource } from '../nav';
import type { EditorDocument } from '../types';
import { DOC_SCHEMA_VERSION, PACK_MAX } from '../types';
import {
  addSticker, createAsset, createDocument, createPack, getPack, deleteDocumentAndAssets,
  deleteAssetById, ensurePackSlots, freeSlots, getSticker, getDocument, getAsset,
  updateStickerImage, updateDocument,
} from '../db';
import { deleteRender, deleteFile, newId } from '../storage';
import { renderCroppedPng, ensureDecodableUri, loadSkImage, STICKER_SIZE } from '../editor/renderCrop';
import { renderCroppedGif, maybeAnimatedSource } from '../editor/renderAnimated';
import {
  renderVideoSticker, QUALITY, MAX_CLIP_MS, MAX_STICKER_BYTES, FPS_CHOICES, DEFAULT_FPS,
  type QualityKey,
} from '../editor/renderVideo';
import { videoInfo, extractFrames } from '../../modules/video-frames';
import Cropper from '../SquareCropper';
import { Slider } from '../editor/controls';

type Item = {
  id: string; uri: string; w: number; h: number; maybeAnimated: boolean;
  video?: { durationMs: number };  // set for clips
  poster?: string;                 // still frame shown in the cropper
};
type Shape = 'square' | 'original' | 'free';
const { width: SCREEN_W } = Dimensions.get('window');
const BOX = Math.min(SCREEN_W - 44, 380);
const EDGE = (SCREEN_W - BOX) / 2; // everything aligns to the crop box edges
const HANDLE = 48;      // freeform corner: the touch target
const GRIP = 22;        // ...and the bracket drawn inside it
const FREE_MIN = 120;   // smallest the crop window may be dragged (caps the ratio at ~3:1)

export default function CropScreen({ nav, packId, packName, startSlot, editStickerId, source = 'photos' }: { nav: Nav; packId: string; packName: string; startSlot?: number; editStickerId?: string; source?: MediaSource }) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Item[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [startMs, setStartMs] = useState(0);       // clip start
  const [clipMs, setClipMs] = useState(MAX_CLIP_MS); // clip length
  const [quality, setQuality] = useState<QualityKey>('balanced');
  const [fps, setFps] = useState<number>(DEFAULT_FPS);
  const [optimize, setOptimize] = useState(true);
  // The rendered clip, exactly as it will be saved — same code path, same file.
  // Any change to a setting drops it, so whatever is on screen is always current,
  // and saving reuses the file instead of encoding the whole thing a second time.
  const [preview, setPreview] = useState<{ uri: string; bytes: number } | null>(null);
  const dropPreview = () => setPreview((p) => { if (p) deleteFile(p.uri); return null; });
  // Shape of the crop. 'original' keeps the picture's own ratio; a sticker being
  // re-cropped carries whatever ratio it was made with, as customAr.
  const [aspect, setAspect] = useState<Shape>('square');
  const [customAr, setCustomAr] = useState<number | null>(null);
  // Freeform: the crop window itself is dragged to whatever shape you want.
  const [free, setFree] = useState({ w: BOX, h: BOX });
  const freeStart = useRef({ w: BOX, h: BOX });
  const launched = useRef(false);
  // Re-cropping an existing sticker: same screen, same maths, but it replaces one
  // sticker instead of filling slots.
  const editing = !!editStickerId;
  const editDocRef = useRef<{ docId: string; layerId: string } | null>(null);

  // Save target: a queue of free slots starting at startSlot (wrapping around to
  // earlier gaps); when it runs dry, auto-creates "<name> 2", "<name> 3", ...
  const targetRef = useRef<{ id: string; queue: number[] } | null>(null);
  const baseRef = useRef<{ name: string; author: string; seq: number }>({ name: packName, author: '', seq: 2 });
  const splitsRef = useRef<string[]>([]);

  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  const resetTransform = () => { tx.value = 0; ty.value = 0; scale.value = 1; };

  useEffect(() => {
    if (editing) return;
    (async () => {
      await ensurePackSlots(packId);
      const [p, free] = await Promise.all([getPack(packId), freeSlots(packId)]);
      const s0 = startSlot ?? 0;
      const queue = [...free.filter((x) => x >= s0), ...free.filter((x) => x < s0)];
      targetRef.current = { id: packId, queue };
      baseRef.current = { name: p?.name ?? packName, author: p?.author ?? '', seq: 2 };
      setRemaining(queue.length);
    })();
  }, [packId, packName, startSlot, editing]);

  // Re-crop: the stored original, not the 512px render, so a second crop is as
  // sharp as the first.
  useEffect(() => {
    if (!editStickerId || launched.current) return;
    launched.current = true;
    (async () => {
      try {
        const s = await getSticker(editStickerId);
        const doc = s?.documentId ? await getDocument(s.documentId) : null;
        const layer = doc?.layers.find((l) => l.type === 'image' && 'assetId' in l && l.assetId);
        const asset = layer && 'assetId' in layer && layer.assetId ? await getAsset(layer.assetId) : null;
        if (!s || !doc || !layer || !asset) throw new Error('The original image for this sticker is gone.');
        editDocRef.current = { docId: doc.id, layerId: layer.id };
        // Start from the crop the sticker already has — the inverse of cropRect —
        // so "Crop again" adjusts the framing instead of throwing it away.
        const c = 'crop' in layer ? layer.crop : null;
        if (c && c.width > 0 && c.height > 0 && asset.width > 0 && asset.height > 0) {
          const ar = c.width / c.height;
          setCustomAr(ar);
          // Same unrounded box the cropper will use, or the rect cannot be reproduced.
          const vw = ar >= 1 ? BOX : BOX * ar;
          const vh = ar >= 1 ? BOX / ar : BOX;
          const base = Math.max(vw / asset.width, vh / asset.height);
          const eff = vw / c.width;
          scale.value = Math.min(Math.max(eff / base, 1), 8);
          tx.value = eff * (asset.width / 2 - c.x - c.width / 2);
          ty.value = eff * (asset.height / 2 - c.y - c.height / 2);
        }
        setItems([{
          id: s.id, uri: asset.localUri, w: asset.width, h: asset.height,
          maybeAnimated: maybeAnimatedSource(asset.localUri, null),
        }]);
      } catch (e: any) {
        Alert.alert('Cannot crop again', String(e?.message || e), [{ text: 'OK', onPress: nav.pop }]);
      }
    })();
  }, [editStickerId, nav]);

  useEffect(() => {
    if (editing || launched.current) return;
    launched.current = true;
    (async () => {
      // A file picked out of Files has no dimensions attached, so it is measured
      // once here; the photo picker supplies them.
      type Picked = { uri: string; w: number; h: number; mime: string | null; video: boolean };
      let picks: Picked[] = [];
      if (source === 'files') {
        // MIME types, not UTIs: expo-document-picker maps each one through
        // UTType(mimeType:) and silently DROPS anything that fails, so a UTI like
        // "public.image" leaves the picker with an empty allow-list and every file
        // greyed out. "image/*" is special-cased to UTType.image, which covers
        // webp, png, gif, jpeg and heic in one go.
        const res = await DocumentPicker.getDocumentAsync({
          type: ['image/*'], multiple: true, copyToCacheDirectory: true,
        });
        if (res.canceled || !res.assets?.length) { nav.pop(); return; }
        for (const a of res.assets) {
          let w = 512, h = 512;
          try { const im = await loadSkImage(a.uri); w = im.width(); h = im.height(); im.dispose(); } catch {}
          picks.push({ uri: a.uri, w, h, mime: a.mimeType ?? a.name ?? null, video: false });
        }
      } else {
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: source === 'videos' ? ['videos']
            : source === 'mixed' ? ['images', 'videos']
            : ['images'],
          allowsMultipleSelection: true, quality: 1,
          orderedSelection: true, // a batch is processed in the order it was picked
        });
        if (res.canceled || !res.assets?.length) { nav.pop(); return; }
        picks = res.assets.map((a) => ({
          uri: a.uri, w: a.width ?? 512, h: a.height ?? 512,
          mime: a.mimeType ?? a.fileName ?? null,
          video: a.type === 'video' || /\.(mov|mp4|m4v)$/i.test(a.uri),
        }));
      }

      const picked: Item[] = [];
      for (let i = 0; i < picks.length; i++) {
        const a = picks[i];
        const item: Item = {
          id: `${Date.now()}-${i}`, uri: a.uri, w: a.w, h: a.h,
          maybeAnimated: maybeAnimatedSource(a.uri, a.mime),
        };
        // A clip needs its length, plus a still to aim the cropper at.
        if (a.video) {
          const info = await videoInfo(a.uri);
          if (info && info.durationMs > 0) {
            item.video = { durationMs: info.durationMs };
            if (info.width && info.height) { item.w = info.width; item.h = info.height; }
            try { item.poster = (await extractFrames(a.uri, 0, 0, 1, 720))[0]; } catch {}
          }
        }
        picked.push(item);
      }
      if (!picked.length) { nav.pop(); return; }
      setItems(picked);
    })();
  }, [nav, editing, source]);

  // A clip can be shorter than the chosen length.
  const effClip = (it: Item) => Math.min(clipMs, it.video?.durationMs ?? clipMs);

  // Show the frame the clip actually starts on, so you crop what you'll get.
  // Extraction is far slower than the finger, so only the last scrub position is
  // ever decoded, and only once the slider goes quiet.
  const posterSeq = useRef(0);
  const posterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (posterTimer.current) clearTimeout(posterTimer.current); }, []);

  const schedulePoster = (it: Item, atMs: number) => {
    if (!it.video) return;
    if (posterTimer.current) clearTimeout(posterTimer.current);
    posterTimer.current = setTimeout(async () => {
      const seq = ++posterSeq.current;
      try {
        const [frame] = await extractFrames(it.uri, atMs, 0, 1, 720);
        if (seq !== posterSeq.current || !frame) return; // a newer scrub won
        setItems((prev) => prev && prev.map((x) => (x.id === it.id ? { ...x, poster: frame } : x)));
      } catch {
        // keep the previous poster
      }
    }, 180);
  };

  const tick = (on: boolean, label: string) => (on ? `✓  ${label}` : label);

  // Only the choices that must be made BEFORE the file is encoded live here.
  // Everything you can still change afterwards — background, emoji, pack icon,
  // cropping again — belongs to the sticker screen, which is the one place a
  // sticker is edited whether you just made it or made it last week.
  const clipOptions = () => {
    Alert.alert('Clip options', undefined, [
      ...(Object.keys(QUALITY) as QualityKey[]).map((k) => ({
        text: tick(quality === k, QUALITY[k].label),
        onPress: () => { setQuality(k); dropPreview(); },
      })),
      {
        text: tick(optimize, 'Smaller file size'),
        onPress: () => { setOptimize((v) => !v); dropPreview(); },
      },
      { text: 'Done', style: 'cancel' as const },
    ]);
  };

  // Dragging the freeform corner. The window stays centred in its box, so the
  // opposite edge moves with it and the finger travels half of each size change.
  // The gesture is built once and reads through refs, so it is never swapped out
  // mid-drag.
  const freeRef = useRef(free);
  useEffect(() => { freeRef.current = free; }, [free]);

  const beginCorner = useCallback(() => { freeStart.current = { ...freeRef.current }; }, []);
  const setFreeSize = useCallback((w: number, h: number) => {
    const clamp = (v: number) => Math.min(Math.max(v, FREE_MIN), BOX);
    setFree({ w: clamp(w), h: clamp(h) });
    setPreview((p) => { if (p) deleteFile(p.uri); return null; });
  }, []);

  const cornerGesture = React.useMemo(() => Gesture.Pan()
    .onBegin(() => { 'worklet'; runOnJS(beginCorner)(); })
    .onUpdate((e) => {
      'worklet';
      // The handle is the TOP-right corner, so dragging UP has to make the window
      // taller — hence the minus on Y.
      runOnJS(setFreeSize)(
        freeStart.current.w + e.translationX * 2,
        freeStart.current.h - e.translationY * 2,
      );
    }), [beginCorner, setFreeSize]);

  // Render the clip for real and show it, rather than promising what it will look
  // like. It is the same call the save path makes, so what you watch is the file
  // that gets stored — including its size against WhatsApp's 500 KB ceiling.
  const makePreview = async (it: Item) => {
    if (!it.video || busy) return;
    setBusy(true);
    try {
      const crop = cropRect(it, false);
      const uri = await renderVideoSticker(
        it.uri,
        { ...crop, videoW: it.w, videoH: it.h },
        { startMs, durationMs: effClip(it), quality, fps, optimize },
        (done, total) => setProgress(`rendering · frame ${done}/${total}`),
      );
      dropPreview();
      setPreview({ uri, bytes: new File(uri).size ?? 0 });
      Haptics.selectionAsync();
    } catch (e: any) {
      Alert.alert('Preview failed', String(e?.message || e));
    } finally { setBusy(false); setProgress(null); }
  };

  // One muted line summarising whatever is switched on.
  const optionsSummary = () =>
    [QUALITY[quality].label, optimize ? 'smaller file' : null].filter(Boolean).join(' · ');

  // A sticker is always delivered on a 512×512 canvas — WhatsApp and Telegram
  // both insist — so "keep the original shape" means the picture keeps its ratio
  // and the canvas fills out around it with transparency, which is what every
  // renderer here already does with a non-square crop (fitSize, 'contain').
  const arOf = (it: Item) =>
    aspect === 'free' ? free.w / free.h
      : customAr ?? (aspect === 'original' ? it.w / it.h : 1);
  // Deliberately NOT rounded: vw/vh has to equal the ratio exactly, or re-cropping
  // a sticker cannot reproduce the rect it was made with. React Native lays out
  // fractional points fine.
  const viewBox = (it: Item) => {
    if (aspect === 'free') return { vw: free.w, vh: free.h };
    const ar = arOf(it);
    return ar >= 1 ? { vw: BOX, vh: BOX / ar } : { vw: BOX * ar, vh: BOX };
  };

  // Integer crop rect of the chosen shape, fully inside the image.
  const cropRect = (it: Item, centered: boolean) => {
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const { vw, vh } = viewBox(it);
    const ar = vw / vh;
    // The height follows from the width rather than being measured separately:
    // rounding the two independently pulls the rect off its shape, badly so when
    // it is only a few dozen pixels across.
    const heightFor = (cw: number) => clamp(Math.round(cw / ar), 1, it.h);

    if (centered) {
      // The largest rect of this shape that fits, centred.
      let cw = clamp(Math.min(it.w, Math.round(it.h * ar)), 1, it.w);
      let ch = heightFor(cw);
      if (ch > it.h) { ch = it.h; cw = clamp(Math.round(it.h * ar), 1, it.w); }
      return { x: Math.round((it.w - cw) / 2), y: Math.round((it.h - ch) / 2), width: cw, height: ch };
    }
    const base = Math.max(vw / it.w, vh / it.h);
    const eff = base * scale.value;
    // The epsilon absorbs float error: seeding this from a stored crop makes eff
    // exactly vw/width, and vw/eff then lands a hair BELOW the integer it should
    // be, so a plain floor would shave a pixel off on every re-crop.
    const cw = clamp(Math.floor(vw / eff + 1e-6), 1, it.w);
    const ch = heightFor(cw);
    const x = Math.round(clamp(it.w / 2 - (vw / 2 + tx.value) / eff, 0, it.w - cw));
    const y = Math.round(clamp(it.h / 2 - (vh / 2 + ty.value) / eff, 0, it.h - ch));
    return { x, y, width: cw, height: ch };
  };

  // No free slots left? Roll over into "<name> 2", "<name> 3", ... (same author).
  const ensureCapacity = async (): Promise<{ id: string; queue: number[] }> => {
    let t = targetRef.current;
    if (!t) { t = { id: packId, queue: await freeSlots(packId) }; targetRef.current = t; }
    if (t.queue.length === 0) {
      const b = baseRef.current;
      const np = await createPack(`${b.name} ${b.seq}`, b.author);
      b.seq += 1;
      splitsRef.current.push(np.name);
      targetRef.current = { id: np.id, queue: Array.from({ length: PACK_MAX }, (_, i) => i) };
      return targetRef.current;
    }
    return t;
  };

  // Returns where the sticker landed, so a single import can finish on the same
  // screen you get by tapping that sticker in the pack.
  const renderAndStore = async (it: Item, centered: boolean): Promise<{ id: string; packId: string }> => {
    const crop = cropRect(it, centered);
    // Normalize once at import (iPhone HEIC etc. -> a format Skia can decode).
    // A clip keeps its poster frame as the stored source: the video itself is not
    // ours to copy into app storage.
    const srcUri = it.video ? (it.poster ?? it.uri) : await ensureDecodableUri(it.uri);
    // Keep the source + an editable document behind the sticker, so the sticker
    // can be cropped again later from the original rather than from its render.
    const asset = await createAsset(srcUri, it.w, it.h);
    if (srcUri !== it.uri) await deleteFile(srcUri); // transcode temp no longer needed
    const now = Date.now();
    const doc: EditorDocument = {
      id: newId(),
      schemaVersion: DOC_SCHEMA_VERSION,
      canvas: { width: STICKER_SIZE, height: STICKER_SIZE, background: 'transparent' },
      layers: [{
        id: newId(), type: 'image', assetId: asset.id, fit: 'contain', crop,
        visible: true, locked: false, opacity: 1,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, zIndex: 0,
      }],
      createdAt: now, updatedAt: now,
    };
    try {
      await createDocument(doc);
      // Animated sources (GIF / animated WebP) keep their animation: every frame is
      // cropped identically and re-encoded as a looping GIF. Static -> flat PNG.
      let tmp: string | null = null;
      if (it.video) {
        // A preview is the finished file: nothing has changed since it was made,
        // or it would have been dropped, so re-encoding it would be pure waiting.
        tmp = preview?.uri ?? await renderVideoSticker(
          it.uri,
          { ...crop, videoW: it.w, videoH: it.h },
          { startMs, durationMs: effClip(it), quality, fps, optimize },
          (done, total) => setProgress(`clip · frame ${done}/${total}`),
        );
        setProgress(null);
      } else if (it.maybeAnimated) {
        try {
          tmp = await renderCroppedGif(asset.localUri, crop, (done, total) => {
            if (done % 5 === 0 || done === total) setProgress(`animating · frame ${done}/${total}`);
          });
        } catch (e) {
          console.warn('animated render failed, falling back to still:', e);
          tmp = null;
        }
        setProgress(null);
      }
      if (!tmp) tmp = await renderCroppedPng(asset.localUri, crop);
      try {
        // Only materialize the target (and any auto-split pack) once a render exists.
        const target = await ensureCapacity();
        const sticker = await addSticker(target.id, tmp, STICKER_SIZE, STICKER_SIZE, doc.id,
          target.queue[0] ?? null, tmp.toLowerCase().endsWith('.gif'));
        target.queue.shift();
        setRemaining(targetRef.current?.queue.length ?? null);
        return { id: sticker.id, packId: target.id };
      } finally {
        await deleteRender(tmp);
      }
    } catch (e) {
      await deleteDocumentAndAssets(doc.id); // doc + assets (when the doc row exists)
      await deleteAssetById(asset.id);       // and the asset alone when it doesn't
      throw e;
    }
  };

  // Re-crop: render the same way, then swap the sticker's image and remember the
  // new rect on its document so a third crop starts where this one ended.
  const reRender = async (it: Item, centered: boolean) => {
    if (!editStickerId) return;
    const crop = cropRect(it, centered);
    let tmp: string | null = null;
    if (it.maybeAnimated) {
      try {
        tmp = await renderCroppedGif(it.uri, crop, (done, total) => {
          if (done % 5 === 0 || done === total) setProgress(`animating · frame ${done}/${total}`);
        });
      } catch (e) {
        console.warn('animated re-crop failed, falling back to still:', e);
        tmp = null;
      }
      setProgress(null);
    }
    if (!tmp) tmp = await renderCroppedPng(it.uri, crop);
    try {
      await updateStickerImage(editStickerId, tmp, STICKER_SIZE, STICKER_SIZE,
        tmp.toLowerCase().endsWith('.gif'));
      const ref = editDocRef.current;
      if (ref) {
        const doc = await getDocument(ref.docId);
        if (doc) {
          await updateDocument({
            ...doc,
            layers: doc.layers.map((l) => (l.id === ref.layerId ? { ...l, crop } : l)),
            updatedAt: Date.now(),
          });
        }
      }
    } finally {
      await deleteRender(tmp);
    }
  };

  const finish = () => {
    const splits = splitsRef.current;
    if (splits.length) {
      Alert.alert('Pack was full', `Extra stickers were added to: ${splits.join(', ')}`,
        [{ text: 'OK', onPress: () => nav.pop() }]);
    } else {
      nav.pop();
    }
  };

  // One sticker, one screen: after making it you land exactly where you land when
  // you tap it in the pack, so creating and changing a sticker look the same.
  const openMade = async (made: { id: string; packId: string }) => {
    const p = await getPack(made.packId);
    nav.replace({ name: 'sticker', stickerId: made.id, packId: made.packId, packName: p?.name ?? packName });
  };

  const saveAndNext = async () => {
    if (!items || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await reRender(items[index], false);
        Haptics.selectionAsync();
        nav.pop();
        return;
      }
      const made = await renderAndStore(items[index], false);
      Haptics.selectionAsync();
      if (index < items.length - 1) { setIndex(index + 1); resetTransform(); setStartMs(0); }
      // Only for a single import: after a batch you want the pack, not one sticker.
      else if (items.length === 1 && !splitsRef.current.length) await openMade(made);
      else finish();
    } catch (e: any) { Alert.alert('Crop failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };


  if (!items) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const cur = items[index];
  const isLast = index >= items.length - 1;
  const willSplit = remaining != null && items.length - index > remaining;
  const { vw, vh } = viewBox(cur);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 6 }}>
      {/* Nothing in the navigation bar saves anything: the only action up here is
          leaving. Centring is a change to the framing, so it sits with the picture. */}
      <Header title={editing ? 'Crop again' : `Crop for ${packName}`} onBack={busy ? undefined : nav.pop} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        <Text style={[S.hint, { textAlign: 'center', marginBottom: 10 }]}>
          {busy && progress ? progress
            : editing ? 'drag to move · pinch to zoom'
            : `${index + 1} / ${items.length} · drag to move · pinch to zoom`}
        </Text>

        {/* The crop window takes the chosen shape; the box around it stays BOX tall
            so nothing below it jumps when the shape changes. */}
        <View style={{ width: BOX, height: BOX, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' }}>
          <Cropper key={`${cur.id}-${cur.poster ?? ''}-${vw}x${vh}`} uri={cur.poster ?? cur.uri}
            imgW={cur.w} imgH={cur.h} viewW={vw} viewH={vh} tx={tx} ty={ty} scale={scale} />
          {/* The finished clip, playing, over the cropper it came from. It also
              covers the pan gesture, so the framing cannot drift away from what
              is being shown. */}
          {preview ? (
            <Pressable style={[st.previewWrap, { width: vw, height: vh }]} onPress={dropPreview}>
              <Image source={{ uri: preview.uri }} style={{ width: vw, height: vh }}
                contentFit="contain" cachePolicy="none" />
              <View style={st.previewTag}>
                <Text style={st.previewTagTxt}>Tap to keep editing</Text>
              </View>
            </Pressable>
          ) : null}

          {/* Freeform: drag the corner to shape the window itself. The window is
              centred, so the opposite edge moves with it — hence the doubling.
              Top-right rather than bottom-right: down there it sits under your own
              thumb and crowds the buttons directly beneath the picture. */}
          {aspect === 'free' && !preview ? (
            <GestureDetector gesture={cornerGesture}>
              <View style={[st.handleHit, {
                left: BOX / 2 + vw / 2 - HANDLE / 2,
                top: BOX / 2 - vh / 2 - HANDLE / 2,
              }]}>
                <View style={st.handleMark} />
              </View>
            </GestureDetector>
          ) : null}
        </View>

        {/* Shape sits with the picture, not buried in a sheet: it changes what you
            are looking at. */}
        <View style={[st.clipHead, { paddingHorizontal: EDGE, marginTop: 14 }]}>
          <Text style={st.fpsLabel}>Shape</Text>
          <View style={st.lengths}>
            {([['square', 'Square'], ['original', 'Original'], ['free', 'Freeform']] as const).map(([v, label]) => {
              const on = customAr == null && aspect === v;
              return (
                <Pressable
                  key={v}
                  onPress={() => {
                    // Freeform starts from the shape currently on screen, so picking
                    // it changes nothing until the corner is actually dragged.
                    if (v === 'free') { const b = viewBox(cur); setFree({ w: b.vw, h: b.vh }); }
                    setAspect(v); setCustomAr(null); resetTransform(); dropPreview();
                  }}
                  style={[st.length, on && st.lengthOn]}>
                  <Text style={[st.lengthTxt, on && st.lengthTxtOn]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {cur.video ? (
          <View style={st.clip}>
            {/* One row: what you're taking, and how much of it. */}
            <View style={st.clipHead}>
              <Text style={st.clipRange}>
                {(startMs / 1000).toFixed(1)}–{((startMs + effClip(cur)) / 1000).toFixed(1)}s
              </Text>
              <View style={st.lengths}>
                {[1000, 2000, 3000, 5000, MAX_CLIP_MS].map((ms) => {
                  const on = clipMs === ms;
                  const can = cur.video!.durationMs >= ms;
                  return (
                    <Pressable key={ms} onPress={() => { if (can) { setClipMs(ms); dropPreview(); } }} disabled={!can}
                      style={[st.length, on && st.lengthOn]}>
                      <Text style={[st.lengthTxt, on && st.lengthTxtOn, !can && { opacity: 0.3 }]}>
                        {ms / 1000}s
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <Slider
              value={startMs}
              min={0}
              max={Math.max(1, cur.video.durationMs - effClip(cur))}
              onChange={(v) => { setStartMs(v); schedulePoster(cur, v); }}
              onStart={dropPreview}
            />

            {/* Frame rate is its own choice: it trades against length and colours,
                and which one to spend the 500 KB on depends on the clip. */}
            <View style={st.clipHead}>
              <Text style={st.fpsLabel}>Frames per second</Text>
              <View style={st.lengths}>
                {FPS_CHOICES.map((n) => (
                  <Pressable key={n} onPress={() => { setFps(n); dropPreview(); }}
                    style={[st.length, fps === n && st.lengthOn]}>
                    <Text style={[st.lengthTxt, fps === n && st.lengthTxtOn]}>{n}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Btn label={preview ? 'Render again' : 'Preview'} kind="ghost"
              onPress={() => makePreview(cur)} disabled={busy} />
            {preview ? (
              <Text style={[st.sizeNote, preview.bytes > MAX_STICKER_BYTES && { color: C.bad }]}>
                {(preview.bytes / 1024).toFixed(0)} KB
                {preview.bytes > MAX_STICKER_BYTES
                  ? ` · over WhatsApp's 500 KB limit — fewer frames, fewer colours or a shorter clip`
                  : " · fits WhatsApp's 500 KB limit"}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Same single line for stills and clips — one place for every choice. */}
        {cur.video ? (
          <Pressable onPress={clipOptions} style={st.optionsRow} disabled={busy}>
            <Text style={st.optionsTxt}>{optionsSummary()}</Text>
            <Ionicons name="chevron-forward" size={15} color={C.muted} />
          </Pressable>
        ) : null}

        {willSplit ? (
          <Text style={st.splitNote}>
            "{baseRef.current.name}" fits {remaining} more — extras will start a new pack automatically.
          </Text>
        ) : null}

        <View style={{ paddingHorizontal: EDGE, marginTop: 20, gap: 10 }}>
          <Btn label={editing ? 'Save' : isLast ? 'Save & Finish' : 'Save & Next'}
            onPress={saveAndNext} busy={busy} />
          {/* Centring is just the framing going back to the middle at full size —
              it saves nothing, which is why it is a plain secondary button. */}
          <Btn label="Centre" kind="ghost"
            onPress={() => { resetTransform(); dropPreview(); }} disabled={busy} />
        </View>
      </ScrollView>

    </View>
  );
}

const st = StyleSheet.create({
  clip: { paddingHorizontal: EDGE, marginTop: 18, gap: 12 },
  clipHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clipRange: { color: C.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  // Segmented control, iOS style: one track, the selection slides inside it.
  lengths: {
    flexDirection: 'row', backgroundColor: C.surface2, borderRadius: 9,
    borderCurve: 'continuous', padding: 2,
  },
  length: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, borderCurve: 'continuous' },
  fpsLabel: { color: C.muted, fontSize: 14, fontWeight: '600' },
  sizeNote: { color: C.muted, fontSize: 12, textAlign: 'center', lineHeight: 16, marginTop: -4 },
  previewWrap: {
    position: 'absolute', borderRadius: 14,
    borderCurve: 'continuous', overflow: 'hidden', backgroundColor: C.surface2,
    alignItems: 'center', justifyContent: 'center',
  },
  previewTag: {
    position: 'absolute', bottom: 10, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, backgroundColor: 'rgba(10,12,18,0.72)',
  },
  previewTagTxt: { color: C.text, fontSize: 12, fontWeight: '600' },
  // A finger-sized target centred on the corner; nothing is drawn on it, so the
  // grip can stay small without being hard to hit.
  handleHit: { position: 'absolute', width: HANDLE, height: HANDLE },
  // The grip itself: an L hugging the corner from the inside, the way every photo
  // cropper marks one. A bracket has no direction, so unlike an arrow glyph there
  // is no way for it to end up pointing along the edge instead of across it.
  handleMark: {
    position: 'absolute',
    left: HANDLE / 2 - GRIP, top: HANDLE / 2,
    width: GRIP, height: GRIP,
    borderTopWidth: 3, borderRightWidth: 3, borderColor: C.accent,
    borderTopRightRadius: 12,
    // Keeps it readable over a pale photo, where cyan on white would vanish.
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 2, shadowOffset: { width: 0, height: 1 },
  },
  lengthOn: { backgroundColor: C.accent },
  lengthTxt: { color: C.text, fontSize: 13, fontWeight: '600' },
  lengthTxtOn: { color: C.ink },
  optionsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: EDGE, marginTop: 14, paddingVertical: 6,
  },
  optionsTxt: { color: C.muted, fontSize: 14, fontWeight: '500' },
  splitNote: {
    color: C.accent2, fontSize: 12, fontWeight: '600',
    paddingHorizontal: EDGE, marginTop: 14, textAlign: 'center',
  },
});
