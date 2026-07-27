import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  TetrahedronGeometry,
  Vector3,
} from 'three';
import { CounterVariant, DiceKind, ItemKind, counterLabel } from './item.types';

/**
 * Procedural placeholder bodies for the table items (additionalitems.md asks
 * for "the provided 3d model (placeholders for now)"): plain Three geometry
 * plus canvas textures, so dice, coins and counters work before any GLB exists.
 * Register a real model in ITEM_MODEL_URLS (scene-assets.ts) and the `Item`
 * component uses it instead — nothing here changes.
 *
 * Sizes are in metres, against a card of 0.32 × 0.44 m.
 */
export const DIE_EDGE = 0.16;
export const DIE_RADIUS = 0.1;
export const COIN_RADIUS = 0.09;
export const COIN_HEIGHT = 0.018;
export const COUNTER_RADIUS = 0.07;
export const COUNTER_HEIGHT = 0.022;

/** Height an item's body floats above its origin so it rests ON the surface. */
export function restLift(kind: ItemKind): number {
  switch (kind) {
    case 'd6':
      return DIE_EDGE / 2;
    case 'coin':
      return COIN_HEIGHT / 2;
    case 'counter':
      return COUNTER_HEIGHT / 2;
    default:
      return DIE_RADIUS;
  }
}

/**
 * Face normals of the d6 in BoxGeometry's material order (+X, −X, +Y, −Y, +Z,
 * −Z) with the pip counts of a real die: opposite faces sum to 7. A roll reads
 * the value straight off whichever of these ends up pointing at the sky.
 */
export const D6_FACE_VALUES: readonly number[] = [1, 6, 2, 5, 3, 4];
export const D6_FACE_NORMALS: readonly Vector3[] = [
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, -1, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];

export function makeDiceGeometry(kind: DiceKind): BufferGeometry {
  switch (kind) {
    case 'd4':
      return new TetrahedronGeometry(DIE_RADIUS);
    case 'd6':
      return new BoxGeometry(DIE_EDGE, DIE_EDGE, DIE_EDGE);
    case 'd12':
      return new DodecahedronGeometry(DIE_RADIUS);
    case 'd20':
      return new IcosahedronGeometry(DIE_RADIUS);
  }
}

export function makeCoinGeometry(): BufferGeometry {
  return new CylinderGeometry(COIN_RADIUS, COIN_RADIUS, COIN_HEIGHT, 32);
}

export function makeCounterGeometry(): BufferGeometry {
  return new CylinderGeometry(COUNTER_RADIUS, COUNTER_RADIUS, COUNTER_HEIGHT, 24);
}

/** 2D context of a fresh square canvas, or null where canvas is unavailable (SSR/tests). */
function canvas2d(
  size: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

function texture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas);
  map.needsUpdate = true;
  return map;
}

/** Pip layout per face value, in units of thirds of the face. */
const PIPS: Readonly<Record<number, readonly [number, number][]>> = {
  1: [[2, 2]],
  2: [
    [1, 1],
    [3, 3],
  ],
  3: [
    [1, 1],
    [2, 2],
    [3, 3],
  ],
  4: [
    [1, 1],
    [3, 1],
    [1, 3],
    [3, 3],
  ],
  5: [
    [1, 1],
    [3, 1],
    [2, 2],
    [1, 3],
    [3, 3],
  ],
  6: [
    [1, 1],
    [3, 1],
    [1, 2],
    [3, 2],
    [1, 3],
    [3, 3],
  ],
};

/** The six pip faces of a d6, in BoxGeometry material order. */
export function makeD6PipTextures(): CanvasTexture[] {
  return D6_FACE_VALUES.map((value) => makePipTexture(value));
}

function makePipTexture(value: number): CanvasTexture {
  const made = canvas2d(128);
  if (!made) return new CanvasTexture(document.createElement('canvas'));
  const { canvas, ctx } = made;
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#1b1b24';
  for (const [x, y] of PIPS[value] ?? []) {
    ctx.beginPath();
    ctx.arc(x * 32, y * 32, 12, 0, Math.PI * 2);
    ctx.fill();
  }
  return texture(canvas);
}

/** Coin faces: index 0 = heads (the +Y cap), 1 = tails. */
export function makeCoinTextures(): [CanvasTexture, CanvasTexture] {
  return [makeCoinFace('HEADS', '★'), makeCoinFace('TAILS', '✦')];
}

function makeCoinFace(label: string, glyph: string): CanvasTexture {
  const made = canvas2d(128);
  if (!made) return new CanvasTexture(document.createElement('canvas'));
  const { canvas, ctx } = made;
  ctx.fillStyle = '#d9b96a';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#8a6d2f';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#4a3a12';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '46px sans-serif';
  ctx.fillText(glyph, 64, 54);
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(label, 64, 96);
  return texture(canvas);
}

/** A counter's face, showing its current value ("+2/+2"). */
export function makeCounterTexture(value: number, variant: CounterVariant): CanvasTexture {
  const made = canvas2d(128);
  if (!made) return new CanvasTexture(document.createElement('canvas'));
  const { canvas, ctx } = made;
  const plus = variant !== 'minus';
  ctx.fillStyle = plus ? '#2f7d4f' : '#8a2f3a';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText(counterLabel(value, variant), 64, 64);
  return texture(canvas);
}

/** The number a rolled polyhedron shows on the label floating over it. */
export function makeValueTexture(value: number): CanvasTexture {
  const made = canvas2d(128);
  if (!made) return new CanvasTexture(document.createElement('canvas'));
  const { canvas, ctx } = made;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(20, 20, 28, 0.85)';
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText(String(value), 64, 68);
  return texture(canvas);
}
