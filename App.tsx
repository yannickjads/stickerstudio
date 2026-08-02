import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, Alert, Linking } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useShareIntent } from 'expo-share-intent';
import { C } from './src/theme';
import { sheet, SheetHost } from './src/ui';
import { initStorage } from './src/storage';
import { importWastickers, isWastickersFile, archiveKind } from './src/wastickers';
import { importPacksFromZip } from './src/backup';
import { listPacks, createPack } from './src/db';
import { nativePrompt } from './modules/native-prompt';
import { PACK_MAX } from './src/types';
import type { Pack } from './src/types';
import type { Route, Nav } from './src/nav';
import PacksScreen from './src/screens/PacksScreen';
import PackScreen from './src/screens/PackScreen';
import CropScreen from './src/screens/CropScreen';
import StickerScreen from './src/screens/StickerScreen';
import CutoutScreen from './src/screens/CutoutScreen';
import EditorScreen from './src/screens/EditorScreen';

export default function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'packs' }]);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const handling = useRef(false);
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

  useEffect(() => {
    initStorage().then(() => setReady(true)).catch(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!hasShareIntent || !ready) return;
    const files = shareIntent?.files?.filter((f) => f.mimeType?.startsWith('image/'));
    if (!files?.length) { resetShareIntent(); return; }
    const shared = files.map((f) => ({
      uri: f.path, w: f.width || 512, h: f.height || 512,
    }));
    const pickPack = async () => {
      await initStorage();
      const packs = await listPacks();
      const goToCrop = (pack: Pack) => {
        resetShareIntent();
        setStack([
          { name: 'packs' },
          { name: 'pack', packId: pack.id, packName: pack.name },
          { name: 'crop', packId: pack.id, packName: pack.name, sharedUris: shared },
        ]);
      };
      const makeNew = async () => {
        const r = await nativePrompt({
          title: 'New pack',
          fields: [{ placeholder: 'Name' }, { placeholder: 'Author' }],
          confirmText: 'Create',
        });
        if (!r) { resetShareIntent(); return; }
        const p = await createPack(r[0], r[1] ?? '');
        goToCrop(p);
      };
      sheet({
        title: `Add to pack`,
        message: `${shared.length} image${shared.length === 1 ? '' : 's'}`,
        options: [
          ...packs.map((p) => ({
            label: p.name,
            onPress: () => goToCrop(p),
          })),
          { label: 'New pack', onPress: makeNew },
        ],
      });
    };
    pickPack();
  }, [hasShareIntent, ready]);

  // Opening a .wastickers pack (or one of our .zip backups) from Files, Mail or
  // AirDrop hands the app a file:// url — import it and land on the packs list.
  useEffect(() => {
    const open = async (url: string | null) => {
      if (!url || handling.current) return;
      // Anything handed to us as a file, whatever it is called. Sharing a pack
      // straight out of another sticker app gives it that app's extension — often
      // just ".zip" — so the archive's CONTENTS decide how to read it.
      if (!/^file:\/\//i.test(url)) return;
      handling.current = true;
      try {
        await initStorage();
        const kind = await archiveKind(url);
        if (kind === 'unknown') {
          if (isWastickersFile(url) || /\.zip(\?|$)/i.test(url)) {
            Alert.alert('Could not import', 'That file has no sticker pack in it.');
          }
          return;
        }
        const r = kind === 'stickers'
          ? await importWastickers(url)
          : await importPacksFromZip(url).then((x) => ({ name: `${x.packs} pack(s)`, stickers: x.stickers, skipped: x.skipped, dropped: 0, tray: false }));
        setStack([{ name: 'packs' }]);
        setReload((n) => n + 1);
        Alert.alert('Imported', `${r.name} · ${r.stickers} sticker${r.stickers === 1 ? '' : 's'}`
          + (r.skipped ? `\n${r.skipped} could not be read.` : '')
          + (r.dropped ? `\n${r.dropped} didn't fit — a pack holds ${PACK_MAX}.` : '')
          // Say out loud whether the archive's own icon was recognised: a pack that
          // imports one sticker too many is then immediately explainable.
          + (kind === 'stickers'
            ? (r.tray ? '\nIts pack icon was kept separately.' : '\nNo separate pack icon in that file.')
            : ''));
      } catch (e: any) {
        Alert.alert('Could not import', String(e?.message || e));
      } finally {
        handling.current = false;
      }
    };
    Linking.getInitialURL().then(open);
    const sub = Linking.addEventListener('url', (e) => open(e.url));
    return () => sub.remove();
  }, []);

  const nav: Nav = {
    push: (r) => setStack((s) => [...s, r]),
    pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
  };
  const route = stack[stack.length - 1];

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar style="light" />
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          {!ready ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={C.accent} />
            </View>
          ) : route.name === 'packs' ? (
            <PacksScreen key={reload} nav={nav} />
          ) : route.name === 'pack' ? (
            <PackScreen nav={nav} packId={route.packId} packName={route.packName} />
          ) : route.name === 'crop' ? (
            <CropScreen nav={nav} packId={route.packId} packName={route.packName}
              startSlot={route.startSlot} editStickerId={route.editStickerId} source={route.source}
              sharedUris={route.sharedUris} />
          ) : route.name === 'sticker' ? (
            <StickerScreen nav={nav} stickerId={route.stickerId} packId={route.packId} packName={route.packName} />
          ) : route.name === 'cutout' ? (
            <CutoutScreen nav={nav} uri={route.uri} title={route.title} onDone={route.onDone} />
          ) : (
            <EditorScreen nav={nav} stickerId={route.stickerId} packName={route.packName} />
          )}
        </View>
        {/* One sheet host for the whole app, above every screen. */}
        <SheetHost />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
