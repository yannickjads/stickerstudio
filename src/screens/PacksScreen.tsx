import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { Btn, NavCircle, S, EDGE } from '../ui';
import type { Nav } from '../nav';
import type { Pack } from '../types';
import { PACK_MAX } from '../types';
import { listPacks, createPack, updatePack, duplicatePack, deletePack } from '../db';
import { nativePrompt } from '../../modules/native-prompt';
import { exportAllPacks, importPacksFromZip } from '../backup';
import { importWastickers, isWastickersFile } from '../wastickers';
import appConfig from '../../app.json';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';

const { width: SCREEN_W } = Dimensions.get('window');
// Same edge-to-edge rule as the sticker grid: whole-pixel cards, remainder in the gap.
const AVAIL = Math.max(0, SCREEN_W - EDGE * 2);
const CARD = Math.max(80, Math.floor((AVAIL - 12) / 2) || 150);
const GAP = Math.max(0, AVAIL - CARD * 2) || 12;

export default function PacksScreen({ nav }: { nav: Nav }) {
  const insets = useSafeAreaInsets();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // A failure here used to leave `loading` true forever, which rendered a blank
  // screen with no explanation. Always clear it, and say what went wrong.
  const load = useCallback(async () => {
    try {
      const r = await listPacks();
      if (mounted.current) { setPacks(r); setLoadError(null); }
    } catch (e: any) {
      // Distinct from "no packs yet" — otherwise a failure looks like an empty
      // library and there is nothing to retry with.
      if (mounted.current) setLoadError(String(e?.message || e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const lastAuthor = packs.find((p) => p.author)?.author ?? '';

  const onNew = async () => {
    const r = await nativePrompt({
      title: 'New pack',
      fields: [{ placeholder: 'Name' }, { placeholder: 'Author', value: lastAuthor }],
      confirmText: 'Create',
    });
    if (!r) return;
    const p = await createPack(r[0], r[1] ?? '');
    nav.push({ name: 'pack', packId: p.id, packName: p.name });
  };

  const onEdit = async (p: Pack) => {
    const r = await nativePrompt({
      title: 'Edit pack',
      fields: [{ placeholder: 'Name', value: p.name }, { placeholder: 'Author', value: p.author }],
    });
    if (!r) return;
    await updatePack(p.id, r[0], r[1] ?? '');
    load();
  };

  const backUpAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const zip = await exportAllPacks();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(zip, { mimeType: 'application/zip', UTI: 'public.zip-archive' });
      }
    } catch (e: any) { Alert.alert('Backup failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  // Accepts our own .zip backups and .wastickers packs from other sticker apps.
  const restore = async () => {
    if (busy) return;
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/zip', 'public.zip-archive', 'com.stickerstudio.wastickers', 'public.data'],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.length) return;
    const uri = res.assets[0].uri;
    setBusy(true);
    try {
      if (isWastickersFile(uri) || /\.wastickers$/i.test(res.assets[0].name ?? '')) {
        const r = await importWastickers(uri);
        await load();
        Alert.alert('Imported', `${r.name} · ${r.stickers} sticker${r.stickers === 1 ? '' : 's'}`
          + (r.skipped ? `\n${r.skipped} could not be read.` : ''));
      } else {
        const r = await importPacksFromZip(uri);
        await load();
        Alert.alert(
          'Restored',
          `${r.stickers} sticker${r.stickers === 1 ? '' : 's'} in ${r.packs} pack${r.packs === 1 ? '' : 's'}.`
          + (r.skipped ? `\n${r.skipped} could not be read.` : ''),
        );
      }
    } catch (e: any) { Alert.alert('Import failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const appMenu = () => {
    // Version + build shown here so it's always obvious which build is installed.
    const v = appConfig.expo.version;
    const b = (appConfig.expo.ios as { buildNumber?: string }).buildNumber ?? 'dev';
    Alert.alert('Sticker Studio', `Version ${v} (${b})`, [
      { text: 'Back up all packs (.zip)', onPress: backUpAll },
      { text: 'Import .wastickers or backup…', onPress: restore },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // Alert onPress handlers are fire-and-forget: without this a repository error
  // is swallowed and the action just appears to do nothing.
  const run = async (fn: () => Promise<unknown>, failure: string) => {
    try { await fn(); } catch (e: any) { Alert.alert(failure, String(e?.message || e)); }
    finally { load(); }
  };

  const onMenu = (p: Pack) => {
    Alert.alert(p.name, undefined, [
      { text: 'Edit name & author', onPress: () => onEdit(p) },
      { text: 'Duplicate', onPress: () => run(() => duplicatePack(p.id), 'Could not duplicate') },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => Alert.alert('Delete pack?', `"${p.name}" and its stickers will be removed.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => run(() => deletePack(p.id), 'Could not delete') },
        ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      {/* Title and actions share one row: a separate nav bar above the title left
          most of two rows empty before any content appeared. */}
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>Packs</Text>
        <View style={styles.actions}>
          <NavCircle icon="ellipsis-horizontal" onPress={appMenu} disabled={busy} />
          <NavCircle icon="add" onPress={onNew} disabled={busy} />
        </View>
      </View>

      {loadError ? (
        // A failure must not look like an empty library — say so, and offer a way back.
        <View style={[S.empty, { flex: 1 }]}>
          <View style={styles.badge}><Ionicons name="alert-circle-outline" size={34} color={C.bad} /></View>
          <Text style={S.emptyTxt}>Could not load your packs.{'\n'}{loadError}</Text>
          <Btn label="Try again" onPress={() => { setLoading(true); load(); }}
            style={{ alignSelf: 'stretch', marginHorizontal: 40 }} />
        </View>
      ) : packs.length === 0 && !loading ? (
        <View style={[S.empty, { flex: 1 }]}>
          <View style={styles.badge}><Ionicons name="albums-outline" size={34} color={C.accent} /></View>
          <Text style={S.emptyTxt}>No packs yet.{'\n'}Create your first sticker pack.</Text>
          <Btn label="New pack" onPress={onNew} disabled={busy}
            style={{ alignSelf: 'stretch', marginHorizontal: 40 }} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.grid}>
          {packs.map((p) => (
            <Pressable
              key={p.id}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
              onPress={() => nav.push({ name: 'pack', packId: p.id, packName: p.name })}
              onLongPress={() => onMenu(p)}
            >
              <View style={[styles.cover, { width: CARD, height: CARD }]}>
                {p.cover ? (
                  <Image source={{ uri: p.cover }} style={styles.coverImg} contentFit="cover"
                    transition={160} cachePolicy="none" />
                ) : (
                  <Ionicons name="images-outline" size={30} color={C.line} />
                )}
              </View>
              <View style={styles.meta}>
                <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                <Text style={styles.count} numberOfLines={1}>
                  {p.count ?? 0} sticker{(p.count ?? 0) === 1 ? '' : 's'}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 66, height: 66, borderRadius: 20, backgroundColor: C.surface2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: EDGE, paddingTop: 4, paddingBottom: 12,
  },
  title: { color: C.text, fontSize: 30, fontWeight: '700', letterSpacing: 0.2, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingHorizontal: EDGE, paddingTop: 4, paddingBottom: 30 },
  card: { width: CARD },
  // Square covers, matching the sticker tiles.
  cover: {
    backgroundColor: C.surface2,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  coverImg: { width: '100%', height: '100%' },
  meta: { paddingHorizontal: 3, paddingTop: 10 },
  name: { color: C.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  count: { color: C.muted, fontSize: 13, marginTop: 2 },
});
