import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, Dimensions, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import * as Haptics from 'expo-haptics';
import { C } from '../theme';
import { Header, ListGroup, Row, EDGE } from '../ui';
import { Checkerboard } from '../editor/checker';
import type { Nav } from '../nav';
import type { Asset, Pack, Sticker } from '../types';
import {
  getSticker, getPack, getAsset, getDocument, deleteSticker, setPackCover,
  setStickerEmoji, updateStickerImage, replaceDocumentImage,
} from '../db';
import { nativePrompt } from '../../modules/native-prompt';
import { deleteFile } from '../storage';
import { STICKER_SIZE } from '../editor/renderCrop';
import { maybeAnimatedSource } from '../editor/renderAnimated';

const { width: SCREEN_W } = Dimensions.get('window');
const BOX = Math.min(SCREEN_W - EDGE * 2, 300);

/**
 * One sticker, everything you can do to it. Until now a sticker was final the
 * moment it was saved — this is where it stops being final.
 */
export default function StickerScreen({
  nav, stickerId, packId, packName,
}: { nav: Nav; stickerId: string; packId: string; packName: string }) {
  const insets = useSafeAreaInsets();
  const [sticker, setSticker] = useState<Sticker | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  const load = useCallback(async () => {
    const s = await getSticker(stickerId);
    if (!s) { nav.pop(); return; }
    setSticker(s);
    const [p, doc] = await Promise.all([getPack(packId), s.documentId ? getDocument(s.documentId) : null]);
    setPack(p);
    // The original import is kept behind every sticker; it is what makes a second
    // crop possible at full quality instead of re-cropping a 512px render.
    const layer = doc?.layers.find((l) => l.type === 'image' && l.assetId);
    setAsset(layer && 'assetId' in layer && layer.assetId ? await getAsset(layer.assetId) : null);
  }, [stickerId, packId, nav]);
  useEffect(() => { load(); }, [load]);

  if (!sticker) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const isCover = pack?.coverStickerId === sticker.id;
  // A clip's stored original is only its poster frame, so re-cropping it would
  // quietly throw the animation away. Judge the source with the same test the
  // render pipeline uses, so an animated WebP is allowed and a poster is not.
  const canRecrop = !!asset && (!sticker.animated || maybeAnimatedSource(asset.localUri, null));

  const setEmoji = async () => {
    const r = await nativePrompt({
      title: 'Sticker emoji',
      message: 'Used by Telegram, and to search stickers in WhatsApp.',
      fields: [{ placeholder: '😀', value: sticker.emoji }],
    });
    if (!r) return;
    await setStickerEmoji(sticker.id, r[0] ?? '');
    load();
  };

  const removeBackground = () => {
    const open = () => nav.push({
      name: 'cutout',
      uri: sticker.uri,
      title: 'Background',
      onDone: async (file) => {
        await updateStickerImage(sticker.id, file, STICKER_SIZE, STICKER_SIZE, false);
        // The cut-out becomes the sticker's original too, otherwise "Crop again"
        // would re-render from the old source and hand the background back.
        if (sticker.documentId) {
          try { await replaceDocumentImage(sticker.documentId, file, STICKER_SIZE, STICKER_SIZE); }
          catch (e) { console.warn('could not re-point the document at the cut-out:', e); }
        }
        await deleteFile(file); // both copies are made; the temp has done its job
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
    });
    if (!sticker.animated) { open(); return; }
    Alert.alert('This sticker moves', 'Cutting out the background keeps only the first frame — the sticker becomes a still image.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Continue', onPress: open },
    ]);
  };

  const share = async () => {
    try { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(sticker.uri); }
    catch (e: any) { Alert.alert('Share failed', String(e?.message || e)); }
  };

  const saveToPhotos = async () => {
    setBusy(true);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) { Alert.alert('Photos access needed', 'Allow "Add to Photos" to save this sticker.'); return; }
      await MediaLibrary.saveToLibraryAsync(sticker.uri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', 'The sticker is in your Photos.');
    } catch (e: any) { Alert.alert('Save failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const remove = () => {
    Alert.alert('Delete sticker?', 'Its slot in the pack becomes free again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => { setGone(true); await deleteSticker(sticker.id); nav.pop(); },
      },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 6 }}>
      <Header title={packName} onBack={busy ? undefined : nav.pop} />

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}>
        <View style={st.preview}>
          <Checkerboard size={BOX} />
          {gone ? null : (
            <Image source={{ uri: sticker.uri }} style={{ width: BOX, height: BOX }}
              contentFit="contain" cachePolicy="none" transition={120} />
          )}
        </View>
        <Text style={st.meta}>
          {sticker.animated ? 'Animated' : 'Still'} · slot {sticker.sortIndex + 1}
          {isCover ? ' · pack icon' : ''}
        </Text>

        <View style={{ gap: 22 }}>
          <ListGroup>
            <Row label="Emoji" value={sticker.emoji || 'None'} onPress={setEmoji} />
            <Row label="Use as pack icon" value={isCover ? 'Current' : null} disabled={isCover}
              onPress={async () => { await setPackCover(packId, sticker.id); Haptics.selectionAsync(); load(); }} />
          </ListGroup>

          <ListGroup>
            <Row label="Remove background" onPress={removeBackground} />
            <Row label="Crop again" onPress={() => nav.push({ name: 'crop', packId, packName, editStickerId: sticker.id })}
              disabled={!canRecrop}
              value={canRecrop ? null : asset ? 'Not for clips' : 'No original kept'} />
          </ListGroup>

          <ListGroup>
            <Row label="Share" onPress={share} />
            <Row label="Save to Photos" onPress={saveToPhotos} disabled={busy} />
          </ListGroup>

          <ListGroup>
            <Row label="Delete sticker" destructive onPress={remove} />
          </ListGroup>
        </View>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  preview: {
    width: BOX, height: BOX, alignSelf: 'center', borderRadius: 14, borderCurve: 'continuous',
    overflow: 'hidden', backgroundColor: C.surface, marginBottom: 12,
  },
  meta: { color: C.muted, fontSize: 13, textAlign: 'center', marginBottom: 22 },
});
