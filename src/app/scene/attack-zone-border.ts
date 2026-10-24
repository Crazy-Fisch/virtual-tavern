import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { ZONE_HALF_DEPTH } from './card/attack-zone';
import { TABLE_WIDTH, TABLE_Y } from './scene-assets';

/** Offsets of the border loops from the band edge (m) and the brightness at each: a thin core with a soft falloff on both sides. */
const LOOP_OFFSETS = [-0.14, -0.015, 0.015, 0.14];
const LOOP_BRIGHTNESS = [0, 1, 1, 0];
const BORDER_Y = TABLE_Y + 0.004;
const IDLE_COLOR = new Color(0xcdb98f);
const IDLE_OPACITY = 0.1;
const ACTIVE_COLOR = new Color(0xff2a14);
const ACTIVE_OPACITY = 0.42;
/** Pulse amplitude while active and the fade time between idle and active. */
const PULSE_AMOUNT = 0.1;
const FADE_SECONDS = 0.35;

/**
 * Outline of the attack zone band on the tabletop (a flat strip mesh, additive,
 * unlit). It never takes part in picking and is not a drop surface. The renderer
 * has no tone mapping, so the glow stays at a low additive opacity.
 */
export class AttackZoneBorder {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly material = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private level = 0;
  private lastSeconds = 0;

  constructor() {
    const halfW = TABLE_WIDTH / 2;
    const positions: number[] = [];
    const colors: number[] = [];
    for (const [i, d] of LOOP_OFFSETS.entries()) {
      const b = LOOP_BRIGHTNESS[i] ?? 0;
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        positions.push(sx * (halfW + d), 0, sz * (ZONE_HALF_DEPTH + d));
        colors.push(b, b, b);
      }
    }
    const indices: number[] = [];
    for (let loop = 0; loop < LOOP_OFFSETS.length - 1; loop++) {
      for (let k = 0; k < 4; k++) {
        const a = loop * 4 + k;
        const a2 = loop * 4 + ((k + 1) % 4);
        indices.push(a, a2, a2 + 4, a, a2 + 4, a + 4);
      }
    }
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    this.geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    this.geometry.setIndex(indices);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.position.y = BORDER_Y;
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => undefined;
    this.material.color.copy(IDLE_COLOR);
    this.material.opacity = IDLE_OPACITY;
  }

  /** Fade towards the red glow while `active`; a gentle pulse unless the user prefers reduced motion. */
  update(seconds: number, active: boolean, reducedMotion: boolean): void {
    const dt = Math.min(Math.max(seconds - this.lastSeconds, 0), 0.25);
    this.lastSeconds = seconds;
    const step = dt / FADE_SECONDS;
    this.level = active ? Math.min(1, this.level + step) : Math.max(0, this.level - step);
    const pulse = reducedMotion ? 0 : PULSE_AMOUNT * Math.sin(seconds * 2.4);
    this.material.color.copy(IDLE_COLOR).lerp(ACTIVE_COLOR, this.level);
    this.material.opacity =
      IDLE_OPACITY + (ACTIVE_OPACITY - IDLE_OPACITY) * this.level * (1 + pulse);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
