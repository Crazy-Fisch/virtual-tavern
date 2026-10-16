import { DeckEntry, DeckPrint, printKey } from './deck.types';

/** Merge lines of the same card and print (case-insensitive name, first spelling wins). */
export function mergeEntries(list: DeckEntry[]): DeckEntry[] {
  const merged = new Map<string, DeckEntry>();
  for (const entry of list) {
    const key = `${entry.card.toLowerCase()}|${printKey(entry.print)}`;
    const existing = merged.get(key);
    if (existing) existing.count += entry.count;
    else merged.set(key, { ...entry });
  }
  return [...merged.values()];
}

/**
 * Set the print of `count` copies (default: the whole line) of the entry at
 * `index`, or clear it with `print` undefined. Copies split off into their own
 * line; a line ending up with the same card and print as another merges into it.
 */
export function withPrint(
  list: DeckEntry[],
  index: number,
  print: DeckPrint | undefined,
  count?: number,
): DeckEntry[] {
  const entry = list[index];
  if (!entry) return list;
  const moved = Math.min(Math.max(count ?? entry.count, 1), entry.count);
  const rest = entry.count - moved;
  const changed: DeckEntry = { card: entry.card, count: moved, ...(print ? { print } : {}) };
  return mergeEntries(
    list.flatMap((e, i) => {
      if (i !== index) return [e];
      return rest > 0 ? [{ ...entry, count: rest }, changed] : [changed];
    }),
  );
}

/** Add `by` copies of a card: onto its default-art line, which is created when missing. */
export function withAdded(list: DeckEntry[], card: string, by = 1): DeckEntry[] {
  const lower = card.toLowerCase();
  const at = list.findIndex((e) => e.card.toLowerCase() === lower && !e.print);
  if (at < 0) return [...list, { card, count: by }];
  return list.map((e, i) => (i === at ? { ...e, count: e.count + by } : e));
}

/** Change a line's count by `delta`; a line that reaches zero is removed. */
export function withDelta(list: DeckEntry[], index: number, delta: number): DeckEntry[] {
  return list.flatMap((e, i) => {
    if (i !== index) return [e];
    const count = e.count + delta;
    return count > 0 ? [{ ...e, count }] : [];
  });
}

/** Drop the line at `index`. */
export function withoutLine(list: DeckEntry[], index: number): DeckEntry[] {
  return list.filter((_, i) => i !== index);
}

/** The list as pasteable text: `4 Lightning Bolt (2X2) 117`, the set part only where a print is chosen. */
export function exportDecklist(list: DeckEntry[]): string {
  return list
    .map((e) => {
      const print = e.print;
      const where = print
        ? ` (${print.set.toUpperCase()})${print.collector ? ` ${print.collector}` : ''}`
        : '';
      return `${e.count} ${e.card}${where}`;
    })
    .join('\n');
}
