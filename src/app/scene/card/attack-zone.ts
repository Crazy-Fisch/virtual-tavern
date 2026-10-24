import { TABLE_WIDTH, TABLE_Y } from '../scene-assets';
import { CARD_LENGTH, CARD_WIDTH, CardState } from './card.types';

/**
 * The attack zone: a horizontal band across the middle of the table (z around
 * 0) where both seats meet. Pure geometry and layout, no Angular or Three, so
 * CardStore, the drag code and the glow can share it.
 *
 * Seats: the room owner sits at +Z, everyone else at -Z (`RoomService.seatYaw`).
 * Attackers line up on their owner's half of the band (the "attacker lane"); a
 * blocker stands opposite its attacker, on the other lane.
 */
export type Seat = 1 | -1;

/** Gap between neighbouring cards of a row, in metres. */
export const ZONE_PADDING = 0.1;
/** Gap between the attacker lane and the blocker lane. */
export const LANE_GAP = 0.04;
/** Distance of each lane's centre line from z = 0. */
export const LANE_Z = (CARD_LENGTH + LANE_GAP) / 2;
/** Free border around the two lanes that still counts as inside the zone; keep it >= 0 so both lanes stay inside. */
const ZONE_MARGIN = 0.05;
/** The band covers |z| <= ZONE_HALF_DEPTH and the whole table width. */
export const ZONE_HALF_DEPTH = LANE_Z + CARD_LENGTH / 2 + ZONE_MARGIN;
/** Largest share of its width a blocker may be covered by its neighbour before the attackers spread out. */
export const BLOCKER_MAX_OVERLAP = 0.55;
/** Resting height of a card in the zone and the lift of each further overlapping blocker. */
export const ZONE_Y = TABLE_Y + 0.01;
export const STACK_LIFT = 0.01;

export function inAttackZone(x: number, z: number): boolean {
  return Math.abs(z) <= ZONE_HALF_DEPTH && Math.abs(x) <= TABLE_WIDTH / 2;
}

/** Centre line (z) of the lane where this seat's attackers stand. */
export function attackSide(seat: Seat): number {
  return seat * LANE_Z;
}

/** Centre line (z) of the lane where blockers of this seat's attackers stand. */
export function blockSide(seat: Seat): number {
  return -seat * LANE_Z;
}

/** Who is who at the table, to find the seat of a card's owner. */
export interface SeatContext {
  /** My auth uid. */
  me: string | null;
  /** Whether I am the room owner (seated at +Z). */
  meIsOwner: boolean;
  /** The room owner's uid, when known. */
  ownerId?: string | null;
}

/** The seat of the player with this uid: the owner at +Z, everybody else at -Z. */
export function seatOfUid(uid: string, ctx: SeatContext): Seat {
  const mine: Seat = ctx.meIsOwner ? 1 : -1;
  if (uid && uid === ctx.me) return mine;
  if (ctx.ownerId) return uid === ctx.ownerId ? 1 : -1;
  return mine === 1 ? -1 : 1;
}

export interface CombatPlacement {
  position: [number, number, number];
  yaw: number;
}

export interface CombatLayout {
  /** Target pose of every attacker and every blocker that still has a valid attacker. */
  placements: Map<string, CombatPlacement>;
  /** Blockers whose target is gone or not attacking: they leave combat and stay where they are. */
  released: string[];
}

/** Footprint along x: a tapped card lies on its side. */
function widthOf(card: CardState): number {
  return card.tapped ? CARD_LENGTH : CARD_WIDTH;
}

const byPosition = (a: CardState, b: CardState): number =>
  a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Slot {
  attacker: CardState;
  blockers: CardState[];
  /** Centre-to-centre distance of neighbouring blockers (< their width = overlap). */
  pitch: number;
  width: number;
}

/**
 * Where every attacker and blocker belongs. Attackers of a seat stand next to
 * each other with ZONE_PADDING, centred on x = 0, ordered by their current x
 * (then id) so dropping a card left of another puts it on the left. The blockers
 * of one attacker stand opposite it, centred on its x: while they fit into the
 * attacker's own width they sit side by side, past that they overlap each other
 * (at most BLOCKER_MAX_OVERLAP), and only when even that does not fit the attacker
 * gets a wider slot, which pushes its neighbours apart. `tapped` is never touched.
 * Both seats attacking at once would share the lanes; the zone is made for one
 * attacker at a time.
 */
export function layoutCombat(
  cards: readonly CardState[],
  seatOf: (card: CardState) => Seat,
): CombatLayout {
  const placements = new Map<string, CombatPlacement>();
  const released: string[] = [];
  const attackers = cards.filter((c) => c.combat?.role === 'attack');
  const attackerIds = new Set(attackers.map((c) => c.id));
  const blockersOf = new Map<string, CardState[]>();
  for (const card of cards) {
    const combat = card.combat;
    if (combat?.role !== 'block') continue;
    if (!attackerIds.has(combat.target)) {
      released.push(card.id);
      continue;
    }
    blockersOf.set(combat.target, [...(blockersOf.get(combat.target) ?? []), card]);
  }

  for (const seat of [1, -1] as const) {
    const slots: Slot[] = attackers
      .filter((a) => seatOf(a) === seat)
      .sort(byPosition)
      .map((attacker) => {
        const blockers = (blockersOf.get(attacker.id) ?? []).sort(byPosition);
        const own = widthOf(attacker);
        if (blockers.length < 2) {
          return {
            attacker,
            blockers,
            pitch: 0,
            width: Math.max(own, blockers[0] ? widthOf(blockers[0]) : 0),
          };
        }
        const bw = Math.max(...blockers.map(widthOf));
        const gaps = blockers.length - 1;
        const natural = bw + ZONE_PADDING;
        const fit = (own - bw) / gaps;
        const pitch = Math.min(natural, Math.max(bw * (1 - BLOCKER_MAX_OVERLAP), fit));
        return { attacker, blockers, pitch, width: Math.max(own, gaps * pitch + bw) };
      });
    if (slots.length === 0) continue;

    const total = slots.reduce((sum, s) => sum + s.width, 0) + (slots.length - 1) * ZONE_PADDING;
    let left = -total / 2;
    for (const slot of slots) {
      const x = left + slot.width / 2;
      left += slot.width + ZONE_PADDING;
      placements.set(slot.attacker.id, {
        position: [x, ZONE_Y, attackSide(seat)],
        yaw: slot.attacker.yaw,
      });
      slot.blockers.forEach((blocker, i) => {
        placements.set(blocker.id, {
          position: [
            x + (i - (slot.blockers.length - 1) / 2) * slot.pitch,
            ZONE_Y + i * STACK_LIFT,
            blockSide(seat),
          ],
          yaw: blocker.yaw,
        });
      });
    }
  }
  return { placements, released };
}
