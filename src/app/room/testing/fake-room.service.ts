import { signal } from '@angular/core';
import { WorldObjectData, WorldState } from '../room.types';

/**
 * In-memory RoomService stand-in for specs (mocking at the service seam, per
 * convention): world writes apply synchronously with a monotonic clock, and
 * action-history lines are recorded for assertion. Provide it with
 * `{ provide: RoomService, useValue: new FakeRoomService() }`.
 */
export class FakeRoomService {
  private readonly _world = signal<WorldState>({});
  readonly worldState = this._world.asReadonly();
  /** Action-history lines posted via sendAction, oldest first. */
  readonly actions: string[] = [];
  /** Object ids of each setWorldObjects batch, for asserting write atomicity. */
  readonly batches: string[][] = [];
  private clock = 1;

  readonly currentRoom = signal<{ id: string } | null>({ id: 'room-1' });
  readonly userId = signal<string | null>('user-1');
  readonly displayName = signal('Tim');
  readonly isRoomOwner = signal(true);
  /** Mirrors RoomService: π when seated opposite the room owner. */
  readonly seatYaw = () => (this.isRoomOwner() ? 0 : Math.PI);

  setWorldObject(id: string, data: WorldObjectData): void {
    this.setWorldObjects([[id, data]]);
  }

  setWorldObjects(entries: ReadonlyArray<readonly [string, WorldObjectData]>): void {
    this.batches.push(entries.map(([id]) => id));
    const by = this.userId() ?? '';
    for (const [id, data] of entries) {
      this._world.update((w) => ({ ...w, [id]: { data, by, t: this.clock++ } }));
    }
  }

  removeWorldObject(id: string): void {
    this._world.update(({ [id]: _, ...rest }) => rest);
  }

  removeWorldObjects(ids: readonly string[]): void {
    const gone = new Set(ids);
    this._world.update((w) =>
      Object.fromEntries(Object.entries(w).filter(([id]) => !gone.has(id))),
    );
  }

  sendAction(text: string): void {
    this.actions.push(text);
  }

  sendChat(_text: string): void {}
}
