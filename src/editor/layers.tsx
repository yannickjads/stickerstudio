import React, { useMemo } from 'react';
import { Group, Image, Text, Skia, type SkImage, type Transforms3d } from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';
import type { ImageLayer, TextLayer } from '../types';
import { imageDraw, maskRadius } from './geometry';
import { layoutText } from './textLayout';

// transform may be a plain array (unselected) or a live SharedValue (selected + gesturing).
export type LayerTransform = Transforms3d | SharedValue<Transforms3d>;

export function ImageLayerView({
  layer, image, canvasW, canvasH, transform,
}: { layer: ImageLayer; image: SkImage; canvasW: number; canvasH: number; transform: LayerTransform }) {
  const draw = useMemo(
    () => imageDraw(layer, image.width(), image.height(), canvasW, canvasH),
    [image, layer.crop?.x, layer.crop?.y, layer.crop?.width, layer.crop?.height, layer.fit, canvasW, canvasH],
  );
  if (!layer.visible) return null;
  const rect = Skia.XYWHRect(draw.clip.x, draw.clip.y, draw.clip.width, draw.clip.height);
  const r = maskRadius(layer.mask, draw.clip.width, draw.clip.height);
  const clip = r > 0 ? Skia.RRectXY(rect, r, r) : rect;
  return (
    <Group transform={transform as any} opacity={layer.opacity}>
      <Group clip={clip}>
        <Image image={image} x={draw.imgX} y={draw.imgY} width={draw.imgW} height={draw.imgH} fit="fill" />
      </Group>
    </Group>
  );
}

export function TextLayerView({ layer, transform }: { layer: TextLayer; transform: LayerTransform }) {
  const L = useMemo(() => layoutText(layer), [layer.text, layer.fontFamily, layer.fontSize, layer.fontWeight]);
  if (!layer.visible) return null;
  const top = -L.height / 2;
  return (
    <Group transform={transform as any} opacity={layer.opacity}>
      {L.lines.map((ln, i) => {
        const y = top + i * L.lineHeight - L.ascent;
        return (
          <React.Fragment key={i}>
            {layer.stroke && layer.stroke.width > 0 ? (
              <Text x={ln.offX} y={y} text={ln.text} font={L.font}
                color={layer.stroke.color} style="stroke" strokeWidth={layer.stroke.width} strokeJoin="round" />
            ) : null}
            <Text x={ln.offX} y={y} text={ln.text} font={L.font} color={layer.fillColor} />
          </React.Fragment>
        );
      })}
    </Group>
  );
}
