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
  /** ids of other cards in the store shown by the "related" menu option. */
  relatedIds: string[];
}

/** Actions offered by the card context menu and hotkeys. */
export type CardAction =
  | 'view'
  | 'rotate'
  | 'flip'
  | 'related'
  | 'toHand'
  | 'toDeck'
  | 'toGrave'
  | 'delete';
