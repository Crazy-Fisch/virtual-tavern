import { computed, signal } from '@angular/core';
import { HISTORY_START_ID, MAX_UNDO, WorldObjectData, WorldState } from '../room.types';

/**
 * In-memory RoomService stand-in for specs (mocking at the service seam, per
 * convention): world writes apply synchronously with a monotonic clock, and
 * action-history lines are recorded for assertion. Provide it with
 * `{ provide: RoomService, useValue: new FakeRoomService() }`.
 *
 * The undo journal mirrors RoomService's (every write's pre-image is stored with
 * the next action line; `undoTo` folds them newest to oldest) but keeps its
 * entries out of `worldState`, so specs that inspect the world stay unchanged.
 */
export class FakeRoomService {
  private readonly _world = signal<WorldState>({});
  readonly worldState = this._world.asReadonly();
  /** Action-history lines posted via sendAction, oldest first. */
  readonly actions: string[] = [];
  /** Message ids of `actions`, same order. */
  readonly actionIds: string[] = [];
  /** Object ids of each setWorldObjects batch, for asserting write atomicity. */
  readonly batches: string[][] = [];
  private clock = 1;
  private restoring = false;
  private readonly pending = new Map<string, WorldObjectData | null>();
  private readonly _entries = signal<
    { msg: string; before: Map<string, WorldObjectData | null> }[]
  >([]);

  readonly currentRoom = signal<{ id: string } | null>({ id: 'room-1' });
  readonly userId = signal<string | null>('user-1');
  readonly displayName = signal('Tim');
  readonly isRoomOwner = signal(true);
  /** Mirrors RoomService: π when seated opposite the room owner. */
  readonly seatYaw = () => (this.isRoomOwner() ? 0 : Math.PI);
  /** Action ids that can be undone (newest MAX_UNDO with an entry). */
  readonly undoable = computed<ReadonlySet<string>>(
    () =>
      new Set(
        this._entries()
          .map((e) => e.msg)
          .slice(-MAX_UNDO),
      ),
  );
  readonly undoneIds = signal<ReadonlySet<string>>(new Set());
  /** Mirrors RoomService: the history line after which undo points exist (null = none). */
  readonly historyStart = computed<{ msgId: string; t: number } | null>(() => {
    const data = this._world()[HISTORY_START_ID]?.data;
    return data ? { msgId: data['msgId'] as string, t: data['t'] as number } : null;
  });

  setWorldObject(id: string, data: WorldObjectData): void {
    this.setWorldObjects([[id, data]]);
  }

  setWorldObjects(entries: ReadonlyArray<readonly [string, WorldObjectData]>): void {
    this.batches.push(entries.map(([id]) => id));
    const by = this.userId() ?? '';
    this.journal(entries.map(([id]) => id));
    for (const [id, data] of entries) {
      this._world.update((w) => ({ ...w, [id]: { data, by, t: this.clock++ } }));
    }
  }

  removeWorldObject(id: string): void {
    this.removeWorldObjects([id]);
  }

  removeWorldObjects(ids: readonly string[]): void {
    const gone = new Set(ids);
    this.journal(ids);
    this._world.update((w) =>
      Object.fromEntries(Object.entries(w).filter(([id]) => !gone.has(id))),
    );
  }

  sendAction(text: string): string {
    const id = `action-${this.actions.length + 1}`;
    this.actions.push(text);
    this.actionIds.push(id);
    const before = new Map(this.pending);
    this.pending.clear();
    this._entries.update((e) => [...e, { msg: id, before }].slice(-MAX_UNDO));
    return id;
  }

  /** History barrier: drops every undo point and mark; later quiet writes of older lines are ignored. */
  resetHistory(messageId: string): void {
    this.pending.clear();
    this._entries.set([]);
    this.undoneIds.set(new Set());
    this.setWorldObject(HISTORY_START_ID, { msgId: messageId, t: this.clock });
  }

  /** Run writes that must not become undo points. */
  withoutJournal(write: () => void): void {
    const was = this.restoring;
    this.restoring = true;
    try {
      write();
    } finally {
      this.restoring = was;
    }
  }

  /** Reset the world to just before action `messageId`; returns how many actions were undone. */
  undoTo(messageId: string): number {
    this.attachQuietWrites();
    const at = this._entries().findIndex((e) => e.msg === messageId);
    if (at < 0) return 0;
    const entries = this._entries().slice(at);
    const restore = new Map<string, WorldObjectData | null>();
    for (const e of [...entries].reverse())
      for (const [id, data] of e.before) restore.set(id, data);
    this.restoring = true;
    try {
      const sets = [...restore].filter(([, d]) => d).map(([id, d]) => [id, d!] as const);
      if (sets.length) this.setWorldObjects(sets);
      this.removeWorldObjects([...restore].filter(([, d]) => !d).map(([id]) => id));
    } finally {
      this.restoring = false;
    }
    this._entries.update((e) => e.slice(0, at));
    this.undoneIds.update(
      (s) => new Set([...s, ...this.actionIds.slice(this.actionIds.indexOf(messageId))]),
    );
    const n = entries.length;
    this.actions.push(`undid ${n} action${n === 1 ? '' : 's'}`);
    this.actionIds.push(`action-${this.actions.length}`);
    return n;
  }

  sendChat(_text: string): void {}

  /** Quiet writes belong to the latest action line (RoomService does this after a short delay). */
  private attachQuietWrites(): void {
    const last = this._entries().at(-1);
    if (!last && this.historyStart()) this.pending.clear();
    if (!last || this.pending.size === 0) return;
    for (const [id, data] of this.pending) if (!last.before.has(id)) last.before.set(id, data);
    this.pending.clear();
  }

  private journal(ids: readonly string[]): void {
    if (this.restoring) return;
    for (const id of ids) {
      if (id === HISTORY_START_ID) continue;
      if (!this.pending.has(id)) this.pending.set(id, this._world()[id]?.data ?? null);
    }
  }
}
