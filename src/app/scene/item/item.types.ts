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

/**
 * Colours a die can be cast in (newmechanics.md). Stored on the item so every
 * player sees the same one; the palette itself lives in `item-geometry.ts`.
 */
export type ItemColor = 'green' | 'blue' | 'red' | 'yellow';
export const ITEM_COLORS: readonly ItemColor[] = ['green', 'blue', 'red', 'yellow'];
export const DEFAULT_ITEM_COLOR: ItemColor = 'red';

export function isItemColor(value: unknown): value is ItemColor {
  return typeof value === 'string' && (ITEM_COLORS as readonly string[]).includes(value);
}

/**
 * Counter flavours: +1/+1, −1/−1, and the plain multiplier counter that just
 * shows "2x" (newmechanics.md). The multiplier is the odd one out visually —
 * it gets a squared body rather than the disc the ±1/±1 counters wear.
 */
export type CounterVariant = 'plus' | 'minus' | 'x';
export const COUNTER_VARIANTS: readonly CounterVariant[] = ['plus', 'minus', 'x'];

export function isCounterVariant(value: unknown): value is CounterVariant {
  return typeof value === 'string' && (COUNTER_VARIANTS as readonly string[]).includes(value);
}

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
  /** Die colour; ignored by coins and counters, which have their own looks. */
  color: ItemColor;
  /** Card world-id this counter is attached to, or null when it lies on the table. */
  attachedTo: string | null;
}

/** How a fresh item differs from the defaults (counter flavour, die colour). */
export interface NewItemOptions {
  variant?: CounterVariant;
  color?: ItemColor;
}

/** A fresh item of the given kind, resting unrotated at a table position. */
export function newItem(
  kind: ItemKind,
  position: [number, number, number],
  options: NewItemOptions = {},
): ItemState {
  return {
    id: newItemId(),
    kind,
    position,
    rotation: [0, 0, 0],
    value: 1,
    variant: options.variant ?? 'plus',
    color: options.color ?? DEFAULT_ITEM_COLOR,
    attachedTo: null,
  };
}

/** Human-readable name for history lines ("rolled a 14 on a d20"). */
export function itemLabel(state: Pick<ItemState, 'kind' | 'variant'>): string {
  if (state.kind === 'counter')
    return state.variant === 'x' ? 'x counter' : `${counterLabel(1, state.variant)} counter`;
  if (state.kind === 'coin') return 'coin';
  return state.kind;
}

/** Text a counter shows on its face, e.g. "+2/+2" or "2x". */
export function counterLabel(value: number, variant: CounterVariant): string {
  if (variant === 'x') return `${value}x`;
  const sign = variant === 'minus' ? '−' : '+';
  return `${sign}${value}/${sign}${value}`;
}
