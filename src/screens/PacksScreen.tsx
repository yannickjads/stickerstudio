import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, Dimensions, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { C } from '../theme';
import { Btn, NavCircle, S, EDGE, Sym, TAB_BAR_H } from '../ui';
import type { Nav } from '../nav';
import type { Pack } from '../types';
import { listPacks, createPack, updatePack, duplicatePack, deletePack } from '../db';
import { nativePrompt, nativeActionSheet } from '../../modules/native-prompt';

const { width: SCREEN_W } = Dimensions.get('window');
// Same edge-to-edge rule as the sticker grid: whole-pixel cards, remainder in the gap.
const AVAIL = Math.max(0, SCREEN_W - EDGE * 2);
const CARD = Math.max(80, Math.floor((AVAIL - 12) / 2) || 150);
const GAP = Math.max(0, AVAIL - CARD * 2) || 12;

export default function PacksScreen({ nav }: { nav: Nav }) {
  const insets = useSafeAreaInsets();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
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

  // Searching only earns its place once the grid stops fitting on a screen.
  const SEARCH_FROM = 7;
  const q = query.trim().toLowerCase();
  const shown = q
    ? packs.filter((p) => p.name.toLowerCase().includes(q) || p.author.toLowerCase().includes(q))
    : packs;

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

  // Alert onPress handlers are fire-and-forget: without this a repository error
  // is swallowed and the action just appears to do nothing.
  const run = async (fn: () => Promise<unknown>, failure: string) => {
    try { await fn(); } catch (e: any) { Alert.alert(failure, String(e?.message || e)); }
    finally { load(); }
  };

  const onMenu = (p: Pack) => {
    nativeActionSheet({
      title: p.name,
      options: [
        { label: 'Edit name & author', onPress: () => onEdit(p) },
        { label: 'Duplicate', onPress: () => run(() => duplicatePack(p.id), 'Could not duplicate') },
        {
          label: 'Delete',
          destructive: true,
          onPress: () => Alert.alert('Delete pack?', `"${p.name}" and its stickers will be removed.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => run(() => deletePack(p.id), 'Could not delete') },
          ]),
        },
      ],
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      {/* Title and actions share one row: a separate nav bar above the title left
          most of two rows empty before any content appeared. */}
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>Packs</Text>
        <View style={styles.actions}>
          {packs.length >= SEARCH_FROM ? (
            <NavCircle icon={searching ? 'close' : 'search'}
              onPress={() => { setSearching((v) => !v); setQuery(''); }} />
          ) : null}
          <NavCircle icon="add" onPress={onNew} />
        </View>
      </View>

      {searching ? (
        <View style={styles.searchRow}>
          <Sym name="search" size={16} color={C.muted} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={C.muted}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      ) : null}

      {loadError ? (
        // A failure must not look like an empty library — say so, and offer a way back.
        <View style={[S.empty, { flex: 1 }]}>
          <View style={styles.badge}><Sym name="warning" size={32} color={C.bad} /></View>
          <Text style={S.emptyTxt}>Could not load your packs.{'\n'}{loadError}</Text>
          <Btn label="Try again" onPress={() => { setLoading(true); load(); }}
            style={{ alignSelf: 'stretch', marginHorizontal: EDGE }} />
        </View>
      ) : packs.length === 0 && !loading ? (
        <View style={[S.empty, { flex: 1 }]}>
          <View style={styles.badge}><Sym name="packs" size={32} /></View>
          <Text style={S.emptyTxt}>No packs yet.{'\n'}Create your first sticker pack.</Text>
          <Btn label="New pack" onPress={onNew}
            style={{ alignSelf: 'stretch', marginHorizontal: EDGE }} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.grid} keyboardShouldPersistTaps="handled">
          {q && shown.length === 0 ? (
            <Text style={styles.noHits}>No packs match “{query.trim()}”.</Text>
          ) : null}
          {shown.map((p) => (
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
                  <Sym name="photos" size={28} color={C.line} />
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
  title: { color: C.text, fontSize: 34, fontWeight: '700', letterSpacing: 0.2, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginHorizontal: EDGE, marginBottom: 12, paddingHorizontal: 10,
    height: 36, borderRadius: 12, borderCurve: 'continuous',
    backgroundColor: 'rgba(118,118,128,0.12)',
  },
  searchInput: { flex: 1, color: C.text, fontSize: 17, padding: 0, letterSpacing: -0.2 },
  noHits: { width: '100%', color: C.muted, fontSize: 15, paddingVertical: 24, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingHorizontal: EDGE, paddingTop: 4, paddingBottom: TAB_BAR_H + 50 },
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
