/** World-object id prefix for table items — dice, coins and counters. */
export const ITEM_PREFIX = 'item:';

export function newItemId(): string {
  return ITEM_PREFIX + crypto.randomUUID();
}

export function isItemId(id: string): boolean {
  return id.startsWith(ITEM_PREFIX);
}

export type DiceKind = 'd4' | 'd6' | 'd12' | 'd20';
export const DICE_KINDS: readonly DiceKind[] = ['d4', 'd6', 'd12', 'd20'];

/** Faces per die — the range a roll picks from. */
export const DIE_FACES: Readonly<Record<DiceKind, number>> = { d4: 4, d6: 6, d12: 12, d20: 20 };

export type ItemKind = DiceKind | 'coin' | 'counter';

/** A counter is either a +1/+1 or a −1/−1 (its value scales the number shown). */
export type CounterVariant = 'plus' | 'minus';

/**
 * Actions offered by an item's right-click menu. Counters have no menu — they
 * change value on click and are removed with the delete hotkey while hovered.
 */
export type ItemAction = 'roll' | 'flip' | 'delete';

export function isDice(kind: ItemKind): kind is DiceKind {
  return kind !== 'coin' && kind !== 'counter';
}

/**
 * Persistent state of a table item (world object `item:<uuid>`), synced exactly
 * like a card: whole-object last-writer-wins through RoomService. ItemStore
 * projects it, the `Item` component renders it, CardInteractions moves it.
 *
 * `rotation` is **absolute and unwrapped** — a roll adds whole turns rather
 * than normalising to 0…2π — so an animation always has somewhere to travel and
 * every player replays the same tumble by lerping from where they were to it.
 */
export interface ItemState {
  id: string;
  kind: ItemKind;
  /**
   * World position of the item, except for a counter attached to a card, where
   * it is the offset from that card's origin (so the counter rides along).
   */
  position: [number, number, number];
  /** Euler angles (radians, XYZ) the item settles at; animations lerp toward it. */
  rotation: [number, number, number];
  /**
   * Dice: the face that came up. Coin: 1 = heads, 0 = tails. Counter: how many
   * (+value/+value), always ≥ 1.
   */
  value: number;
  /** Counter flavour; ignored by dice and coins. */
  variant: CounterVariant;
  /** Card world-id this counter is attached to, or null when it lies on the table. */
  attachedTo: string | null;
}

/** A fresh item of the given kind, resting unrotated at a table position. */
export function newItem(
  kind: ItemKind,
  position: [number, number, number],
  variant: CounterVariant = 'plus',
): ItemState {
  return {
    id: newItemId(),
    kind,
    position,
    rotation: [0, 0, 0],
    value: 1,
    variant,
    attachedTo: null,
  };
}

/** Human-readable name for history lines ("rolled a 14 on a d20"). */
export function itemLabel(state: Pick<ItemState, 'kind' | 'variant'>): string {
  if (state.kind === 'counter')
    return state.variant === 'minus' ? '−1/−1 counter' : '+1/+1 counter';
  if (state.kind === 'coin') return 'coin';
  return state.kind;
}

/** Text a counter shows on its face, e.g. "+2/+2". */
export function counterLabel(value: number, variant: CounterVariant): string {
  const sign = variant === 'minus' ? '−' : '+';
  return `${sign}${value}/${sign}${value}`;
}
