import { Injectable, computed, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { P2pService } from '../p2p/p2p.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  ChatKind,
  ChatMessage,
  MAX_UNDO,
  RoomInfo,
  UNDONE_ID,
  UNDO_PREFIX,
  WorldObjectData,
  WorldObjectState,
  WorldState,
} from './room.types';

const MAX_CHAT = 100;
/** localStorage key holding the room to rejoin after a reload without an explicit Leave. */
const RESUME_KEY = 'virtual-tavern.resume';
/** How often a joined client refreshes rooms.last_active (the keep-alive that
 * spares the room from the server-side stale sweep). */
const HEARTBEAT_MS = 5 * 60_000;

/** Journal debounce: silent writes (life, quiet returns) get their own entry after this idle time. */
const JOURNAL_FLUSH_MS = 2000;
/** An entry whose history line never showed up is dropped after this long. */
const ORPHAN_ENTRY_MS = 60_000;
const MAX_UNDONE_MARKS = 200;
const UNDID_LINE = /^undid \d+ actions?$/;

type JournalEntry = {
  id: string;
  msg: string;
  t: number;
  before: Record<string, WorldObjectData | null>;
};

type ResumeState = { code: string; displayName: string };

/** Row shapes as stored in Postgres (schema in supabase/schema.sql). */
type ChatRow = {
  id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  kind: ChatKind;
  created_at: string;
};
type WorldRow = {
  object_id: string;
  data: WorldObjectData;
  updated_by: string;
  updated_at: string;
};
/** Realtime change payload; DELETE carries the old row (replica identity full). */
type WorldChange = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Partial<WorldRow>;
  old: Partial<WorldRow & { room_id: string }>;
};

function toMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    from: row.sender_id,
    name: row.sender_name,
    text: row.text,
    kind: row.kind ?? 'chat',
    t: Date.parse(row.created_at),
  };
}

function toObjectState(row: WorldRow): WorldObjectState {
  return { data: row.data, by: row.updated_by, t: Date.parse(row.updated_at) };
}

/**
 * Rooms, chat, and shared world state, backed by Supabase (Postgres + realtime).
 * Orchestrates joining: resolves the room, loads persisted history, subscribes to
 * changes, then brings up the WebRTC position layer (P2pService) keyed by the
 * room's UUID — which is only obtainable via the join-code RPC.
 */
@Injectable({ providedIn: 'root' })
export class RoomService {
  private readonly supabase = inject(SupabaseService);
  private readonly p2p = inject(P2pService);

  private readonly _currentRoom = signal<RoomInfo | null>(null);
  private readonly _messages = signal<ChatMessage[]>([]);
  private readonly _world = signal<WorldState>({});
  private channel?: RealtimeChannel;
  /** This tab's realtime presence key; per-tab so two tabs of one account count twice. */
  private presenceKey?: string;
  /** Keep-alive timer stamping rooms.last_active while joined. */
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Count of in-flight world writes (upserts/deletes) per object id. */
  private readonly pendingWrites = new Map<string, number>();
  /** World mutations dispatch in order — a later request can never overtake an
   * earlier one and scramble the end state (e.g. two quick draws). */
  private writeChain: Promise<void> = Promise.resolve();
  /** Pre-images (data before my first write, null = absent) not yet stored in an undo entry. */
  private readonly pending = new Map<string, WorldObjectData | null>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  /** True while undoTo writes the restored state, so the restore is not journaled itself. */
  private restoring = false;

  readonly currentRoom = this._currentRoom.asReadonly();
  readonly joined = computed(() => this._currentRoom() !== null);
  readonly messages = this._messages.asReadonly();
  readonly worldState = this._world.asReadonly();
  /** Auth uid of the local user (chat identity). */
  readonly userId = computed(() => this.supabase.userId());
  /** Display name used for chat and action-history lines. */
  readonly displayName = computed(() => this.supabase.displayName() || 'guest');
  /**
   * Whether I created this room. The owner keeps the near table side; other
   * players view from (and orient their cards toward) the opposite end.
   * Defaults to true when unknown (no room, or a pre-migration join RPC).
   */
  readonly isRoomOwner = computed(() => {
    const room = this._currentRoom();
    return !room || !room.ownerId || room.ownerId === this.supabase.userId();
  });
  /** Yaw giving cards I spawn their upright orientation for my table side. */
  readonly seatYaw = computed(() => (this.isRoomOwner() ? 0 : Math.PI));

  private readonly messageIndex = computed(
    () => new Map(this._messages().map((m, i) => [m.id, i] as const)),
  );
  /** Ids of history lines the game can be reset to (their undo entry exists); the newest MAX_UNDO only. */
  readonly undoable = computed<ReadonlySet<string>>(() => {
    const index = this.messageIndex();
    const msgs = new Set<string>();
    for (const e of this.journalEntries()) if (index.has(e.msg)) msgs.add(e.msg);
    const ordered = [...msgs].sort((a, b) => index.get(a)! - index.get(b)!);
    return new Set(ordered.slice(-MAX_UNDO));
  });
  /** Ids of history lines that were undone (they stay in the log, greyed out). */
  readonly undoneIds = computed<ReadonlySet<string>>(() => {
    const ids = this._world()[UNDONE_ID]?.data['ids'];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  });

  /** Create an owned room (share code generated server-side) and enter it. Returns an error message or null. */
  async createRoom(roomName: string, displayName: string): Promise<string | null> {
    const ownerId = this.supabase.userId();
    if (!ownerId) return 'Not signed in';
    const name = roomName.trim();
    if (name.length < 3) return 'Room name needs at least 3 characters';
    const { data, error } = await this.supabase.client
      .from('rooms')
      .insert({ owner_id: ownerId, name })
      .select('id, code, name')
      .single();
    if (error || !data) return error?.message ?? 'Could not create room';
    return this.enterRoom({ id: data.id, code: data.code, name: data.name, ownerId }, displayName);
  }

  /** Join an existing room by its share code. Returns an error message or null. */
  async joinByCode(code: string, displayName: string): Promise<string | null> {
    const { data, error } = await this.supabase.client.rpc('get_room_by_code', { p_code: code });
    if (error) return error.message;
    const row = (
      data as
        | { room_id: string; room_code: string; room_name: string | null; room_owner?: string }[]
        | null
    )?.[0];
    if (!row) return 'Room not found';
    return this.enterRoom(
      {
        id: row.room_id,
        code: row.room_code,
        name: row.room_name,
        ownerId: row.room_owner ?? null,
      },
      displayName,
    );
  }

  /**
   * Rejoin the room from before a page reload (only stored while in a room;
   * an explicit leave() clears it). Returns true if a room is (now) joined.
   */
  async resume(): Promise<boolean> {
    if (this.joined()) return true;
    if (!this.supabase.userId()) return false;
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return false;
    try {
      const saved = JSON.parse(raw) as ResumeState;
      if (!saved.code) return false;
      // Re-resolve via the code RPC: validates the room still exists and refreshes its data.
      return (await this.joinByCode(saved.code, saved.displayName ?? '')) === null;
    } catch {
      localStorage.removeItem(RESUME_KEY); // corrupt state — discard
      return false;
    }
  }

  sendChat(text: string): void {
    this.send(text, 'chat');
  }

  /**
   * Post a game-history line ("<displayName>: <text>") visible to everyone.
   * Callers phrase `text` as a verb phrase, e.g. "added Water Worm".
   */
  sendAction(text: string): void {
    const id = this.send(text, 'action');
    if (id) this.writeEntry(`${UNDO_PREFIX}${id}`, id);
  }

  /**
   * Reset the shared game to the moment just before the history line `messageId`:
   * every undo entry of that line and newer ones is folded newest to oldest (the
   * oldest pre-image wins per object), applied in ONE upsert plus ONE delete that
   * are not journaled themselves, and the consumed entries are deleted. The undone
   * lines stay (chat_messages has no delete policy) and are marked in `undoneIds`.
   * Returns the number of actions undone (0 when the line is not undoable).
   */
  undoTo(messageId: string): number {
    const room = this._currentRoom();
    if (!room || !this.supabase.userId()) return 0;
    this.flushQuiet();
    if (!this.undoable().has(messageId)) return 0;
    const index = this.messageIndex();
    const target = index.get(messageId)!;
    const entries = this.journalEntries()
      .filter((e) => (index.get(e.msg) ?? -1) >= target)
      .sort((a, b) => index.get(a.msg)! - index.get(b.msg)! || a.t - b.t);
    const restore = new Map<string, WorldObjectData | null>();
    for (let i = entries.length - 1; i >= 0; i--) {
      for (const [id, data] of Object.entries(entries[i]!.before)) {
        if (!id.startsWith(UNDO_PREFIX) && id !== UNDONE_ID) restore.set(id, data);
      }
    }
    const marks = this._messages()
      .slice(target)
      .filter((m) => m.kind === 'action' && !UNDID_LINE.test(m.text))
      .map((m) => m.id);
    const undone = [...this.undoneIds(), ...marks].slice(-MAX_UNDONE_MARKS);
    const upserts: [string, WorldObjectData][] = [[UNDONE_ID, { ids: undone }]];
    const removals = entries.map((e) => e.id);
    for (const [id, data] of restore) {
      if (data) upserts.push([id, data]);
      else removals.push(id);
    }
    this.restoring = true;
    try {
      this.setWorldObjects(upserts);
      this.removeWorldObjects(removals);
    } finally {
      this.restoring = false;
    }
    const n = new Set(entries.map((e) => e.msg)).size;
    this.send(`undid ${n} action${n === 1 ? '' : 's'}`, 'action');
    return n;
  }

  /** Upsert a shared world object; the DB trigger stamps the authoritative timestamp. */
  setWorldObject(id: string, data: WorldObjectData): void {
    this.setWorldObjects([[id, data]]);
  }

  /**
   * Upsert several world objects in ONE request — PostgREST wraps it in one
   * transaction, so a multi-object move (a draw's deck+hand pair) can never
   * half-apply when the network fails mid-way. All entries apply optimistically
   * at once; the response rows carry the trigger-stamped `updated_at`, which
   * replaces the optimistic local clock (healing client clock skew without
   * waiting for the realtime echo), and a failed request re-reads the rows so
   * local state snaps back to the database instead of silently diverging.
   */
  setWorldObjects(entries: ReadonlyArray<readonly [string, WorldObjectData]>): void {
    const room = this._currentRoom();
    const by = this.supabase.userId();
    if (!room || !by || entries.length === 0) return;
    this.journal(entries.map(([id]) => id));
    for (const [id, data] of entries) {
      this.beginWrite(id);
      // Force: the user's own action must show locally even if a skewed clock
      // says an older remote write is "newer".
      this.applyState(id, { data, by, t: Date.now() }, true);
    }
    const ids = entries.map(([id]) => id);
    const rows = entries.map(([object_id, data]) => ({
      room_id: room.id,
      object_id,
      data,
      updated_by: by,
    }));
    this.enqueue(async () => {
      let res: { data: unknown; error: unknown };
      try {
        res = await this.supabase.client
          .from('world_objects')
          .upsert(rows)
          .select('object_id, data, updated_by, updated_at');
      } finally {
        for (const id of ids) this.endWrite(id);
      }
      if (this._currentRoom()?.id !== room.id) return; // left the room meanwhile
      if (res.error) {
        await this.resyncObjects(room.id, ids);
        return;
      }
      // Adopt the authoritative rows — unless a newer write for the same
      // object is already in flight behind this one; its ack will land later.
      for (const row of (res.data ?? []) as WorldRow[]) {
        if (!this.pendingWrites.has(row.object_id)) {
          this.applyState(row.object_id, toObjectState(row), true);
        }
      }
    });
  }

  /** Delete a shared world object (e.g. a card leaving the table). */
  removeWorldObject(id: string): void {
    const room = this._currentRoom();
    if (!room) return;
    this.journal([id]);
    this.beginWrite(id);
    this._world.update((w) => {
      const { [id]: _, ...rest } = w;
      return rest;
    });
    this.enqueue(async () => {
      let error: unknown;
      try {
        ({ error } = await this.supabase.client
          .from('world_objects')
          .delete()
          .match({ room_id: room.id, object_id: id }));
      } finally {
        this.endWrite(id);
      }
      if (error && this._currentRoom()?.id === room.id) {
        await this.resyncObjects(room.id, [id]);
      }
    });
  }

  /** Delete several shared world objects in ONE request (a new round clearing the table). */
  removeWorldObjects(ids: readonly string[]): void {
    const room = this._currentRoom();
    if (!room || ids.length === 0) return;
    const gone = new Set(ids);
    this.journal(gone);
    for (const id of gone) this.beginWrite(id);
    this._world.update((w) =>
      Object.fromEntries(Object.entries(w).filter(([id]) => !gone.has(id))),
    );
    this.enqueue(async () => {
      let error: unknown;
      try {
        ({ error } = await this.supabase.client
          .from('world_objects')
          .delete()
          .eq('room_id', room.id)
          .in('object_id', [...gone]));
      } finally {
        for (const id of gone) this.endWrite(id);
      }
      if (error && this._currentRoom()?.id === room.id) {
        await this.resyncObjects(room.id, [...gone]);
      }
    });
  }

  /** Remember the state of each object before my first write in this journal batch. */
  private journal(ids: Iterable<string>): void {
    if (this.restoring || !this._currentRoom()) return;
    const world = this._world();
    let added = false;
    for (const id of ids) {
      if (id.startsWith(UNDO_PREFIX) || id === UNDONE_ID || this.pending.has(id)) continue;
      this.pending.set(id, world[id]?.data ?? null);
      added = true;
    }
    if (added && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => this.flushQuiet(), JOURNAL_FLUSH_MS);
    }
  }

  /** Writes with no history line of their own go to an extra entry of the latest action line. */
  private flushQuiet(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pending.size === 0) return;
    const anchor = this._messages().filter((m) => m.kind === 'action').at(-1);
    // No action line yet: stay pending, the next sendAction stores them.
    if (!anchor) return;
    const uid = (this.supabase.userId() ?? '').slice(0, 8);
    this.writeEntry(`${UNDO_PREFIX}${anchor.id}~${uid}${Date.now().toString(36)}`, anchor.id);
  }

  /** Store the pending pre-images as undo entry `entryId` of history line `msg`, then prune. */
  private writeEntry(entryId: string, msg: string): void {
    const by = this.supabase.userId();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!by) return;
    const before = Object.fromEntries(this.pending);
    this.pending.clear();
    this.setWorldObject(entryId, { msg, t: Date.now(), by, before });
    this.prune();
  }

  private journalEntries(): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const [id, st] of Object.entries(this._world())) {
      if (!id.startsWith(UNDO_PREFIX)) continue;
      const { msg, t, before } = st.data;
      if (typeof msg !== 'string' || typeof t !== 'number') continue;
      if (typeof before !== 'object' || before === null) continue;
      out.push({ id, msg, t, before: before as JournalEntry['before'] });
    }
    return out;
  }

  /** Keep the entries of the newest MAX_UNDO action lines; any client may prune. */
  private prune(): void {
    const index = this.messageIndex();
    const now = Date.now();
    const drop: string[] = [];
    const byMsg = new Map<string, string[]>();
    for (const e of this.journalEntries()) {
      if (!index.has(e.msg)) {
        // The history line may just not have arrived yet; only old orphans go.
        if (now - e.t > ORPHAN_ENTRY_MS) drop.push(e.id);
        continue;
      }
      byMsg.set(e.msg, [...(byMsg.get(e.msg) ?? []), e.id]);
    }
    const ordered = [...byMsg.keys()].sort((a, b) => index.get(a)! - index.get(b)!);
    for (const msg of ordered.slice(0, Math.max(0, ordered.length - MAX_UNDO))) {
      drop.push(...byMsg.get(msg)!);
    }
    this.removeWorldObjects(drop);
  }

  private beginWrite(id: string): void {
    this.pendingWrites.set(id, (this.pendingWrites.get(id) ?? 0) + 1);
  }

  private endWrite(id: string): void {
    const n = this.pendingWrites.get(id) ?? 0;
    if (n <= 1) this.pendingWrites.delete(id);
    else this.pendingWrites.set(id, n - 1);
  }

  /** Append a world mutation to the ordered dispatch chain. */
  private enqueue(work: () => Promise<void>): void {
    this.writeChain = this.writeChain
      .then(work)
      .catch((err) => console.warn('[room] world write failed', err));
  }

  /**
   * A world write failed: rather than guessing at a rollback, re-read the
   * objects and adopt whatever the database holds (rows may exist with older
   * data, or not at all). A lost request then shows up as the action visibly
   * undone — a drawn card back on the deck — never as a card silently gone.
   */
  private async resyncObjects(roomId: string, ids: string[]): Promise<void> {
    const { data, error } = await this.supabase.client
      .from('world_objects')
      .select('object_id, data, updated_by, updated_at')
      .eq('room_id', roomId)
      .in('object_id', ids);
    if (error || this._currentRoom()?.id !== roomId) return; // offline — keep optimistic state
    const rows = (data ?? []) as WorldRow[];
    const present = new Set(rows.map((r) => r.object_id));
    for (const row of rows) {
      if (!this.pendingWrites.has(row.object_id)) {
        this.applyState(row.object_id, toObjectState(row), true);
      }
    }
    for (const id of ids) {
      if (present.has(id) || this.pendingWrites.has(id)) continue;
      this._world.update((w) => {
        if (!(id in w)) return w;
        const { [id]: _, ...rest } = w;
        return rest;
      });
    }
  }

  leave(): void {
    localStorage.removeItem(RESUME_KEY);
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    const room = this._currentRoom();
    // Decide before the channel goes down whether anyone else is still here.
    const lastOut = room !== null && this.aloneInRoom();
    if (this.channel) {
      void this.supabase.client.removeChannel(this.channel);
      this.channel = undefined;
    }
    this.presenceKey = undefined;
    this.p2p.leave();
    this._currentRoom.set(null);
    this._messages.set([]);
    this._world.set({});
    this.pendingWrites.clear();
    this.pending.clear();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    // The last player out closes the room: the row and — via the FK cascades —
    // all its chat/history messages and world objects leave the database.
    if (lastOut && room) void this.rpcQuiet('close_room', { p_room_id: room.id });
  }

  /**
   * Whether realtime presence shows this tab as the only player on the room
   * channel. Presence must have synced (my own key visible) — an unsynced or
   * dead channel reports "not alone", leaving the room to the server-side
   * stale sweep instead of guessing.
   */
  private aloneInRoom(): boolean {
    if (!this.channel || !this.presenceKey) return false;
    const keys = Object.keys(this.channel.presenceState());
    return keys.length === 1 && keys[0] === this.presenceKey;
  }

  /** Fire an RPC whose result (and failure — e.g. offline) is irrelevant. */
  private rpcQuiet(fn: string, args?: Record<string, unknown>): Promise<void> {
    return Promise.resolve(this.supabase.client.rpc(fn, args)).then(
      () => undefined,
      () => undefined,
    );
  }

  private send(text: string, kind: ChatKind): string | null {
    const trimmed = text.trim();
    const room = this._currentRoom();
    const from = this.supabase.userId();
    if (!trimmed || !room || !from) return null;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from,
      name: this.displayName(),
      text: trimmed,
      kind,
      t: Date.now(),
    };
    // Optimistic append; the realtime echo is deduped by id, a failed insert rolls it back.
    this._messages.update((m) => [...m, msg].slice(-MAX_CHAT));
    void this.supabase.client
      .from('chat_messages')
      .insert({ id: msg.id, room_id: room.id, sender_name: msg.name, text: msg.text, kind })
      .then(({ error }) => {
        if (error) this._messages.update((m) => m.filter((x) => x.id !== msg.id));
      });
    return msg.id;
  }

  private async enterRoom(room: RoomInfo, displayName: string): Promise<string | null> {
    this.leave();
    const name = displayName.trim().slice(0, 16) || 'guest';
    await this.supabase.setDisplayName(name);

    const client = this.supabase.client;
    const [chatRes, worldRes] = await Promise.all([
      client
        .from('chat_messages')
        .select('id, sender_id, sender_name, text, kind, created_at')
        .eq('room_id', room.id)
        .order('created_at', { ascending: false })
        .limit(MAX_CHAT),
      client
        .from('world_objects')
        .select('object_id, data, updated_by, updated_at')
        .eq('room_id', room.id),
    ]);
    if (chatRes.error) return chatRes.error.message;
    if (worldRes.error) return worldRes.error.message;

    this._messages.set(((chatRes.data ?? []) as ChatRow[]).reverse().map(toMessage));
    const world: WorldState = {};
    for (const row of (worldRes.data ?? []) as WorldRow[])
      world[row.object_id] = toObjectState(row);
    this._world.set(world);

    // Presence answers "am I the last one out?" when leaving. The key is
    // per-tab, so two tabs of the same account count as two players.
    this.presenceKey = crypto.randomUUID();
    const channel = client
      .channel(`room-${room.id}`, { config: { presence: { key: this.presenceKey } } })
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `room_id=eq.${room.id}`,
        },
        (payload) => this.onChatInsert(payload.new as ChatRow),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'world_objects', filter: `room_id=eq.${room.id}` },
        (payload) => this.onWorldChange(payload as unknown as WorldChange, room.id),
      );
    this.channel = channel;
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') void channel.track({ uid: this.supabase.userId() });
    });

    this.p2p.join(room.id, name);
    this._currentRoom.set(room);
    // The room is alive again: stamp it first (so the sweep can never hit the
    // room being joined), then opportunistically sweep rooms whose players
    // vanished without leaving, then keep stamping while we stay.
    void this.rpcQuiet('touch_room', { p_room_id: room.id }).then(() =>
      this.rpcQuiet('cleanup_stale_rooms'),
    );
    this.heartbeat = setInterval(
      () => void this.rpcQuiet('touch_room', { p_room_id: room.id }),
      HEARTBEAT_MS,
    );
    const resume: ResumeState = { code: room.code, displayName: name };
    localStorage.setItem(RESUME_KEY, JSON.stringify(resume));
    return null;
  }

  private onChatInsert(row: ChatRow): void {
    const msg = toMessage(row);
    this._messages.update((m) =>
      m.some((x) => x.id === msg.id) ? m : [...m, msg].slice(-MAX_CHAT),
    );
  }

  private onWorldChange(change: WorldChange, roomId: string): void {
    if (change.eventType === 'DELETE') {
      // The realtime filter does not apply to DELETE events, so ignore other rooms'.
      const old = change.old;
      if (!old.object_id || (old.room_id && old.room_id !== roomId)) return;
      // A newer local write for it is in flight (deleted then re-created); its ack decides.
      if (this.pendingWrites.has(old.object_id)) return;
      this._world.update((w) => {
        if (!(old.object_id! in w)) return w;
        const { [old.object_id!]: _, ...rest } = w;
        return rest;
      });
      return;
    }
    const row = change.new;
    if (!row.object_id) return;
    // Our own echo replaces the optimistic local clock with the server's — but
    // only when no newer write is in flight, whose optimistic state an older
    // echo must not clobber (that transient rollback lost drawn cards).
    const own = row.updated_by === this.supabase.userId();
    this.applyState(
      row.object_id,
      toObjectState(row as WorldRow),
      own && !this.pendingWrites.has(row.object_id),
    );
  }

  private applyState(id: string, state: WorldObjectState, force = false): void {
    this._world.update((w) => {
      const cur = w[id];
      if (!force && cur && cur.t >= state.t) return w; // older or equal write loses
      return { ...w, [id]: state };
    });
  }
}
