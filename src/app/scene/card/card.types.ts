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

/** Actions offered by the card context menu and hotkeys. */
export type CardAction =
  | 'view'
  | 'tap'
  | 'rotate'
  | 'flip'
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
