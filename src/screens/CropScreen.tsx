import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { File } from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { Btn, Header, sheet, S } from '../ui';
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
import CropOverlay from '../editor/CropOverlay';
import { Segmented, Slider } from '../editor/controls';
import {
  centredRect, toPixels, fromPixels, type Aspect, type NRect,
} from '../editor/cropGeometry';

type Item = {
  id: string; uri: string; w: number; h: number; maybeAnimated: boolean;
  video?: { durationMs: number };  // set for clips
  poster?: string;                 // still frame shown in the cropper
};
type Shape = 'square' | 'original' | 'free';
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const EDGE = 20;
// The picture gets as much room as the controls leave it: being able to see what
// you are cutting away is the whole point of showing the crop as an overlay.
const STAGE_W = SCREEN_W - EDGE * 2;
const STAGE_H = Math.max(260, Math.min(SCREEN_H * 0.56, 520));

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
  // The crop itself, as a fraction of the picture — see editor/cropGeometry.ts.
  const [rect, setRect] = useState<NRect>({ x: 0, y: 0, w: 1, h: 1 });
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

  // "Centre" is now literally that: the biggest crop of the chosen shape, middled.
  const recentre = (it: Item | null | undefined = items?.[index]) => {
    if (it) setRect(centredRect(arOf(it), it.w, it.h));
  };

  // A new picture starts on a centred crop of the chosen shape. Reopening a
  // sticker is the exception: it brings the crop it was made with.
  const shownId = items?.[index]?.id;
  useEffect(() => {
    const it = items?.[index];
    if (it && !editing) setRect(centredRect(arOf(it), it.w, it.h));
  }, [shownId, editing]);

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
          // Reopen on exactly the crop this sticker was made with.
          setCustomAr(c.width / c.height);
          setRect(fromPixels(c, asset.width, asset.height));
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
    sheet({
      title: 'Clip options',
      options: [
        ...(Object.keys(QUALITY) as QualityKey[]).map((k) => ({
          label: tick(quality === k, QUALITY[k].label),
          onPress: () => { setQuality(k); dropPreview(); },
        })),
        {
          label: tick(optimize, 'Smaller file size'),
          onPress: () => { setOptimize((v) => !v); dropPreview(); },
        },
      ],
    });
  };

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

  // The ratio the crop must hold, in image pixels. null means freeform: every
  // corner moves on its own. A sticker being re-cropped carries the ratio it was
  // made with, whatever the Shape buttons say.
  const arOf = (it: Item): Aspect =>
    aspect === 'free' ? null
      : customAr ?? (aspect === 'original' ? it.w / it.h : 1);

  // A sticker is always delivered on a 512×512 canvas — WhatsApp and Telegram
  // both insist — so a non-square crop keeps its ratio and the canvas fills out
  // around it with transparency, which every renderer here already does.
  const cropRect = (it: Item, centered: boolean) => {
    const ar = arOf(it);
    return toPixels(centered ? centredRect(ar, it.w, it.h) : rect, it.w, it.h, ar);
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
      if (index < items.length - 1) { setIndex(index + 1); recentre(items[index + 1]); setStartMs(0); }
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

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 6 }}>
      {/* Nothing in the navigation bar saves anything: the only action up here is
          leaving. Centring is a change to the framing, so it sits with the picture. */}
      <Header title={editing ? 'Crop again' : `Crop for ${packName}`} onBack={busy ? undefined : nav.pop} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        <Text style={[S.hint, { textAlign: 'center', marginBottom: 10 }]}>
          {busy && progress ? progress
            : editing ? 'drag the frame · pull a corner to resize'
            : `${index + 1} / ${items.length} · drag the frame · pull a corner to resize`}
        </Text>

        <View style={{ width: STAGE_W, height: STAGE_H, alignSelf: 'center' }}>
          <CropOverlay
            uri={cur.poster ?? cur.uri}
            imgW={cur.w} imgH={cur.h}
            stageW={STAGE_W} stageH={STAGE_H}
            aspect={arOf(cur)}
            rect={rect}
            onChange={setRect}
            onSettled={dropPreview}
          />
          {/* The finished clip, playing, over the picture it came from — and over
              the gesture too, so the framing cannot drift from what is shown. */}
          {preview ? (
            <Pressable style={st.previewWrap} onPress={dropPreview}>
              <Image source={{ uri: preview.uri }} style={StyleSheet.absoluteFill}
                contentFit="contain" cachePolicy="none" />
              <View style={st.previewTag}>
                <Text style={st.previewTagTxt}>Tap to keep editing</Text>
              </View>
            </Pressable>
          ) : null}
        </View>

        {/* Shape sits with the picture, not buried in a sheet: it changes what you
            are looking at. */}
        <View style={{ paddingHorizontal: EDGE, marginTop: 14 }}>
          <Segmented
            options={[
              { value: 'square', label: 'Square' },
              { value: 'original', label: 'Original' },
              { value: 'free', label: 'Freeform' },
            ]}
            value={customAr != null ? 'free' : aspect}
            onChange={(v) => {
              setAspect(v); setCustomAr(null); dropPreview();
              // Freeform keeps whatever is on screen — there is no ratio to
              // impose — while the other two re-fit the crop to their shape.
              if (v !== 'free') {
                setRect(centredRect(v === 'original' ? cur.w / cur.h : 1, cur.w, cur.h));
              }
            }}
          />
        </View>

        {cur.video ? (
          <View style={st.clip}>
            {/* What you're taking, and how much of it. Lengths the clip is too
                short for are left out rather than shown greyed: a segmented
                control has no disabled segment, and an option you cannot pick is
                noise either way. */}
            <Text style={st.clipRange}>
              {(startMs / 1000).toFixed(1)}–{((startMs + effClip(cur)) / 1000).toFixed(1)}s
            </Text>
            <Segmented
              options={[1000, 2000, 3000, 5000, MAX_CLIP_MS]
                .filter((ms) => cur.video!.durationMs >= ms || ms === 1000)
                .map((ms) => ({ value: String(ms), label: `${ms / 1000}s` }))}
              value={String(clipMs)}
              onChange={(v) => { setClipMs(Number(v)); dropPreview(); }}
            />

            <Slider
              value={startMs}
              min={0}
              max={Math.max(1, cur.video.durationMs - effClip(cur))}
              onChange={(v) => { setStartMs(v); schedulePoster(cur, v); }}
              onStart={dropPreview}
            />

            {/* Frame rate is its own choice: it trades against length and colours,
                and which one to spend the 500 KB on depends on the clip. */}
            <Text style={st.fpsLabel}>Frames per second</Text>
            <Segmented
              options={FPS_CHOICES.map((n) => ({ value: String(n), label: String(n) }))}
              value={String(fps)}
              onChange={(v) => { setFps(Number(v)); dropPreview(); }}
            />

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
            onPress={() => { recentre(cur); dropPreview(); }} disabled={busy} />
        </View>
      </ScrollView>

    </View>
  );
}

const st = StyleSheet.create({
  clip: { paddingHorizontal: EDGE, marginTop: 18, gap: 12 },
  clipRange: { color: C.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'center' },
  optionsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: EDGE, marginTop: 14, paddingVertical: 6,
  },
  optionsTxt: { color: C.muted, fontSize: 14, fontWeight: '500' },
  fpsLabel: { color: C.muted, fontSize: 14, fontWeight: '600' },
  sizeNote: { color: C.muted, fontSize: 12, textAlign: 'center', lineHeight: 16, marginTop: -4 },
  // The rendered clip, shown over the picture it came from.
  previewWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 14,
    borderCurve: 'continuous', overflow: 'hidden', backgroundColor: C.surface2,
    alignItems: 'center', justifyContent: 'center',
  },
  previewTag: {
    position: 'absolute', bottom: 10, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, backgroundColor: 'rgba(10,12,18,0.72)',
  },
  previewTagTxt: { color: C.text, fontSize: 12, fontWeight: '600' },
  splitNote: {
    color: C.accent2, fontSize: 12, fontWeight: '600',
    paddingHorizontal: EDGE, marginTop: 14, textAlign: 'center',
  },
});
