import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { C } from './src/theme';
import { initStorage } from './src/storage';
import type { Route, Nav } from './src/nav';
import PacksScreen from './src/screens/PacksScreen';
import PackScreen from './src/screens/PackScreen';
import CropScreen from './src/screens/CropScreen';
import EditorScreen from './src/screens/EditorScreen';

export default function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'packs' }]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initStorage().then(() => setReady(true)).catch(() => setReady(true));
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
            <PacksScreen nav={nav} />
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
