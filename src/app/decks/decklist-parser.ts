import { DeckEntry } from './deck.types';

/**
 * Section headers emitted by the common deckbuilder exports (Arena, Moxfield,
 * Archidekt, Scryfall, …). They separate board sections we don't distinguish
 * yet, so the lines are skipped and every card lands in one list.
 */
const SECTION_HEADER =
  /^(about|deck|main|mainboard|commander|companion|sideboard|maybeboard|considering|tokens?)\s*:?$/i;

/** `4 Lightning Bolt` / `4x Lightning Bolt` — leading count. */
const COUNT_PREFIX = /^(\d+)\s*[x×]?\s+(.+)$/i;

/** `Lightning Bolt x4` — trailing count (only checked when no leading count). */
const COUNT_SUFFIX = /^(.+?)\s+[x×](\d+)$/i;

/**
 * Trailing decorations exporters append after the name, removed until none are
 * left: `[Category]` (Archidekt), `*F*` foil markers, `^Have^` flags.
 */
const TRAILING_MARKER = /\s*(\[[^\]]*\]|\*[^*]*\*|\^[^^]*\^)$/;

/**
 * `(SET) 123` — a set code and optional collector number (Arena, Moxfield,
 * Scryfall exports). The set-code group has no spaces, so parenthesized parts
 * of real card names ("B.F.M. (Big Furry Monster)") don't match.
 */
const SET_AND_COLLECTOR = /\s*\(([A-Za-z0-9]{2,6})\)(\s+[\w★†-]+)?$/;

function stripDecorations(raw: string): string {
  let name = raw.trim();
  let previous;
  do {
    previous = name;
    name = name.replace(TRAILING_MARKER, '');
  } while (name !== previous);
  return name.replace(SET_AND_COLLECTOR, '').trim();
}

/**
 * Parse a pasted decklist into entries, covering the common export formats:
 * plain name-per-line lists, `4x` counts, MTGO's `SB:` prefix, Arena/Moxfield
 * `(SET) 123` suffixes, and Archidekt category/foil markers. Blank lines,
 * comments (`//`, `#`), and section headers are skipped; duplicate names merge
 * their counts (case-insensitive, first spelling wins). Returns [] when
 * nothing parseable is found.
 */
export function parseDecklist(text: string): DeckEntry[] {
  const entries = new Map<string, DeckEntry>();
  let afterAbout = false;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    if (SECTION_HEADER.test(line)) {
      afterAbout = /^about\b/i.test(line);
      continue;
    }
    if (afterAbout) {
      // Arena's "About" section carries a "Name <deck name>" line, not a card.
      afterAbout = false;
      if (/^name\s+/i.test(line)) continue;
    }
    line = line.replace(/^SB:\s*/i, ''); // MTGO sideboard prefix

    const prefixed = COUNT_PREFIX.exec(line);
    let count = prefixed ? Number(prefixed[1]) : 1;
    let name = stripDecorations(prefixed ? prefixed[2]! : line);
    if (!prefixed) {
      const suffixed = COUNT_SUFFIX.exec(name);
      if (suffixed) {
        name = suffixed[1]!;
        count = Number(suffixed[2]);
      }
    }
    if (!name || count < 1) continue;

    const key = name.toLowerCase();
    const existing = entries.get(key);
    if (existing) existing.count += count;
    else entries.set(key, { card: name, count });
  }
  return [...entries.values()];
}
