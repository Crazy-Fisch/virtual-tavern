import { Injectable, computed, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { P2pService } from '../p2p/p2p.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  ChatKind,
  ChatMessage,
  RoomInfo,
  WorldObjectData,
  WorldObjectState,
  WorldState,
} from './room.types';

const MAX_CHAT = 100;
/** localStorage key holding the room to rejoin after a reload without an explicit Leave. */
const RESUME_KEY = 'virtual-tavern.resume';

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
    this.send(text, 'action');
  }

  /** Upsert a shared world object; the DB trigger stamps the authoritative timestamp. */
  setWorldObject(id: string, data: WorldObjectData): void {
    const room = this._currentRoom();
    const by = this.supabase.userId();
    if (!room || !by) return;
    this.applyState(id, { data, by, t: Date.now() }); // optimistic; corrected by our own echo
    void this.supabase.client
      .from('world_objects')
      .upsert({ room_id: room.id, object_id: id, data, updated_by: by })
      .then(() => undefined);
  }

  /** Delete a shared world object (e.g. a card leaving the table). */
  removeWorldObject(id: string): void {
    const room = this._currentRoom();
    if (!room) return;
    const prev = this._world()[id];
    this._world.update((w) => {
      const { [id]: _, ...rest } = w;
      return rest;
    });
    void this.supabase.client
      .from('world_objects')
      .delete()
      .match({ room_id: room.id, object_id: id })
      .then(({ error }) => {
        // Restore on failure unless something newer arrived meanwhile.
        if (error && prev && !this._world()[id]) this.applyState(id, prev);
      });
  }

  leave(): void {
    localStorage.removeItem(RESUME_KEY);
    if (this.channel) {
      void this.supabase.client.removeChannel(this.channel);
      this.channel = undefined;
    }
    this.p2p.leave();
    this._currentRoom.set(null);
    this._messages.set([]);
    this._world.set({});
  }

  private send(text: string, kind: ChatKind): void {
    const trimmed = text.trim();
    const room = this._currentRoom();
    const from = this.supabase.userId();
    if (!trimmed || !room || !from) return;
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

    this.channel = client
      .channel(`room-${room.id}`)
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
      )
      .subscribe();

    this.p2p.join(room.id, name);
    this._currentRoom.set(room);
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
      this._world.update((w) => {
        if (!(old.object_id! in w)) return w;
        const { [old.object_id!]: _, ...rest } = w;
        return rest;
      });
      return;
    }
    const row = change.new;
    if (!row.object_id) return;
    // Our own echo is adopted unconditionally so the server clock replaces the optimistic local one.
    this.applyState(
      row.object_id,
      toObjectState(row as WorldRow),
      row.updated_by === this.supabase.userId(),
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
