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
import { CounterVariant, DiceKind, ItemColor, ItemKind, counterLabel } from './item.types';

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
/** The x counter is a squared tile rather than a disc (newmechanics.md). */
export const COUNTER_EDGE = 0.12;

/** Height an item's body floats above its origin so it rests ON the surface.
 * Both counter shapes (disc and squared tile) are COUNTER_HEIGHT thick, so the
 * variant never changes this. */
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
 * The four die colours (newmechanics.md). `body` paints the polyhedron / the
 * d6's faces, `ink` is what reads on top of it — pips, and the number on the
 * label floating over a polyhedral die.
 */
export const DIE_PALETTE: Readonly<Record<ItemColor, { body: string; ink: string }>> = {
  green: { body: '#2f8f4e', ink: '#f4fff6' },
  blue: { body: '#3563cf', ink: '#f2f6ff' },
  red: { body: '#c0392f', ink: '#fff3f1' },
  yellow: { body: '#e0b32c', ink: '#3a2c05' },
};

/** The die colour as a Three colour literal (materials want a number). */
export function dieColorHex(color: ItemColor): number {
  return parseInt(DIE_PALETTE[color].body.slice(1), 16);
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

/**
 * A ±1/±1 counter is a small disc; the x counter is a squared tile of the same
 * thickness. The two shapes carry their face on different material slots —
 * see `counterFaceSlot`.
 */
export function makeCounterGeometry(variant: CounterVariant): BufferGeometry {
  return variant === 'x'
    ? new BoxGeometry(COUNTER_EDGE, COUNTER_HEIGHT, COUNTER_EDGE)
    : new CylinderGeometry(COUNTER_RADIUS, COUNTER_RADIUS, COUNTER_HEIGHT, 24);
}

/**
 * Which material of a counter's mesh carries the printed value: the cylinder's
 * material order is side / top / bottom, the box's is +X, −X, **+Y**, −Y, +Z, −Z.
 */
export function counterFaceSlot(variant: CounterVariant): number {
  return variant === 'x' ? 2 : 1;
}

/** Material list for a counter body: every face plain but the one on top. */
export function counterFaceCount(variant: CounterVariant): number {
  return variant === 'x' ? 6 : 3;
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

/** The six pip faces of a d6 in its own colour, in BoxGeometry material order. */
export function makeD6PipTextures(color: ItemColor): CanvasTexture[] {
  return D6_FACE_VALUES.map((value) => makePipTexture(value, color));
}

function makePipTexture(value: number, color: ItemColor): CanvasTexture {
  const made = canvas2d(128);
  if (!made) return new CanvasTexture(document.createElement('canvas'));
  const { canvas, ctx } = made;
  ctx.fillStyle = DIE_PALETTE[color].body;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = DIE_PALETTE[color].ink;
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

/** Body colour of each counter flavour; the x counter reads neutral slate. */
const COUNTER_COLORS: Readonly<Record<CounterVariant, string>> = {
  plus: '#2f7d4f',
  minus: '#8a2f3a',
  x: '#3c3f5c',
};

/** A counter's face, showing its current value ("+2/+2", or "2x"). */
export function makeCounterTexture(value: number, variant: CounterVariant): CanvasTexture {
  const made = canvas2d(128);
  if (!made) return new CanvasTexture(document.createElement('canvas'));
  const { canvas, ctx } = made;
  ctx.fillStyle = COUNTER_COLORS[variant];
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // "2x" is far shorter than "+2/+2" and gets to be big and readable.
  ctx.font = `bold ${variant === 'x' ? 66 : 40}px sans-serif`;
  ctx.fillText(counterLabel(value, variant), 64, 64);
  return texture(canvas);
}

/**
 * The label floating over a polyhedral die, redrawn in place. A roll cycles it
 * through random in-range numbers while the die tumbles and only settles on the
 * result at the end (newmechanics.md), which would churn through a texture per
 * frame — so the canvas is kept and repainted, and the CanvasTexture over it
 * simply re-uploads.
 */
export interface ValueCanvas {
  readonly canvas: HTMLCanvasElement;
  /** Repaint the label with this number. */
  draw(value: number, color: ItemColor): void;
}

export function makeValueCanvas(): ValueCanvas {
  const made = canvas2d(128);
  const canvas = made?.canvas ?? document.createElement('canvas');
  const ctx = made?.ctx;
  return {
    canvas,
    draw(value: number, color: ItemColor): void {
      if (!ctx) return;
      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = DIE_PALETTE[color].body;
      ctx.beginPath();
      ctx.arc(64, 64, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(12, 12, 18, 0.65)';
      ctx.stroke();
      ctx.fillStyle = DIE_PALETTE[color].ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 64px sans-serif';
      ctx.fillText(String(value), 64, 68);
    },
  };
}
