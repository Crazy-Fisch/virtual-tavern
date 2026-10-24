import { Injectable } from '@angular/core';
import { MathUtils, OrthographicCamera, Vector3 } from 'three';
import { RECENTER_KEYS } from './card/hotkeys';
import { TABLE_DEPTH, TABLE_WIDTH, TABLE_Y } from './scene-assets';

/**
 * Vertical slice of the world the camera shows at zoom 1, in metres. Kept fixed
 * while the viewport aspect only widens the horizontal extent: a 16:9 screen
 * frames ~7.5 m of table width, and an ultrawide (UWQHD, 21:9) one sees more to
 * the sides instead of shrinking everything.
 *
 * 4.2 covers ~4.7 m of table depth from this tilt — the player's own half up to
 * a good way past the centre line — and puts a card at ~82 × 114 px on a 1080p
 * screen, which is the "better card view" the design doc asked for.
 */
const VIEW_HEIGHT = 4.2;

/** Zoom limits relative to the base view (1 = VIEW_HEIGHT metres tall). */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.5;
/** Zoom factor per wheel "notch" (deltaY 100); trackpads send smaller deltas. */
const ZOOM_PER_NOTCH = 1.15;

/**
 * Bridge letting the CameraRig component drive the camera the Scene component
 * renders with, mirroring the SceneGraph pattern. Provided BY the Scene
 * component: the Scene keeps the frustum in sync on resize (`setAspect`);
 * CameraRig sets the seat's base pose (`setBasePose`).
 *
 * The camera is **orthographic** (the design doc's "isometric" view): with no
 * perspective divide every card is drawn at the same size and with the same
 * shape wherever it sits on the table, so a card at the far end reads exactly
 * like one in front of you — the whole point of the switch.
 *
 * The player can move it: middle-mouse drag pans across the table plane (the
 * point under the cursor follows the cursor), the wheel over the canvas zooms
 * around the cursor, and a hotkey recenters. The camera keeps the seat's tilt and
 * mirroring — only the pan offset and `camera.zoom` change — and the target is
 * clamped to the table.
 */
@Injectable()
export class SceneCamera {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

  private readonly basePosition = new Vector3(0, 6, 2.8);
  private readonly baseTarget = new Vector3(0, TABLE_Y, 0.3);
  /** World-space shift of camera and target along the table plane (X, Z). */
  private panX = 0;
  private panZ = 0;
  private canvas?: HTMLCanvasElement;
  private panning: { pointerId: number; x: number; y: number } | null = null;

  private readonly ndc = new Vector3();
  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  private readonly before = new Vector3();
  private readonly after = new Vector3();

  constructor() {
    this.setAspect(1);
    this.apply();
  }

  /** The seat's base view; resets pan and zoom to it. */
  setBasePose(position: Vector3, target: Vector3): void {
    this.basePosition.copy(position);
    this.baseTarget.copy(target);
    this.recenter();
  }

  /** Re-frame for a viewport aspect: fixed vertical extent, width follows. */
  setAspect(aspect: number): void {
    const halfHeight = VIEW_HEIGHT / 2;
    const halfWidth = halfHeight * Math.max(aspect, 0.1);
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Back to the seat's base view. */
  recenter(): void {
    this.panX = 0;
    this.panZ = 0;
    this.camera.zoom = 1;
    this.apply();
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    // Chrome starts middle-click autoscroll on mousedown, which pointerdown's
    // preventDefault does not stop.
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('auxclick', this.onMouseDown);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerEnd);
    window.addEventListener('pointercancel', this.onPointerEnd);
    window.addEventListener('keydown', this.onKeyDown);
  }

  detach(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('mousedown', this.onMouseDown);
    canvas.removeEventListener('auxclick', this.onMouseDown);
    canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerEnd);
    window.removeEventListener('pointercancel', this.onPointerEnd);
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas = undefined;
    this.panning = null;
  }

  /**
   * Pan and zoom applied to the base pose. The pan is clamped so the point the
   * camera looks at stays on the table; matrices are refreshed here because card
   * picking raycasts through them before the next render.
   */
  private apply(): void {
    const targetX = this.baseTarget.x + this.panX;
    const targetZ = this.baseTarget.z + this.panZ;
    const clampedX = MathUtils.clamp(targetX, -TABLE_WIDTH / 2, TABLE_WIDTH / 2);
    const clampedZ = MathUtils.clamp(targetZ, -TABLE_DEPTH / 2, TABLE_DEPTH / 2);
    this.panX += clampedX - targetX;
    this.panZ += clampedZ - targetZ;
    this.camera.position.set(
      this.basePosition.x + this.panX,
      this.basePosition.y,
      this.basePosition.z + this.panZ,
    );
    this.camera.lookAt(clampedX, this.baseTarget.y, clampedZ);
    this.camera.zoom = MathUtils.clamp(this.camera.zoom, MIN_ZOOM, MAX_ZOOM);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  /** Where the ray through a canvas point meets the tabletop plane, or null. */
  private tablePoint(clientX: number, clientY: number, out: Vector3): boolean {
    if (!this.canvas) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
      0,
    );
    // Orthographic: parallel rays, so the origin is the point unprojected on the
    // view plane and the direction is the camera's own.
    this.origin.copy(this.ndc).unproject(this.camera);
    this.camera.getWorldDirection(this.direction);
    if (Math.abs(this.direction.y) < 1e-6) return false;
    const t = (TABLE_Y - this.origin.y) / this.direction.y;
    out.copy(this.origin).addScaledVector(this.direction, t);
    return true;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 1 || (event.buttons & 1) !== 0) return;
    event.preventDefault();
    this.canvas?.setPointerCapture(event.pointerId);
    this.panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const panning = this.panning;
    if (!panning || event.pointerId !== panning.pointerId) return;
    const ok =
      this.tablePoint(panning.x, panning.y, this.before) &&
      this.tablePoint(event.clientX, event.clientY, this.after);
    panning.x = event.clientX;
    panning.y = event.clientY;
    if (!ok) return;
    // Move the camera so the table point that was under the cursor stays there.
    this.panX += this.before.x - this.after.x;
    this.panZ += this.before.z - this.after.z;
    this.apply();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (this.panning?.pointerId !== event.pointerId) return;
    this.canvas?.releasePointerCapture(event.pointerId);
    this.panning = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.target !== this.canvas) return;
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1;
    const notches = (-event.deltaY * lines) / 100;
    const target = MathUtils.clamp(
      this.camera.zoom * Math.pow(ZOOM_PER_NOTCH, notches),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    if (target === this.camera.zoom) return;
    // Keep the table point under the cursor fixed while zooming.
    const known = this.tablePoint(event.clientX, event.clientY, this.before);
    this.camera.zoom = target;
    this.apply();
    if (known && this.tablePoint(event.clientX, event.clientY, this.after)) {
      this.panX += this.before.x - this.after.x;
      this.panZ += this.before.z - this.after.z;
      this.apply();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!RECENTER_KEYS.includes(event.key)) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    this.recenter();
  };
}
