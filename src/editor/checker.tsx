import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Canvas, Rect } from '@shopify/react-native-skia';

export const CHECK = 16;

// The "this part is see-through" backdrop, as Skia nodes so it can share a canvas
// with the image it sits behind. Two flat colours rather than the usual grey pair:
// on a dark app a light checkerboard reads as part of the picture.
export function checkerRects(size: number, tile = CHECK) {
  const n = Math.ceil(size / tile);
  const out: React.ReactNode[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = (y % 2); x < n; x += 2) {
      out.push(<Rect key={`${x}-${y}`} x={x * tile} y={y * tile} width={tile} height={tile} color="#20242f" />);
    }
  }
  return out;
}

// Standalone version, for showing a finished sticker over transparency.
export function Checkerboard({ size, tile = CHECK }: { size: number; tile?: number }) {
  const rects = React.useMemo(() => checkerRects(size, tile), [size, tile]);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#171a23' }]}>
      <Canvas style={{ width: size, height: size }}>{rects}</Canvas>
    </View>
  );
}
