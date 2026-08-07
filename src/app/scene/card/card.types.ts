/** World-object id prefix for cards on the table (see room.types.ts). */
export const CARD_PREFIX = 'card:';

export function newCardId(): string {
  return CARD_PREFIX + crypto.randomUUID();
}

/**
 * Persistent state of a card on the table (the design doc's "CardState"):
 * everything needed to respawn the card exactly — pose, facing, and its
 * related cards. Synced through RoomService world objects (id `card:<uuid>`);
 * CardStore projects it, Card components render it, CardInteractions mutates it.
 */
export interface CardState {
  id: string;
  /** Card name, shown in history lines ("added Water Worm"). */
  name: string;
  /** Image shown on the card's front face. */
  src: string;
  /**
   * Image of the *second* face of a double-faced card (mdfcs.md) — absent on an
   * ordinary card, which is exactly what marks a card as double-faced. Its two
   * face names are the halves of `name` ("Front // Back"), the way the card data
   * spells a two-sided card.
   */
  backSrc?: string;
  /** True while a double-faced card is showing its second face. */
  flipped?: boolean;
  /** World position of the card's origin. */
  position: [number, number, number];
  /** Rotation around the world up-axis, radians ("rotate" adds π). */
  yaw: number;
  faceUp: boolean;
  /** Tapped (turned a quarter turn, rendered on top of yaw). Toggled by clicking. */
  tapped: boolean;
  /**
   * Names of this card's related cards (tokens it creates, meld results, …)
   * from the card data's all_parts; the "related" menu resolves them to images
   * via the card database.
   */
  relatedNames: string[];
  /**
   * Auth uid of the player who put the card onto the table — "untap all" only
   * touches your own cards. '' on cards from before this field existed.
   */
  ownerUid: string;
}

/** The face of a card that is currently showing — one of its two images. */
export function faceSrc(card: { src: string; backSrc?: string; flipped?: boolean }): string {
  return card.flipped && card.backSrc ? card.backSrc : card.src;
}

/**
 * The name of the face currently showing. A double-faced card is named
 * "Front // Back" by the card data, so its faces are the two halves; every
 * other card (including a split card, which has one image and therefore no
 * `backSrc`) keeps its whole name.
 */
export function faceName(card: { name: string; backSrc?: string; flipped?: boolean }): string {
  if (!card.backSrc) return card.name;
  const [front, back] = card.name.split(' // ');
  return (card.flipped ? back : front) ?? card.name;
}

/** Actions offered by the card context menu and hotkeys. */
export type CardAction =
  | 'view'
  | 'tap'
  | 'rotate'
  | 'flip'
  /** Turn a double-faced card over (menu only — for other cards `flip` is this). */
  | 'turnOver'
  | 'related'
  | 'duplicate'
  | 'toHand'
  | 'toDeck'
  | 'toGrave'
  | 'toExile'
  | 'delete';

/**
 * Actions that apply to a whole selection when the clicked card is part of one
 * (cardselection.md). Everything else drops the selection and acts on the one
 * card that was clicked.
 */
export const GROUP_ACTIONS: readonly CardAction[] = ['tap', 'related', 'duplicate', 'delete'];
