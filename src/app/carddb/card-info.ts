import { facesOf } from './card-database.service';

/** The card-object fields the deck editor reads (a Scryfall-compatible card). */
export type ApiInfoCard = {
  name?: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  colors?: string[];
  rarity?: string;
  set?: string;
  collector_number?: string;
  image_uris?: { normal?: string };
  card_faces?: {
    mana_cost?: string;
    type_line?: string;
    colors?: string[];
    image_uris?: { normal?: string };
  }[];
};

/** What the deck editor sorts, groups and filters on, one per card name. */
export type CardInfo = {
  name: string;
  /** `{2}{R}`-style cost of the front face, '' for lands and the like. */
  manaCost: string;
  /** Mana value. */
  cmc: number;
  typeLine: string;
  /** Colour letters in WUBRG order; empty = colourless. */
  colors: string[];
  rarity: string;
  src: string;
  back?: string;
  set?: string;
  collector?: string;
};

const WUBRG = 'WUBRG';

function byWubrg(colors: string[]): string[] {
  return [...new Set(colors)].sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b));
}

/** Condense an API card into the editor's record; null without a name. */
export function infoOf(card: ApiInfoCard): CardInfo | null {
  if (!card.name) return null;
  const front = card.card_faces?.[0];
  const { src, back } = facesOf(card);
  return {
    name: card.name,
    manaCost: card.mana_cost ?? front?.mana_cost ?? '',
    cmc: card.cmc ?? 0,
    typeLine: card.type_line ?? front?.type_line ?? '',
    colors: byWubrg(card.colors ?? front?.colors ?? []),
    rarity: card.rarity ?? 'common',
    src,
    ...(back ? { back } : {}),
    ...(card.set ? { set: card.set } : {}),
    ...(card.collector_number ? { collector: card.collector_number } : {}),
  };
}

/** Lookup key of a card name: lowercase, front face only for `A // B`. */
export function infoKey(name: string): string {
  return name.split(' // ')[0]!.trim().toLowerCase();
}
