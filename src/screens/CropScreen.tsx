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
  deleteAssetById, ensurePackSlots, freeSlots,
} from '../db';
import { deleteRender, deleteFile, newId } from '../storage';
import { renderCroppedPng, ensureDecodableUri, STICKER_SIZE } from '../editor/renderCrop';
import { renderCroppedGif, maybeAnimatedSource } from '../editor/renderAnimated';
import { renderVideoSticker, QUALITY, MAX_CLIP_MS, type QualityKey } from '../editor/renderVideo';
import { videoInfo, extractFrames } from '../../modules/video-frames';
import Cropper from '../SquareCropper';
import { Slider } from '../editor/controls';

type Item = {
  id: string; uri: string; w: number; h: number; maybeAnimated: boolean;
  video?: { durationMs: number };  // set for clips
  poster?: string;                 // still frame shown in the cropper
};
const { width: SCREEN_W } = Dimensions.get('window');
const BOX = Math.min(SCREEN_W - 44, 380);
const EDGE = (SCREEN_W - BOX) / 2; // everything aligns to the crop box edges

export default function CropScreen({ nav, packId, packName, startSlot }: { nav: Nav; packId: string; packName: string; startSlot?: number }) {
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
  const launched = useRef(false);

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
    (async () => {
      await ensurePackSlots(packId);
      const [p, free] = await Promise.all([getPack(packId), freeSlots(packId)]);
      const s0 = startSlot ?? 0;
      const queue = [...free.filter((x) => x >= s0), ...free.filter((x) => x < s0)];
      targetRef.current = { id: packId, queue };
      baseRef.current = { name: p?.name ?? packName, author: p?.author ?? '', seq: 2 };
      setRemaining(queue.length);
    })();
  }, [packId, packName, startSlot]);

  useEffect(() => {
    if (launched.current) return;
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

  const clipOptions = () => {
    Alert.alert('Clip quality', undefined, [
      ...(Object.keys(QUALITY) as QualityKey[]).map((k) => ({
        text: quality === k ? `✓  ${QUALITY[k].label}` : QUALITY[k].label,
        onPress: () => setQuality(k),
      })),
      {
        text: optimize ? '✓  Smaller file size' : 'Smaller file size',
        onPress: () => setOptimize((v) => !v),
      },
      { text: 'Done', style: 'cancel' as const },
    ]);
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
    const side = Math.max(1, Math.min(Math.min(it.w, it.h), Math.floor(BOX / eff)));
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

  const renderAndStore = async (it: Item, centered: boolean) => {
    const crop = cropRect(it, centered);
    // Normalize once at import (iPhone HEIC etc. -> a format Skia can decode).
    // A clip keeps its poster frame as the stored source: the video itself is not
    // ours to copy into app storage.
    const srcUri = it.video ? (it.poster ?? it.uri) : await ensureDecodableUri(it.uri);
    // Keep the source + an editable document behind the sticker (future editing).
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
        await addSticker(target.id, tmp, STICKER_SIZE, STICKER_SIZE, doc.id, target.queue[0] ?? null,
          tmp.toLowerCase().endsWith('.gif'));
        target.queue.shift();
        setRemaining(targetRef.current?.queue.length ?? null);
      } finally {
        await deleteRender(tmp);
      }
    } catch (e) {
      await deleteDocumentAndAssets(doc.id); // doc + assets (when the doc row exists)
      await deleteAssetById(asset.id);       // and the asset alone when it doesn't
      throw e;
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

  const saveAndNext = async () => {
    if (!items || busy) return;
    setBusy(true);
    try {
      await renderAndStore(items[index], false);
      Haptics.selectionAsync();
      if (index < items.length - 1) { setIndex(index + 1); resetTransform(); setStartMs(0); }
      else finish();
    } catch (e: any) { Alert.alert('Crop failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const autoCentreAll = async () => {
    if (!items || busy) return;
    setBusy(true);
    try {
      for (let i = index; i < items.length; i++) {
        setIndex(i); // keep the "n / total" counter honest during the batch
        await renderAndStore(items[i], true);
      }
      finish();
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
      <Header title={`Crop for ${packName}`} onBack={busy ? undefined : nav.pop}
        right={<NavText label="Centre all" onPress={autoCentreAll} disabled={busy} />} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        <Text style={[S.hint, { textAlign: 'center', marginBottom: 10 }]}>
          {busy && progress ? progress : `${index + 1} / ${items.length} · drag to move · pinch to zoom`}
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
            <Pressable onPress={clipOptions} style={st.optionsRow}>
              <Text style={st.optionsTxt}>
                {QUALITY[quality].label}{optimize ? ' · smaller file' : ''}
              </Text>
              <Ionicons name="chevron-forward" size={15} color={C.muted} />
            </Pressable>
          </View>
        ) : null}

        {willSplit ? (
          <Text style={st.splitNote}>
            "{baseRef.current.name}" fits {remaining} more — extras will start a new pack automatically.
          </Text>
        ) : null}

        <View style={{ paddingHorizontal: EDGE, marginTop: 20, gap: 10 }}>
          <Btn label={isLast ? 'Save & Finish' : 'Save & Next'} onPress={saveAndNext} busy={busy} />
          <Btn label="Reset" kind="ghost" onPress={resetTransform} disabled={busy} />
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
  length: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 7, borderCurve: 'continuous' },
  lengthOn: { backgroundColor: C.accent },
  lengthTxt: { color: C.text, fontSize: 13, fontWeight: '600' },
  lengthTxtOn: { color: C.ink },
  optionsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 4,
  },
  optionsTxt: { color: C.muted, fontSize: 14, fontWeight: '500' },
  splitNote: {
    color: C.accent2, fontSize: 12, fontWeight: '600',
    paddingHorizontal: EDGE, marginTop: 14, textAlign: 'center',
  },
});
