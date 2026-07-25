import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Canvas, Fill, Group, RoundedRect } from '@shopify/react-native-skia';
import { C } from './theme';
import { maskRadius } from './editor/geometry';
import type { MaskShape } from './types';

type Props = {
  uri: string;
  imgW: number;
  imgH: number;
  viewW: number;             // crop window size (screen px) — any aspect ratio
  viewH: number;
  shape?: MaskShape;         // live shape-mask preview (dim outside the shape)
  tx: SharedValue<number>;   // pan X (owned by parent so it can read the crop)
  ty: SharedValue<number>;
  scale: SharedValue<number>; // pinch scale (>= 1)
};

/**
 * Fixed crop window of any aspect ratio; the user pans/pinches the IMAGE behind it
 * (Instagram-style). The image "covers" the window at scale 1 and translation is
 * clamped per axis, so every crop is valid. An optional shape overlay previews the
 * mask by dimming everything outside it.
 */
export default function Cropper({ uri, imgW, imgH, viewW, viewH, shape, tx, ty, scale }: Props) {
  const coverScale = Math.max(viewW / imgW, viewH / imgH);
  const baseW = imgW * coverScale;
  const baseH = imgH * coverScale;

  const startTx = useSharedValue(0);
  const startTy = useSharedValue(0);
  const startScale = useSharedValue(1);

  const pan = Gesture.Pan()
    .onStart(() => {
      startTx.value = tx.value;
      startTy.value = ty.value;
    })
    .onUpdate((e) => {
      const maxTx = Math.max(0, (baseW * scale.value - viewW) / 2);
      const maxTy = Math.max(0, (baseH * scale.value - viewH) / 2);
      tx.value = Math.min(Math.max(startTx.value + e.translationX, -maxTx), maxTx);
      ty.value = Math.min(Math.max(startTy.value + e.translationY, -maxTy), maxTy);
    });

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate((e) => {
      const s = Math.min(Math.max(startScale.value * e.scale, 1), 8);
      scale.value = s;
      const maxTx = Math.max(0, (baseW * s - viewW) / 2);
      const maxTy = Math.max(0, (baseH * s - viewH) / 2);
      tx.value = Math.min(Math.max(tx.value, -maxTx), maxTx);
      ty.value = Math.min(Math.max(ty.value, -maxTy), maxTy);
    });

  const gesture = Gesture.Simultaneous(pan, pinch);

  const imgStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  const r = maskRadius(shape, viewW, viewH);

  return (
    <View style={[styles.viewport, { width: viewW, height: viewH }]}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={styles.fill} collapsable={false}>
          <Animated.Image
            source={{ uri }}
            style={[
              {
                position: 'absolute',
                width: baseW,
                height: baseH,
                left: (viewW - baseW) / 2,
                top: (viewH - baseH) / 2,
              },
              imgStyle,
            ]}
          />
        </Animated.View>
      </GestureDetector>

      {/* shape-mask preview: dim outside the shape (punched out via blendMode clear).
          The canvas stays MOUNTED at all times — with r=0 the punch covers everything
          (invisible). Changing only the radius prop redraws reliably; conditionally
          mounting a Skia canvas can skip its first paint. */}
      <View pointerEvents="none" style={styles.fill}>
        <Canvas style={{ width: viewW, height: viewH }}>
          <Group layer>
            <Fill color="rgba(10,12,18,0.6)" />
            <RoundedRect x={0} y={0} width={viewW} height={viewH} r={r} blendMode="clear" />
          </Group>
        </Canvas>
      </View>

      {/* rule-of-thirds guides */}
      <View pointerEvents="none" style={styles.grid}>
        <View style={[styles.v, { left: '33.33%' }]} />
        <View style={[styles.v, { left: '66.66%' }]} />
        <View style={[styles.h, { top: '33.33%' }]} />
        <View style={[styles.h, { top: '66.66%' }]} />
      </View>
      <View pointerEvents="none" style={styles.border} />
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: C.surface2,
    alignSelf: 'center',
  },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  grid: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  v: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.18)' },
  h: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.18)' },
  border: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: C.accent,
  },
});
