import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { C } from '../theme';
import { LargeHeader, ListGroup, Row, EDGE, TAB_BAR_H } from '../ui';
import { exportAllPacks, importPacksFromZip } from '../backup';
import { importWastickers, isWastickersFile } from '../wastickers';
import appConfig from '../../app.json';

export default function SettingsScreen({ onImport }: { onImport: () => void }) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const v = appConfig.expo.version;
  const b = (appConfig.expo.ios as { buildNumber?: string }).buildNumber ?? 'dev';

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
        onImport();
        Alert.alert('Imported', `${r.name} · ${r.stickers} sticker${r.stickers === 1 ? '' : 's'}`
          + (r.skipped ? `\n${r.skipped} could not be read.` : ''));
      } else {
        const r = await importPacksFromZip(uri);
        onImport();
        Alert.alert(
          'Restored',
          `${r.stickers} sticker${r.stickers === 1 ? '' : 's'} in ${r.packs} pack${r.packs === 1 ? '' : 's'}.`
          + (r.skipped ? `\n${r.skipped} could not be read.` : ''),
        );
      }
    } catch (e: any) { Alert.alert('Import failed', String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <LargeHeader title="Settings" />
      <ScrollView contentContainerStyle={{ paddingBottom: TAB_BAR_H + insets.bottom + 20 }}>
        <ListGroup>
          <Row label="Back up all packs" onPress={backUpAll} disabled={busy} />
          <Row label="Import stickers..." onPress={restore} disabled={busy} />
        </ListGroup>
        <Text style={styles.version}>Version {v} ({b})</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  version: { color: C.muted, fontSize: 13, textAlign: 'center', marginTop: 32 },
});
