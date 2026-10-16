/** World-object id prefix for player zones (see room.types.ts). */
export const ZONE_PREFIX = 'zone:';
/** World-object id prefix for a player's life total (`life:<uid>`, data `{ life }`). */
export const LIFE_PREFIX = 'life:';

/** World-object id of the room's round marker (data `{ n, startedBy }`); a higher `n` resets every player. */
export const ROUND_ID = 'round:current';

export type ZoneKind = 'hand' | 'deck' | 'graveyard' | 'exile';
export const ZONE_KINDS: readonly ZoneKind[] = ['hand', 'deck', 'graveyard', 'exile'];

/** Zones whose contents everyone may look through (the closed ones are hand/deck). */
export const OPEN_ZONES: readonly ZoneKind[] = ['graveyard', 'exile'];

export type OpenZoneKind = 'graveyard' | 'exile';

export function zoneId(uid: string, kind: ZoneKind): string {
  return `${ZONE_PREFIX}${uid}:${kind}`;
}

export function lifeId(uid: string): string {
  return `${LIFE_PREFIX}${uid}`;
}

/**
 * A card at rest inside a zone — no pose; it gets one (and a fresh `card:`
 * world id) when played onto the table. Zone contents are shared world state,
 * so every player knows each zone's size; the UI decides what is visible:
 * hands and decks are closed (others see counts only), graveyards and exile
 * are open.
 */
export type ZoneCard = {
  id: string;
  name: string;
  src: string;
  /**
   * Only meaningful for hand cards: while true the card's face is shown to
   * everyone (others see the back otherwise). Absent = hidden; only ever
   * stored when true, so a plain card round-trips unchanged.
   */
  revealed?: boolean;
};

/** All zones of one player, grouped from their `zone:<uid>:<kind>` objects. */
export type PlayerZones = {
  /** Supabase auth uid (same id space as chat). */
  uid: string;
  name: string;
  hand: ZoneCard[];
  /** Index 0 is the top of the deck. */
  deck: ZoneCard[];
  graveyard: ZoneCard[];
  exile: ZoneCard[];
  /** Life total (`life:<uid>` world object), or null until the player picks a starting total. */
  life: number | null;
};
