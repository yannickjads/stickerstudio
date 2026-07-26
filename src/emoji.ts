// Taking exactly one emoji off the front of a string.
//
// Pure, and deliberately written without Unicode property escapes or Intl.Segmenter:
// Hermes' support for both is patchy, and a regex that fails to parse would take
// the whole module down at load time. Plain code-point arithmetic works everywhere.

const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

// Things that attach to the character before them rather than standing alone:
// the emoji variation selector, the keycap mark, and the five skin tones.
const isModifier = (cp: number) =>
  cp === 0xfe0f || cp === 0xfe0e || cp === 0x20e3 || (cp >= 0x1f3fb && cp <= 0x1f3ff);

const ZWJ = 0x200d;

/**
 * The first emoji in `input`, kept whole.
 *
 * Naively taking the first code point breaks every emoji built from more than
 * one: a flag is a pair of regional indicators, a thumbs-up with a skin tone is a
 * base plus a modifier, and a family is several people joined by zero-width
 * joiners. Slicing those apart stores half a character, which then travels to
 * WhatsApp and Telegram as a stray box.
 */
export function firstEmoji(input: string): string {
  const cps = Array.from((input ?? '').trim());
  if (!cps.length) return '';
  const at = (i: number) => cps[i].codePointAt(0) ?? 0;

  // A flag is exactly two regional indicators and nothing more.
  if (cps.length >= 2 && isRegionalIndicator(at(0)) && isRegionalIndicator(at(1))) {
    return cps[0] + cps[1];
  }

  let i = 1;
  while (i < cps.length) {
    const cp = at(i);
    if (isModifier(cp)) { i++; continue; }
    // A joiner is only a joiner if something follows it to be joined.
    if (cp === ZWJ && i + 1 < cps.length) { i += 2; continue; }
    break;
  }
  return cps.slice(0, i).join('');
}
