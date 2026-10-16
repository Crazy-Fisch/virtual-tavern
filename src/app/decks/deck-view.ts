import { CardInfo } from '../carddb/card-info';
import { DeckEntry } from './deck.types';

/** One deck line with what the editor knows about its card. */
export type DeckRow = {
  entry: DeckEntry;
  /** Position in the edited list, the handle for count/art/remove actions. */
  index: number;
  info: CardInfo | undefined;
  /** Image to show: the chosen print, else the card's default art ('' = none). */
  src: string;
};

export type SortKey = 'name' | 'cmc' | 'color' | 'type' | 'rarity';
export type GroupKey = 'none' | 'type' | 'color' | 'cmc';

export type DeckFilter = {
  text: string;
  /** Colour letters plus `C` for colourless; a card matches when it has any of them. */
  colors: string[];
  /** Card types; a card matches when its type line has any of them. */
  types: string[];
  /** Mana values; 7 stands for 7 and above. */
  cmcs: number[];
};

export type RowGroup = { label: string; rows: DeckRow[]; count: number };

export const NO_FILTER: DeckFilter = { text: '', colors: [], types: [], cmcs: [] };

export const COLOR_NAMES: Record<string, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
  C: 'Colorless',
};

/** Display order of the card types; a card's group is the first one its type line has. */
export const CARD_TYPES = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
] as const;

export const MAX_CMC = 7;
const WUBRG = 'WUBRG';
const RARITIES = ['common', 'uncommon', 'rare', 'mythic'];
const UNKNOWN = 'Unknown';

export function deckCount(rows: DeckRow[]): number {
  return rows.reduce((total, row) => total + row.entry.count, 0);
}

/** The one type a card is grouped under; lands win so an artifact land counts as a land. */
export function primaryType(info: CardInfo | undefined): string {
  if (!info) return UNKNOWN;
  if (hasType(info, 'Land')) return 'Land';
  return CARD_TYPES.find((t) => hasType(info, t)) ?? 'Other';
}

function hasType(info: CardInfo, type: string): boolean {
  return new RegExp(`\\b${type}\\b`, 'i').test(info.typeLine);
}

/** Colour group name: one of the five colours, Multicolor, Colorless (lands included) or Unknown. */
export function colorGroup(info: CardInfo | undefined): string {
  if (!info) return UNKNOWN;
  if (info.colors.length === 0) return COLOR_NAMES['C']!;
  if (info.colors.length > 1) return 'Multicolor';
  return COLOR_NAMES[info.colors[0]!] ?? UNKNOWN;
}

function colorRank(info: CardInfo | undefined): number {
  if (!info) return 9;
  if (info.colors.length === 0) return 8;
  if (info.colors.length > 1) return 6 + info.colors.length / 10;
  return WUBRG.indexOf(info.colors[0]!);
}

/** Mana value bucket 0..MAX_CMC, or -1 for a card nothing is known about. */
export function cmcBucket(info: CardInfo | undefined): number {
  return info ? Math.min(Math.floor(info.cmc), MAX_CMC) : -1;
}

function typeRank(info: CardInfo | undefined): number {
  const type = primaryType(info);
  const at = (CARD_TYPES as readonly string[]).indexOf(type);
  return at >= 0 ? at : CARD_TYPES.length;
}

function rarityRank(info: CardInfo | undefined): number {
  if (!info) return RARITIES.length + 1;
  const at = RARITIES.indexOf(info.rarity);
  return at >= 0 ? at : RARITIES.length;
}

function byName(a: DeckRow, b: DeckRow): number {
  return a.entry.card.localeCompare(b.entry.card);
}

const SORTERS: Record<SortKey, (a: DeckRow, b: DeckRow) => number> = {
  name: byName,
  cmc: (a, b) => (a.info?.cmc ?? -1) - (b.info?.cmc ?? -1),
  color: (a, b) => colorRank(a.info) - colorRank(b.info),
  type: (a, b) => typeRank(a.info) - typeRank(b.info),
  rarity: (a, b) => rarityRank(a.info) - rarityRank(b.info),
};

/** Rows ordered by `key` (ties by name); `descending` reverses the key, not the name tiebreak. */
export function sortRows(rows: DeckRow[], key: SortKey, descending: boolean): DeckRow[] {
  const sign = descending ? -1 : 1;
  return [...rows].sort((a, b) => sign * SORTERS[key](a, b) || byName(a, b));
}

export function isFiltering(filter: DeckFilter): boolean {
  return !!(
    filter.text.trim() ||
    filter.colors.length ||
    filter.types.length ||
    filter.cmcs.length
  );
}

/** Rows that satisfy every active filter; a card with no known data fails the data-based ones. */
export function filterRows(rows: DeckRow[], filter: DeckFilter): DeckRow[] {
  const text = filter.text.trim().toLowerCase();
  return rows.filter(({ entry, info }) => {
    if (text && !`${entry.card} ${info?.typeLine ?? ''}`.toLowerCase().includes(text)) return false;
    if (filter.colors.length) {
      if (!info) return false;
      const has = info.colors.length ? info.colors : ['C'];
      if (!filter.colors.some((c) => has.includes(c))) return false;
    }
    if (filter.types.length && (!info || !filter.types.some((t) => hasType(info, t)))) return false;
    return !filter.cmcs.length || filter.cmcs.includes(cmcBucket(info));
  });
}

/** Rows split into labelled groups (in a sensible order, empty ones left out) with copy counts. */
export function groupRows(rows: DeckRow[], key: GroupKey): RowGroup[] {
  if (key === 'none')
    return rows.length ? [{ label: 'All cards', rows, count: deckCount(rows) }] : [];
  const label = (row: DeckRow): string =>
    key === 'type'
      ? primaryType(row.info)
      : key === 'color'
        ? colorGroup(row.info)
        : row.info
          ? cmcLabel(cmcBucket(row.info))
          : UNKNOWN;
  const order = (name: string): number => {
    if (key === 'type') return (CARD_TYPES as readonly string[]).indexOf(name);
    if (key === 'color') return [...Object.values(COLOR_NAMES), 'Multicolor'].indexOf(name);
    return name === UNKNOWN ? 99 : Number.parseInt(name, 10);
  };
  const groups = new Map<string, DeckRow[]>();
  for (const row of rows) {
    const name = label(row);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  const rank = (name: string): number => {
    const at = order(name);
    return at < 0 || Number.isNaN(at) ? 90 : at;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, group]) => ({
      label: key === 'cmc' && name !== UNKNOWN ? `Mana value ${name}` : name,
      rows: group,
      count: deckCount(group),
    }));
}

export function cmcLabel(bucket: number): string {
  return bucket >= MAX_CMC ? `${MAX_CMC}+` : String(bucket);
}

/** Copies per mana value 0..MAX_CMC (7+ in the last bar), lands left out. */
export function manaCurve(rows: DeckRow[]): number[] {
  const curve = Array.from({ length: MAX_CMC + 1 }, () => 0);
  for (const { entry, info } of rows) {
    if (info && primaryType(info) !== 'Land') curve[cmcBucket(info)]! += entry.count;
  }
  return curve;
}
