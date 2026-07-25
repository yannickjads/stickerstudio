// Single source of truth for laying out a text layer (multi-line aware, side-bearing
// corrected). Used by TextLayerView for rendering AND by the editor for hit-testing /
// selection boxes, so the two never diverge.
import { matchFont, type SkFont } from '@shopify/react-native-skia';
import type { TextLayer } from '../types';

export type TextLine = { text: string; offX: number };
export type TextLayout = {
  font: SkFont;
  lines: TextLine[];
  width: number;      // widest line (ink)
  height: number;     // total block height
  lineHeight: number;
  ascent: number;     // negative (above baseline)
};

export function layoutText(layer: TextLayer): TextLayout {
  const font = matchFont({
    fontFamily: layer.fontFamily,
    fontSize: layer.fontSize,
    fontWeight: layer.fontWeight as any,
  });
  const m = font.getMetrics();
  const ascent = m.ascent;
  const descent = m.descent;
  const lineHeight = (descent - ascent) + (m.leading || 0);
  const raw = (layer.text ?? '').split('\n');
  const src = raw.length ? raw : [''];
  let width = 0;
  const lines: TextLine[] = src.map((ln) => {
    const r = font.measureText(ln.length ? ln : ' ');
    if (r.width > width) width = r.width;
    // center each line on its ink box (includes left side bearing r.x)
    return { text: ln, offX: -(r.x + r.width / 2) };
  });
  return { font, lines, width, height: lineHeight * src.length, lineHeight, ascent };
}
