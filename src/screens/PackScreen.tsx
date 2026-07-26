import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { C } from '../theme';
import { Btn, Header, NavCircle, S, EDGE } from '../ui';
import type { Nav, MediaSource } from '../nav';
import type { Pack, Sticker } from '../types';
import { PACK_MAX } from '../types';
import {
  listStickers, getPack, ensurePackSlots, updatePack, deletePack, getPackTrayUri,
  setPackTrayImage,
} from '../db';
import { nativePrompt } from '../../modules/native-prompt';
import { deleteFile } from '../storage';
import { renderCroppedPng, ensureDecodableUri, loadSkImage } from '../editor/renderCrop';
import { buildWhatsAppPayload, isAnimatedSticker, WA_MIN_STICKERS } from '../editor/whatsappExport';
import { exportPacksToZip } from '../backup';
import { exportWastickers } from '../wastickers';
import { buildTelegramPayload } from '../editor/telegramExport';
import { isTelegramInstalled, sendStickerSetToTelegram } from '../../modules/telegram-stickers';
import { isWhatsAppInstalled, sendStickerPackToWhatsApp } from '../../modules/whatsapp-stickers';

const { width: SCREEN_W } = Dimensions.get('window');
const COLS = 4;
const MIN_GAP = 10;
// The grid must span exactly EDGE..(width-EDGE) so it lines up with the header
// and the footer button: floor the tile, then absorb the remainder into the gaps.
const AVAIL = Math.max(0, SCREEN_W - EDGE * 2);
// Clamped so a bad measurement can never collapse the tiles to nothing.
const THUMB = Math.max(44, Math.floor((AVAIL - MIN_GAP * (COLS - 1)) / COLS) || 44);
const GAP = Math.max(0, (AVAIL - THUMB * COLS) / (COLS - 1)) || MIN_GAP;

export default function PackScreen({ nav, packId, packName }: { nav: Nav; packId: string; packName: string }) {
  const insets = useSafeAreaInsets();
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [pack, setPack] = useState<Pack | null>(null);
  const [name, setName] = useState(packName);
  const [busy, setBusy] = useState(false);
  const [waBusy, setWaBusy] = useState(false);
  const [waProgress, setWaProgress] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      await ensurePackSlots(packId); // migrate legacy sort indexes -> fixed slots
      const [p, list] = await Promise.all([getPack(packId), listStickers(packId)]);
      if (!mounted.current) return;
      if (!p) { nav.pop(); return; }
      setPack(p);
      setName(p.name);
      setStickers(list);
    } catch (e: any) {
      if (mounted.current) Alert.alert('Could not open this pack', String(e?.message || e));
    }
  }, [packId, nav]);
  useEffect(() => { load(); }, [load]);

  // With a tray image of its own, no sticker is the icon — the star would lie.
  const isCover = (s: Sticker) => !pack?.trayUri && pack?.coverStickerId === s.id;

  // Tapping a sticker opens it. Everything you can do to one sticker lives there,
  // including cropping it again and removing its background.
  const openSticker = (s: Sticker) => {
    Haptics.selectionAsync();
    nav.push({ name: 'sticker', stickerId: s.id, packId, packName: name });
  };

  const sendToTelegram = async () => {
    if (!pack || waBusy || !stickers.length) return;
    if (!(await isTelegramInstalled())) {
      Alert.alert('Telegram not found', 'Install Telegram to add sticker sets.');
      return;
    }
    setWaBusy(true);
    try {
      const tray = await getPackTrayUri(packId);
      const { json, animatedAsStill } = await buildTelegramPayload(
        pack, stickers, (done, total) => setWaProgress(`${done}/${total}`), tray ?? undefined,
      );
      setWaProgress(null);
      const ok = await sendStickerSetToTelegram(json);
      if (!ok) Alert.alert('Could not open Telegram');
      else if (animatedAsStill) {
        Alert.alert('Sent to Telegram',
          `${animatedAsStill} animated sticker${animatedAsStill === 1 ? ' was' : 's were'} sent as a still image — Telegram only animates its own TGS/WebM formats.`);
      }
    } catch (e: any) {
      Alert.alert('Telegram export failed', String(e?.message || e));
    } finally { setWaBusy(false); setWaProgress(null); }
  };

  // Ask what kind of sticker first, then show only that kind. Half of what this
  // app can do was invisible when the picker just opened on everything at once.
  const addAt = (slot: number) => {
    const go = (source: MediaSource) =>
      nav.push({ name: 'crop', packId, packName: name, startSlot: slot, source });
    Alert.alert('New sticker', undefined, [
      { text: 'Photo or GIF', onPress: () => go('photos') },
      { text: 'Video', onPress: () => go('videos') },
      { text: 'Photos and videos together', onPress: () => go('mixed') },
      { text: 'File', onPress: () => go('files') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const sendToWhatsApp = async () => {
    if (!pack || waBusy) return;
    if (stickers.length < WA_MIN_STICKERS) {
      Alert.alert('Not enough stickers', `WhatsApp needs at least ${WA_MIN_STICKERS} stickers in a pack.`);
      return;
    }
    if (!(await isWhatsAppInstalled())) {
      Alert.alert('WhatsApp not found', 'Install WhatsApp to add sticker packs.');
      return;
    }
    // One pack, always: if anything is animated the pack goes out as animated and
    // still stickers are wrapped as non-moving animations (WhatsApp accepts this).
    const animated = stickers.some(isAnimatedSticker);
    setWaBusy(true);
    try {
      const tray = await getPackTrayUri(packId);
      const json = await buildWhatsAppPayload(pack, stickers.slice(0, PACK_MAX), animated, (done, total) => {
        setWaProgress(`${done}/${total}`);
      }, tray ?? undefined);
      setWaProgress(null);
      const ok = await sendStickerPackToWhatsApp(json);
      if (!ok) Alert.alert('Could not open WhatsApp', 'Is WhatsApp installed on this phone?');
      else Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('WhatsApp export failed', String(e?.message || e));
    } finally {
      setWaBusy(false);
      setWaProgress(null);
    }
  };

  const saveAllToPhotos = async () => {
    if (!stickers.length) return;
    const perm = await MediaLibrary.requestPermissionsAsync(true);
    if (!perm.granted) { Alert.alert('Photos access needed', 'Allow "Add to Photos" to save your stickers.'); return; }
    setBusy(true);
    try {
      for (const s of stickers) await MediaLibrary.saveToLibraryAsync(s.uri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', `${stickers.length} sticker${stickers.length > 1 ? 's' : ''} saved to your Photos.`);
    } catch (e: any) { Alert.alert('Save failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  // The pack's own tray image. Centre-cropped without asking: it is shown at 96px
  // in every app that reads it, so an interactive crop would be ceremony for
  // nothing — and it can be replaced in two taps.
  const chooseTray = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled || !res.assets?.length) return;
    setBusy(true);
    let src = '';
    let png = '';
    try {
      src = await ensureDecodableUri(res.assets[0].uri);
      const im = await loadSkImage(src);
      const w = im.width(), h = im.height();
      im.dispose();
      const side = Math.min(w, h);
      png = await renderCroppedPng(src, {
        x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), width: side, height: side,
      });
      await setPackTrayImage(packId, png);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      load();
    } catch (e: any) {
      Alert.alert('Could not set the pack icon', String(e?.message || e));
    } finally {
      if (png) await deleteFile(png);
      if (src && src !== res.assets[0].uri) await deleteFile(src);
      setBusy(false);
    }
  };

  const clearTray = async () => {
    await setPackTrayImage(packId, null);
    load();
  };

  const editPack = async () => {
    const r = await nativePrompt({
      title: 'Edit pack',
      fields: [{ placeholder: 'Name', value: name }, { placeholder: 'Author', value: pack?.author ?? '' }],
    });
    if (!r) return;
    await updatePack(packId, r[0], r[1] ?? '');
    load();
  };

  const exportPack = async () => {
    if (!pack || busy) return;
    setBusy(true);
    try {
      const zip = await exportPacksToZip([pack]);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(zip, { mimeType: 'application/zip', UTI: 'public.zip-archive' });
      }
    } catch (e: any) { Alert.alert('Backup failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  // .wastickers is what other sticker apps read — useful for sharing a pack with
  // someone who doesn't have this app.
  const exportWa = async () => {
    if (!pack || busy) return;
    setBusy(true);
    try {
      const tray = await getPackTrayUri(packId);
      const file = await exportWastickers(pack, stickers, tray ?? undefined);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file);
    } catch (e: any) { Alert.alert('Export failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const packMenu = () => {
    Haptics.selectionAsync();
    const hasStickers = stickers.length > 0;
    // Renaming and deleting must stay reachable for an empty pack — only the
    // export actions depend on there being stickers.
    Alert.alert(name, pack?.author ? `by ${pack.author}` : undefined, [
      { text: 'Edit name & author', onPress: editPack },
      {
        text: pack?.trayUri ? 'Change pack icon…' : 'Pack icon from a photo…',
        onPress: chooseTray,
      },
      ...(pack?.trayUri ? [{ text: 'Use a sticker as the icon instead', onPress: clearTray }] : []),
      ...(hasStickers ? [
        { text: 'Back up pack (.zip)', onPress: exportPack },
        { text: 'Add to Telegram', onPress: sendToTelegram },
        { text: 'Export as .wastickers', onPress: exportWa },
        { text: 'Save all to Photos', onPress: saveAllToPhotos },
      ] : []),
      {
        text: 'Delete pack', style: 'destructive' as const,
        onPress: () => Alert.alert(
          'Delete pack?',
          hasStickers ? `"${name}" and its stickers will be removed.` : `"${name}" will be removed.`,
          [
            { text: 'Cancel', style: 'cancel' as const },
            { text: 'Delete', style: 'destructive' as const, onPress: async () => { await deletePack(packId); nav.pop(); } },
          ],
        ),
      },
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  // While an export is reading sticker files, deleting one (or leaving the screen)
  // would pull the ground out from under it.
  const locked = busy || waBusy;

  // Fixed slots 0..PACK_MAX-1: stickers sit in their own slot, the rest stay empty.
  const bySlot = new Map(stickers.map((s) => [s.sortIndex, s]));
  const firstFree = Array.from({ length: PACK_MAX }, (_, i) => i).find((i) => !bySlot.has(i)) ?? -1;
  const full = stickers.length >= PACK_MAX;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 6 }}>
      <Header title={name} onBack={locked ? undefined : nav.pop}
        right={<NavCircle icon="ellipsis-horizontal" onPress={packMenu} disabled={busy || waBusy} />} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        <Text style={styles.capacity}>
          {stickers.length} of {PACK_MAX}{full ? ' · pack full' : ''}
        </Text>

        <View style={styles.grid}>
          {Array.from({ length: PACK_MAX }, (_, i) => {
            const s = bySlot.get(i);
            if (s) {
              return (
                <Pressable key={s.id} disabled={locked}
                  style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
                  onPress={() => openSticker(s)}>
                  <Image source={{ uri: s.uri }} style={styles.tileImg} contentFit="cover"
                    transition={140} cachePolicy="none" />
                  {isCover(s) ? (
                    <View style={styles.coverBadge}>
                      <Ionicons name="star" size={11} color={C.ink} />
                    </View>
                  ) : null}
                </Pressable>
              );
            }
            const next = i === firstFree;
            return (
              <Pressable key={`slot-${i}`} disabled={locked}
                style={({ pressed }) => [styles.tile, styles.slot, next && styles.slotNext, pressed && styles.pressed]}
                onPress={() => addAt(i)}>
                {next ? <Ionicons name="add" size={24} color={C.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <View style={[S.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Btn
          label={waProgress ? `Preparing ${waProgress}` : 'Add to WhatsApp'}
          onPress={sendToWhatsApp}
          busy={waBusy && !waProgress}
          disabled={stickers.length === 0 || busy}
        />
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 24 },
  capacity: {
    color: C.muted, fontSize: 13, fontWeight: '500',
    paddingHorizontal: EDGE, paddingBottom: 12,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingHorizontal: EDGE },
  // Square tiles — stickers are shown exactly as they'll be used, uncropped by
  // any corner rounding.
  tile: {
    width: THUMB, height: THUMB, overflow: 'hidden', backgroundColor: C.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  tileImg: { width: '100%', height: '100%' },
  // Every empty slot is outlined so the whole pack reads as a grid; the next one
  // up is the only bright one. The fill matters: a dashed outline alone sits at
  // ~1.5:1 against this background, which is invisible in practice.
  slot: {
    backgroundColor: C.surface,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.dash,
  },
  slotNext: { backgroundColor: C.tint, borderColor: C.accent },
  pressed: { opacity: 0.6 },
  // Marks the sticker used as the pack's icon everywhere it's exported.
  coverBadge: {
    position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 9,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center',
  },
});
