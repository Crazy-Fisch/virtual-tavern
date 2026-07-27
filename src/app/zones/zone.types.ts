/** World-object id prefix for player zones (see room.types.ts). */
export const ZONE_PREFIX = 'zone:';

export type ZoneKind = 'hand' | 'deck' | 'graveyard' | 'exile';
export const ZONE_KINDS: readonly ZoneKind[] = ['hand', 'deck', 'graveyard', 'exile'];

/** Zones whose contents everyone may look through (the closed ones are hand/deck). */
export const OPEN_ZONES: readonly ZoneKind[] = ['graveyard', 'exile'];

export type OpenZoneKind = 'graveyard' | 'exile';

export function zoneId(uid: string, kind: ZoneKind): string {
  return `${ZONE_PREFIX}${uid}:${kind}`;
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
};
