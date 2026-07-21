import { Injectable, computed, signal } from '@angular/core';
import { joinRoom, selfId, type Room } from 'trystero';
import { Player } from './p2p.types';

/** Unique across apps sharing the public relays — keep this distinctive. */
const APP_ID = 'virtual-tavern-2f9a7c';
/** Max position broadcasts per second (throttled; render loop calls sendPosition every frame). */
const POS_HZ = 15;

// `type` (not `interface`) to satisfy Trystero's JsonValue payload constraint.
type PosMsg = {
  pos: [number, number, number];
  rotY: number;
};
type NameMsg = {
  name: string;
};

/**
 * WebRTC avatar layer over Trystero (Nostr strategy — signaling via public relays,
 * data flows directly peer-to-peer). Carries only the high-frequency position/rotation
 * stream plus name introductions; rooms, chat, and world state are backed by Supabase
 * (see RoomService, which drives join/leave with the room's UUID as the key).
 */
@Injectable({ providedIn: 'root' })
export class P2pService {
  readonly selfId = selfId;

  private readonly _players = signal<Map<string, Player>>(new Map());

  /** Remote players only (self is rendered locally). */
  readonly players = computed(() => Array.from(this._players().values()));
  readonly peerCount = computed(() => this._players().size);

  private room?: Room;
  private displayName = 'guest';

  private sendPosFn?: (m: PosMsg, target?: string) => void;
  private sendNameFn?: (m: NameMsg, target?: string) => void;

  private posTimer?: ReturnType<typeof setInterval>;
  private latestLocal: PosMsg = { pos: [0, 0, 0], rotY: 0 };
  private posDirty = false;

  /** Join (or re-join) a room. The key is the room's UUID, resolved by RoomService. */
  join(roomKey: string, displayName: string): void {
    this.leave();
    this.displayName = displayName.trim() || 'guest';

    const room = joinRoom({ appId: APP_ID }, roomKey);
    this.room = room;

    const posAction = room.makeAction<PosMsg>('pos');
    const nameAction = room.makeAction<NameMsg>('name');

    this.sendPosFn = (m, target) => void posAction.send(m, target ? { target } : undefined);
    this.sendNameFn = (m, target) => void nameAction.send(m, target ? { target } : undefined);

    posAction.onMessage = (data, { peerId }) =>
      this.upsertPlayer(peerId, { pos: data.pos, rotY: data.rotY });
    nameAction.onMessage = (data, { peerId }) => this.upsertPlayer(peerId, { name: data.name });

    room.onPeerJoin = (peerId) => {
      this.upsertPlayer(peerId, {});
      this.sendNameFn?.({ name: this.displayName }, peerId); // introduce ourselves
    };
    room.onPeerLeave = (peerId) => {
      this._players.update((m) => {
        const n = new Map(m);
        n.delete(peerId);
        return n;
      });
    };

    // Announce name once, then broadcast position at a fixed rate when it changes.
    this.sendNameFn?.({ name: this.displayName });
    this.posTimer = setInterval(() => {
      if (this.posDirty && this.sendPosFn) {
        this.sendPosFn(this.latestLocal);
        this.posDirty = false;
      }
    }, 1000 / POS_HZ);
  }

  /** Called every frame by the scene; actual network send is throttled to POS_HZ. */
  sendPosition(pos: [number, number, number], rotY: number): void {
    this.latestLocal = { pos, rotY };
    this.posDirty = true;
  }

  leave(): void {
    if (this.posTimer) clearInterval(this.posTimer);
    this.posTimer = undefined;
    this.sendPosFn = this.sendNameFn = undefined;
    void this.room?.leave();
    this.room = undefined;
    this._players.set(new Map());
  }

  private upsertPlayer(id: string, patch: Partial<Player>): void {
    this._players.update((m) => {
      const n = new Map(m);
      const cur = n.get(id) ?? { id, name: 'guest', pos: [0, 0, 0] as [number, number, number], rotY: 0 };
      n.set(id, { ...cur, ...patch });
      return n;
    });
  }
}
