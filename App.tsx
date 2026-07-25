import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, Alert, Linking } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { C } from './src/theme';
import { initStorage } from './src/storage';
import { importWastickers, isWastickersFile } from './src/wastickers';
import { importPacksFromZip } from './src/backup';
import type { Route, Nav } from './src/nav';
import PacksScreen from './src/screens/PacksScreen';
import PackScreen from './src/screens/PackScreen';
import CropScreen from './src/screens/CropScreen';
import EditorScreen from './src/screens/EditorScreen';

export default function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'packs' }]);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const handling = useRef(false);

  useEffect(() => {
    initStorage().then(() => setReady(true)).catch(() => setReady(true));
  }, []);

  // Opening a .wastickers pack (or one of our .zip backups) from Files, Mail or
  // AirDrop hands the app a file:// url — import it and land on the packs list.
  useEffect(() => {
    const open = async (url: string | null) => {
      if (!url || handling.current) return;
      if (!/\.(wastickers|zip)(\?|$)/i.test(url)) return;
      handling.current = true;
      try {
        await initStorage();
        const r = isWastickersFile(url)
          ? await importWastickers(url)
          : await importPacksFromZip(url).then((x) => ({ name: `${x.packs} pack(s)`, stickers: x.stickers, skipped: x.skipped }));
        setStack([{ name: 'packs' }]);
        setReload((n) => n + 1);
        Alert.alert('Imported', `${r.name} · ${r.stickers} sticker${r.stickers === 1 ? '' : 's'}`
          + (r.skipped ? `\n${r.skipped} could not be read.` : ''));
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
            <CropScreen nav={nav} packId={route.packId} packName={route.packName} startSlot={route.startSlot} />
          ) : (
            <EditorScreen nav={nav} stickerId={route.stickerId} packName={route.packName} />
          )}
        </View>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
