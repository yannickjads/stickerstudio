import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { Btn, Header, NavText, S } from '../ui';
import type { Nav } from '../nav';
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
import { renderVideoSticker, QUALITY, MAX_CLIP_MS, type QualityKey } from '../editor/renderVideo';
import { videoInfo, extractFrames } from '../../modules/video-frames';
import { cutoutSupported } from '../../modules/subject-cutout';
import Cropper from '../SquareCropper';
import CutoutScreen from './CutoutScreen';
import { Slider } from '../editor/controls';

type Item = {
  id: string; uri: string; w: number; h: number; maybeAnimated: boolean;
  video?: { durationMs: number };  // set for clips
  poster?: string;                 // still frame shown in the cropper
  cut?: boolean;                   // its background has already been removed
};
const { width: SCREEN_W } = Dimensions.get('window');
const BOX = Math.min(SCREEN_W - 44, 380);
const EDGE = (SCREEN_W - BOX) / 2; // everything aligns to the crop box edges

export default function CropScreen({ nav, packId, packName, startSlot, editStickerId }: { nav: Nav; packId: string; packName: string; startSlot?: number; editStickerId?: string }) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Item[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [startMs, setStartMs] = useState(0);       // clip start
  const [clipMs, setClipMs] = useState(MAX_CLIP_MS); // clip length
  const [quality, setQuality] = useState<QualityKey>('balanced');
  const [optimize, setOptimize] = useState(true);
  const [canCutout, setCanCutout] = useState(false);
  // The background editor, shown over this screen (see openCutout).
  const [cutout, setCutout] = useState<{ uri: string; itemId: string } | null>(null);
  useEffect(() => { cutoutSupported().then(setCanCutout); }, []);
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
        if (c && c.width > 0 && asset.width > 0 && asset.height > 0) {
          const base = Math.max(BOX / asset.width, BOX / asset.height);
          const eff = BOX / c.width;
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
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1,
      });
      if (res.canceled || !res.assets?.length) { nav.pop(); return; }
      const picked: Item[] = [];
      for (let i = 0; i < res.assets.length; i++) {
        const a = res.assets[i];
        const item: Item = {
          id: `${Date.now()}-${i}`, uri: a.uri, w: a.width ?? 512, h: a.height ?? 512,
          maybeAnimated: maybeAnimatedSource(a.uri, a.mimeType ?? a.fileName ?? null),
        };
        // A clip needs its length, plus a still to aim the cropper at.
        if (a.type === 'video' || /\.(mov|mp4|m4v)$/i.test(a.uri)) {
          const info = await videoInfo(a.uri);
          if (info && info.durationMs > 0) {
            item.video = { durationMs: info.durationMs };
            if (info.width && info.height) { item.w = info.width; item.h = info.height; }
            try { item.poster = (await extractFrames(a.uri, 0, 0, 1, 720))[0]; } catch {}
          }
        }
        picked.push(item);
      }
      setItems(picked);
    })();
  }, [nav]);

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

  // Hand the framed crop to the background editor and take its answer back as the
  // item's new source: already square, already cropped, so everything downstream
  // carries on unchanged.
  const openCutout = (it: Item) => {
    if (busy) return;
    const go = async () => {
      setBusy(true);
      setProgress('preparing');
      let temp: string | null = null;
      try {
        const base = it.video ? (it.poster ?? it.uri) : await ensureDecodableUri(it.uri);
        if (base !== it.uri && base !== it.poster) { temp = base; }
        // The crop rect is measured against the item's own dimensions, but a clip's
        // poster frame comes out of extraction downscaled — so measure what we
        // actually have and scale the rect onto it.
        const probe = await loadSkImage(base);
        const probeW = probe.width();
        const s = probeW / it.w;
        probe.dispose();
        const c = cropRect(it, false);
        let crop = c;
        if (s !== 1) {
          const pw = probeW, ph = Math.round(it.h * s);
          const side = Math.max(1, Math.min(Math.round(c.width * s), pw, ph));
          crop = {
            x: Math.min(Math.round(c.x * s), pw - side),   // rounding must not
            y: Math.min(Math.round(c.y * s), ph - side),   // push the rect off the frame
            width: side, height: side,
          };
        }
        const png = await renderCroppedPng(base, crop);
        // Shown OVER this screen rather than pushed as a route. Only the top route
        // is rendered, so pushing would unmount this screen and take the picked
        // images, the slot queue and the crop with it — and the cut-out would come
        // back to a component that no longer exists.
        setCutout({ uri: png, itemId: it.id });
      } catch (e: any) {
        Alert.alert('Could not open the background editor', String(e?.message || e));
      } finally {
        if (temp) await deleteFile(temp);
        setBusy(false);
        setProgress(null);
      }
    };
    // Only the first frame survives a cut-out, so say so before doing it.
    if (it.video || it.maybeAnimated) {
      Alert.alert('This one moves', 'Removing the background keeps only the frame you see — the sticker becomes a still image.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: go },
      ]);
    } else { go(); }
  };

  const stickerOptions = (it: Item) => {
    const isVideo = !!it.video;
    Alert.alert(isVideo ? 'Clip options' : 'Sticker options', undefined, [
      ...(canCutout ? [{
        text: it.cut ? 'Edit the background again' : 'Remove background…',
        onPress: () => openCutout(it),
      }] : []),
      ...(isVideo ? (Object.keys(QUALITY) as QualityKey[]).map((k) => ({
        text: tick(quality === k, QUALITY[k].label),
        onPress: () => setQuality(k),
      })) : []),
      ...(isVideo ? [{
        text: tick(optimize, 'Smaller file size'),
        onPress: () => setOptimize((v) => !v),
      }] : []),
      { text: 'Done', style: 'cancel' as const },
    ]);
  };

  // One muted line summarising whatever is switched on.
  const optionsSummary = (it: Item) => {
    const bits: string[] = [];
    if (it.video) bits.push(QUALITY[quality].label);
    if (it.video && optimize) bits.push('smaller file');
    if (it.cut) bits.push('background removed');
    return bits.length ? bits.join(' · ') : 'Options';
  };

  // Integer square crop rect, fully inside the image.
  const cropRect = (it: Item, centered: boolean) => {
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    if (centered) {
      const side = Math.min(it.w, it.h);
      return { x: Math.round((it.w - side) / 2), y: Math.round((it.h - side) / 2), width: side, height: side };
    }
    const base = Math.max(BOX / it.w, BOX / it.h);
    const eff = base * scale.value;
    // The epsilon absorbs float error: seeding this from a stored crop makes eff
    // exactly BOX/width, and BOX/eff then lands a hair BELOW the integer it should
    // be, so a plain floor would shave a pixel off on every re-crop.
    const side = Math.max(1, Math.min(Math.min(it.w, it.h), Math.floor(BOX / eff + 1e-6)));
    const x = Math.round(clamp(it.w / 2 - (BOX / 2 + tx.value) / eff, 0, it.w - side));
    const y = Math.round(clamp(it.h / 2 - (BOX / 2 + ty.value) / eff, 0, it.h - side));
    return { x, y, width: side, height: side };
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
        tmp = await renderVideoSticker(
          it.uri,
          { ...crop, videoW: it.w, videoH: it.h },
          { startMs, durationMs: effClip(it), quality, optimize },
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
    if (it.maybeAnimated && !it.cut) {
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

  const autoCentreAll = async () => {
    if (!items || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await reRender(items[index], true);
        nav.pop();
        return;
      }
      let made: { id: string; packId: string } | null = null;
      for (let i = index; i < items.length; i++) {
        setIndex(i); // keep the "n / total" counter honest during the batch
        made = await renderAndStore(items[i], true);
      }
      if (made && items.length === 1 && !splitsRef.current.length) await openMade(made);
      else finish();
    } catch (e: any) { Alert.alert('Failed', String(e?.message || e)); }
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

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 6 }}>
      <Header title={editing ? 'Crop again' : `Crop for ${packName}`} onBack={busy ? undefined : nav.pop}
        right={<NavText label={items.length > 1 ? 'Centre all' : 'Centre'}
          onPress={autoCentreAll} disabled={busy} />} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        <Text style={[S.hint, { textAlign: 'center', marginBottom: 10 }]}>
          {busy && progress ? progress
            : editing ? 'drag to move · pinch to zoom'
            : `${index + 1} / ${items.length} · drag to move · pinch to zoom`}
        </Text>

        <Cropper key={`${cur.id}-${cur.poster ?? ''}`} uri={cur.poster ?? cur.uri}
          imgW={cur.w} imgH={cur.h} viewW={BOX} viewH={BOX} tx={tx} ty={ty} scale={scale} />

        {cur.video ? (
          <View style={st.clip}>
            {/* One row: what you're taking, and how much of it. */}
            <View style={st.clipHead}>
              <Text style={st.clipRange}>
                {(startMs / 1000).toFixed(1)}–{((startMs + effClip(cur)) / 1000).toFixed(1)}s
              </Text>
              <View style={st.lengths}>
                {[1000, 2000, 3000].map((ms) => {
                  const on = clipMs === ms;
                  const can = cur.video!.durationMs >= ms;
                  return (
                    <Pressable key={ms} onPress={() => can && setClipMs(ms)} disabled={!can}
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
            />

            {/* The technical choices live one tap away, in a native sheet — the
                same place every other choice in this app lives. */}
          </View>
        ) : null}

        {/* Same single line for stills and clips — one place for every choice. */}
        {canCutout || cur.video ? (
          <Pressable onPress={() => stickerOptions(cur)} style={st.optionsRow} disabled={busy}>
            <Text style={st.optionsTxt}>{optionsSummary(cur)}</Text>
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
          <Btn label="Reset" kind="ghost" onPress={resetTransform} disabled={busy} />
        </View>
      </ScrollView>

      {/* The cut-out replaces this item's source outright: it comes back already
          square and already cropped, so every path below it carries on unchanged. */}
      {cutout ? (
        <View style={StyleSheet.absoluteFill}>
          <CutoutScreen
            uri={cutout.uri}
            nav={{ ...nav, pop: () => { deleteFile(cutout.uri); setCutout(null); } }}
            onDone={(file) => {
              setItems((prev) => prev && prev.map((x) => (x.id === cutout.itemId
                ? { id: x.id, uri: file, w: STICKER_SIZE, h: STICKER_SIZE, maybeAnimated: false, cut: true }
                : x)));
              resetTransform();
            }}
          />
        </View>
      ) : null}
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
  length: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 7, borderCurve: 'continuous' },
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
