import React from 'react';
import { Canvas, Group, RoundedRect, Circle } from '@shopify/react-native-skia';
import type { LayerTransform } from './layers';
import { C } from '../theme';

// Draws the selected layer's bounding box + corner ticks in a SEPARATE canvas that is
// never snapshotted, so the export PNG stays clean. Sits under a pointerEvents="none"
// view so touches fall through to the content canvas's gesture detector.
export function SelectionOverlay({
  box, transform, dispScale, display,
}: { box: { w: number; h: number }; transform: LayerTransform; dispScale: number; display: number }) {
  const w = box.w, h = box.h;
  const sw = 2 / dispScale;      // ~2px on screen regardless of canvas scale
  const r = 5 / dispScale;       // corner tick radius
  const hw = w / 2, hh = h / 2;
  const corners = [
    { x: -hw, y: -hh }, { x: hw, y: -hh }, { x: -hw, y: hh }, { x: hw, y: hh },
  ];
  return (
    <Canvas style={{ width: display, height: display }}>
      <Group transform={[{ scale: dispScale }]}>
        <Group transform={transform as any}>
          <RoundedRect x={-hw} y={-hh} width={w} height={h} r={6 / dispScale}
            color={C.accent} style="stroke" strokeWidth={sw} />
          {corners.map((c, i) => (
            <Circle key={i} cx={c.x} cy={c.y} r={r} color={C.accent} />
          ))}
        </Group>
      </Group>
    </Canvas>
  );
}
