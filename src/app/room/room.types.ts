/** Backend-synced room shapes (persisted in Supabase; see RoomService). */

export type RoomInfo = {
  id: string;
  /** 6-char share code — what users type to join. */
  code: string;
  name: string | null;
  /**
   * Auth uid of the room creator — decides table seating (the owner keeps the
   * near side, everyone else sits opposite). Null when the join RPC predates
   * the 2026-07-19 migration; those clients all sit on the owner side.
   */
  ownerId: string | null;
};

/** 'chat' = typed by a user (rendered colored); 'action' = game history line (plain white). */
export type ChatKind = 'chat' | 'action';

export type ChatMessage = {
  id: string;
  /** Supabase auth uid of the sender (stable across sessions). */
  from: string;
  name: string;
  text: string;
  kind: ChatKind;
  /** Wall-clock timestamp (ms). */
  t: number;
};

/**
 * JSON payload persisted per world object. The object id's prefix says which
 * domain owns it and what shape `data` has: `card:` (CardStore), `item:`
 * (ItemStore), `zone:` and `life:` (ZoneStore). Unknown prefixes (e.g. `token:`
 * rows from removed features) are simply ignored. Domain stores parse defensively.
 */
export type WorldObjectData = Record<string, unknown>;

export type WorldObjectState = {
  data: WorldObjectData;
  /** Auth uid of the last writer. */
  by: string;
  /** Server timestamp (ms) used for last-writer-wins resolution. */
  t: number;
};

/** Undo journal entries: `undo:<messageId>` = `{msg, t, by, before: {objectId: data|null}}`. */
export const UNDO_PREFIX = 'undo:';
/** Message ids of history lines that were undone (greyed out): `{ids: string[]}`. */
export const UNDONE_ID = 'undone:state';
/** History barrier `{msgId, t}`: nothing at or before that history line can be undone. */
export const HISTORY_START_ID = 'history:start';
/** How many action lines stay undoable. */
export const MAX_UNDO = 50;

/** Map of shared world object id -> its state. */
export type WorldState = Record<string, WorldObjectState>;
