import {
  BLOCKER_MAX_OVERLAP,
  BLOCK_Z,
  Seat,
  ZONE_HALF_DEPTH,
  ZONE_PADDING,
  attackSide,
  inAttackZone,
  layoutCombat,
  seatOfUid,
} from './attack-zone';
import { TABLE_WIDTH } from '../scene-assets';
import { CARD_WIDTH, CardState } from './card.types';

function card(
  id: string,
  x: number,
  combat?: CardState['combat'],
  extra: Partial<CardState> = {},
): CardState {
  return {
    id,
    name: id,
    src: '',
    position: [x, 0.5, 3],
    yaw: 0,
    faceUp: true,
    tapped: false,
    relatedNames: [],
    ownerUid: 'me',
    ...(combat ? { combat } : {}),
    ...extra,
  };
}

const mine = (): Seat => 1;
const ATTACK = { role: 'attack' } as const;
const block = (target: string) => ({ role: 'block', target }) as const;

describe('attack zone layout', () => {
  it('keeps a single attacker at its dropped x on the band centre', () => {
    const { placements, released } = layoutCombat([card('a', 2.5, ATTACK)], mine);
    const [x, , z] = placements.get('a')!.position;
    expect(x).toBeCloseTo(2.5);
    expect(z).toBe(0);
    expect(attackSide(1)).toBe(0);
    expect(released).toEqual([]);
  });

  it('snaps the other seat attacker to the band centre too and keeps yaw', () => {
    const c = card('a', 0, ATTACK, { yaw: Math.PI });
    const { placements } = layoutCombat([c], () => -1);
    expect(placements.get('a')!.position[2]).toBe(0);
    expect(placements.get('a')!.yaw).toBe(Math.PI);
  });

  it('leaves attackers that do not overlap at their dropped x', () => {
    const { placements } = layoutCombat(
      [card('c', 3, ATTACK), card('a', -2, ATTACK), card('b', 0, ATTACK)],
      mine,
    );
    const xs = ['a', 'b', 'c'].map((id) => placements.get(id)!.position[0]);
    expect(xs[0]).toBeCloseTo(-2);
    expect(xs[1]).toBeCloseTo(0);
    expect(xs[2]).toBeCloseTo(3);
  });

  it('separates two overlapping attackers around their mean, keeping the order', () => {
    const { placements } = layoutCombat([card('b', 1.2, ATTACK), card('a', 1, ATTACK)], mine);
    const [xa, xb] = ['a', 'b'].map((id) => placements.get(id)!.position[0]);
    expect(xb - xa).toBeCloseTo(CARD_WIDTH + ZONE_PADDING);
    expect((xa + xb) / 2).toBeCloseTo(1.1);
  });

  it('merges chains of colliding attackers into one row', () => {
    const { placements } = layoutCombat(
      [card('a', 0, ATTACK), card('b', 0.5, ATTACK), card('c', 1, ATTACK)],
      mine,
    );
    const xs = ['a', 'b', 'c'].map((id) => placements.get(id)!.position[0]);
    const pitch = CARD_WIDTH + ZONE_PADDING;
    expect(xs[1] - xs[0]).toBeCloseTo(pitch);
    expect(xs[2] - xs[1]).toBeCloseTo(pitch);
    expect(xs[1]).toBeCloseTo(0.5);
  });

  it('keeps an attacker near or beyond the table edge on the table', () => {
    const half = TABLE_WIDTH / 2;
    const right = layoutCombat([card('a', half + 2, ATTACK)], mine).placements.get('a')!;
    expect(right.position[0]).toBeCloseTo(half - CARD_WIDTH / 2);
    const left = layoutCombat([card('a', -half, ATTACK)], mine).placements.get('a')!;
    expect(left.position[0]).toBeCloseTo(-half + CARD_WIDTH / 2);
    const pair = layoutCombat([card('b', half, ATTACK), card('a', half - 0.1, ATTACK)], mine);
    const [xa, xb] = ['a', 'b'].map((id) => pair.placements.get(id)!.position[0]);
    expect(xa).toBeLessThan(xb);
    expect(xb).toBeLessThanOrEqual(half - CARD_WIDTH / 2 + 1e-9);
    expect(xb - xa).toBeCloseTo(CARD_WIDTH + ZONE_PADDING);
  });

  it('is deterministic for equal x (by id)', () => {
    const one = layoutCombat([card('b', 1, ATTACK), card('a', 1, ATTACK)], mine);
    expect(one.placements.get('a')!.position[0]).toBeLessThan(one.placements.get('b')!.position[0]);
  });

  it('centres a blocker opposite its attacker, outside the band on the defender side', () => {
    const { placements } = layoutCombat(
      [card('a', 0, ATTACK), card('b', 2, ATTACK), card('x', 9, block('b'), { ownerUid: 'them' })],
      mine,
    );
    const a = placements.get('a')!.position;
    const b = placements.get('b')!.position;
    const x = placements.get('x')!.position;
    expect(x[0]).toBeCloseTo(b[0]);
    expect(b[2]).toBe(0);
    expect(x[2]).toBeCloseTo(-BLOCK_Z);
    expect(Math.abs(x[2])).toBeGreaterThan(ZONE_HALF_DEPTH);
    expect(
      layoutCombat([card('a', 0, ATTACK), card('x', 0, block('a'))], () => -1).placements.get('x')!
        .position[2],
    ).toBeCloseTo(BLOCK_Z);
    expect(a[0]).toBeLessThan(b[0]);
  });

  it('fits two blockers next to each other only when the attacker is wide enough, else overlaps first', () => {
    const layout = (n: number) =>
      layoutCombat(
        [
          card('a', 0, ATTACK),
          card('z', 0.5, ATTACK),
          ...Array.from({ length: n }, (_, i) => card(`b${i}`, i, block('a'))),
        ],
        mine,
      );
    const two = layout(2);
    const pitch2 = Math.abs(
      two.placements.get('b1')!.position[0] - two.placements.get('b0')!.position[0],
    );
    expect(pitch2).toBeCloseTo(CARD_WIDTH * (1 - BLOCKER_MAX_OVERLAP));
    expect(pitch2).toBeLessThan(CARD_WIDTH);
    const [b0, b1] = [two.placements.get('b0')!, two.placements.get('b1')!];
    expect(b1.position[1]).toBeGreaterThan(b0.position[1]);
    expect((b0.position[0] + b1.position[0]) / 2).toBeCloseTo(two.placements.get('a')!.position[0]);
  });

  it('widens the attacker spacing only after the overlap limit is reached', () => {
    const gap = (n: number) => {
      const { placements } = layoutCombat(
        [
          card('a', 0, ATTACK),
          card('z', 0.5, ATTACK),
          ...Array.from({ length: n }, (_, i) => card(`b${i}`, i, block('a'))),
        ],
        mine,
      );
      return placements.get('z')!.position[0] - placements.get('a')!.position[0];
    };
    const base = CARD_WIDTH + ZONE_PADDING;
    expect(gap(1)).toBeCloseTo(base);
    const slot = (n: number) => CARD_WIDTH * (1 - BLOCKER_MAX_OVERLAP) * (n - 1) + CARD_WIDTH;
    expect(gap(2)).toBeGreaterThan(base);
    expect(gap(5)).toBeCloseTo((slot(5) + CARD_WIDTH) / 2 + ZONE_PADDING);
    expect(gap(5)).toBeGreaterThan(gap(3));
  });

  it('releases blockers whose attacker is gone or not attacking', () => {
    const { placements, released } = layoutCombat(
      [card('b', 0, block('ghost')), card('c', 0, block('p')), card('p', 0)],
      mine,
    );
    expect(released.sort()).toEqual(['b', 'c']);
    expect(placements.size).toBe(0);
  });

  it('never changes tapped and ignores cards without combat', () => {
    const { placements } = layoutCombat(
      [card('a', 0, ATTACK, { tapped: true }), card('n', 1)],
      mine,
    );
    expect([...placements.keys()]).toEqual(['a']);
  });

  it('knows the zone band and the seats', () => {
    expect(inAttackZone(1, 0)).toBe(true);
    expect(inAttackZone(1, ZONE_HALF_DEPTH + 0.01)).toBe(false);
    expect(inAttackZone(1, attackSide(1))).toBe(true);
    expect(inAttackZone(1, BLOCK_Z)).toBe(false);
    expect(seatOfUid('me', { me: 'me', meIsOwner: true })).toBe(1);
    expect(seatOfUid('them', { me: 'me', meIsOwner: true })).toBe(-1);
    expect(seatOfUid('them', { me: 'me', meIsOwner: false, ownerId: 'them' })).toBe(1);
    expect(seatOfUid('them', { me: 'me', meIsOwner: false })).toBe(1);
  });
});
