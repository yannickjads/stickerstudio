import React, { useCallback, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { Canvas, Fill, Group, Rect } from '@shopify/react-native-skia';
import { C } from '../theme';
import { fitSize } from './geometry';
import {
  moveRect, resizeRect, type Aspect, type Corner, type NRect,
} from './cropGeometry';

const GRAB = 44;   // how close a finger must be to a corner to grab it
const ARM = 20;    // length of each corner bracket's arms
const BAR = 3;     // their thickness

type Props = {
  uri: string;
  imgW: number;
  imgH: number;
  stageW: number;
  stageH: number;
  aspect: Aspect;          // null = freeform
  rect: NRect;             // fraction of the image
  onChange: (r: NRect) => void;
  onSettled?: () => void;  // a drag finished — the caller can drop stale previews
};

/**
 * The whole picture, with the crop drawn ON it.
 *
 * The old cropper was a fixed window with the image panning behind it, so you
 * could never see what you were cutting away, and the freeform window fought the
 * shape controls. Here the photo is always fully visible, dimmed outside the
 * crop; you drag the rectangle to move it and its corners to resize it. Which is
 * how every photo app does it, and how people expect it to work.
 */
export default function CropOverlay({
  uri, imgW, imgH, stageW, stageH, aspect, rect, onChange, onSettled,
}: Props) {
  // Where the picture actually sits inside the stage, letterboxed.
  const { dw, dh } = useMemo(
    () => fitSize(imgW, imgH, stageW, stageH, 'contain'), [imgW, imgH, stageW, stageH],
  );
  const ox = (stageW - dw) / 2;
  const oy = (stageH - dh) / 2;

  // The crop, in stage points.
  const px = ox + rect.x * dw;
  const py = oy + rect.y * dh;
  const pw = rect.w * dw;
  const ph = rect.h * dh;

  // Everything the gesture needs, read through a ref so the gesture object never
  // has to be rebuilt — swapping it out mid-drag is what makes a drag stutter.
  const live = useRef({ rect, aspect, dw, dh, ox, oy, imgW, imgH });
  live.current = { rect, aspect, dw, dh, ox, oy, imgW, imgH };

  const mode = useRef<{ kind: 'move' | Corner; from: NRect } | null>(null);

  const onDown = useCallback((x: number, y: number) => {
    const s = live.current;
    const rx = s.ox + s.rect.x * s.dw, ry = s.oy + s.rect.y * s.dh;
    const rw = s.rect.w * s.dw, rh = s.rect.h * s.dh;
    const corners: [Corner, number, number][] = [
      ['tl', rx, ry], ['tr', rx + rw, ry], ['bl', rx, ry + rh], ['br', rx + rw, ry + rh],
    ];
    // Nearest corner wins, but only within reach — otherwise it is a move.
    let best: Corner | null = null;
    let bestD = GRAB;
    for (const [k, cxp, cyp] of corners) {
      const d = Math.hypot(x - cxp, y - cyp);
      if (d < bestD) { bestD = d; best = k; }
    }
    mode.current = { kind: best ?? 'move', from: s.rect };
  }, []);

  const onMove = useCallback((tx: number, ty: number) => {
    const m = mode.current;
    const s = live.current;
    if (!m || s.dw <= 0 || s.dh <= 0) return;
    // Translations are in points; the rect is in fractions of the image.
    const dx = tx / s.dw;
    const dy = ty / s.dh;
    onChange(m.kind === 'move'
      ? moveRect(m.from, dx, dy)
      : resizeRect(m.from, m.kind, dx, dy, s.aspect, s.imgW, s.imgH));
  }, [onChange]);

  const onUp = useCallback(() => { mode.current = null; onSettled?.(); }, [onSettled]);

  // Built once. Which corner (or the middle) is being dragged is decided inside.
  const gesture = useMemo(() => Gesture.Pan()
    .maxPointers(1)
    .minDistance(0)
    .onBegin((e) => { 'worklet'; runOnJS(onDown)(e.x, e.y); })
    .onUpdate((e) => { 'worklet'; runOnJS(onMove)(e.translationX, e.translationY); })
    .onFinalize(() => { 'worklet'; runOnJS(onUp)(); }),
  [onDown, onMove, onUp]);

  const bracket = (k: Corner) => {
    const right = k === 'tr' || k === 'br';
    const bottom = k === 'bl' || k === 'br';
    return (
      <View
        key={k}
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: (right ? px + pw - ARM : px) + (right ? BAR : -BAR),
          top: (bottom ? py + ph - ARM : py) + (bottom ? BAR : -BAR),
          width: ARM, height: ARM,
          borderColor: C.accent,
          borderTopWidth: bottom ? 0 : BAR,
          borderBottomWidth: bottom ? BAR : 0,
          borderLeftWidth: right ? 0 : BAR,
          borderRightWidth: right ? BAR : 0,
        }}
      />
    );
  };

  return (
    <View style={{ width: stageW, height: stageH }}>
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <Image
            source={{ uri }}
            style={{ position: 'absolute', left: ox, top: oy, width: dw, height: dh }}
            contentFit="fill"
            cachePolicy="memory-disk"
          />

          {/* Everything outside the crop goes dark. One layer with the crop
              punched out of it, so the edge is exact at any size. */}
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Group layer>
              <Fill color="rgba(8,10,16,0.66)" />
              <Rect x={px} y={py} width={pw} height={ph} blendMode="clear" />
            </Group>
          </Canvas>

          {/* The crop's own outline, its thirds, and a grip at each corner. */}
          <View pointerEvents="none" style={{
            position: 'absolute', left: px, top: py, width: pw, height: ph,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)',
          }}>
            <View style={[gs.v, { left: '33.33%' }]} />
            <View style={[gs.v, { left: '66.66%' }]} />
            <View style={[gs.h, { top: '33.33%' }]} />
            <View style={[gs.h, { top: '66.66%' }]} />
          </View>
          {(['tl', 'tr', 'bl', 'br'] as Corner[]).map(bracket)}
        </View>
      </GestureDetector>
    </View>
  );
}

const gs = StyleSheet.create({
  v: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.35)' },
  h: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.35)' },
});
