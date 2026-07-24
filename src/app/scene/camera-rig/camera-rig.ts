import { Component, OnDestroy, inject } from '@angular/core';
import { Euler, Quaternion, Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { SceneCamera } from '../scene-camera';

/**
 * Fixed camera base pose: a near-bird's-eye view (~20° off vertical) from the
 * player's table end (+Z for the room owner). Pulled in from the old 5.0 m to
 * 4.2 m so cards read larger and clearer (the far table end crops slightly,
 * which is fine — each player mostly cares about their own half). Tabletop
 * surface is at y ≈ 0.2. Non-owners get the pose mirrored to the −Z end.
 */
const CAMERA_POS = new Vector3(0, 4.2, 1.55);
const CAMERA_TARGET = new Vector3(0, 0.2, -0.2);

/** Fraction of the half-screen (from center) with no tilt; beyond it the tilt
 * ramps linearly to its maximum at the screen edge. */
const DEAD_ZONE = 0.4;
/** Maximum yaw (left/right) and pitch (up/down) tilt, in radians (~3.5° / ~2.5°). */
const MAX_YAW = 0.06;
const MAX_PITCH = 0.045;
/** Damping rate for easing toward the target tilt (higher = snappier). */
const DAMPING = 6;

/**
 * Drives the SceneCamera provided by the Scene component: holds the fixed base
 * pose and adds a slight pan toward the mouse when it nears a screen edge,
 * easing back to center when it returns. Leaving the window holds the lean
 * toward the exit edge until the mouse comes back. Renders no DOM.
 */
@Component({
  selector: 'app-camera-rig',
  templateUrl: './camera-rig.html',
  standalone: true,
})
export class CameraRig implements OnDestroy {
  private readonly sceneCamera = inject(SceneCamera);
  private readonly room = inject(RoomService);

  private readonly baseQuaternion = new Quaternion();
  private readonly offsetEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly offset = new Quaternion();
  /** Target tilt in half-screens from center, -1..1 (x = yaw, y = pitch). */
  private targetX = 0;
  private targetY = 0;
  /** Current smoothed tilt, eased toward the target every frame. */
  private currentX = 0;
  private currentY = 0;
  private frameId = 0;
  private lastTime = 0;

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.targetX = this.edgeAmount((event.clientX / window.innerWidth) * 2 - 1);
    this.targetY = this.edgeAmount((event.clientY / window.innerHeight) * 2 - 1);
  };

  /** The OS cursor is invisible to the page once it leaves the window, so hold
   * the lean toward the exit point (a fast exit can outrun the last pointermove,
   * which may still be inside the dead zone — the leave coords are at the edge). */
  private readonly onPointerLeave = (event: PointerEvent): void => {
    this.onPointerMove(event);
  };

  constructor() {
    const camera = this.sceneCamera.camera;
    // The room owner sits at +Z; everyone else at the mirrored −Z table end
    // (seating is fixed for the stay in the room — set once on mount).
    const side = this.room.isRoomOwner() ? 1 : -1;
    camera.position.set(CAMERA_POS.x * side, CAMERA_POS.y, CAMERA_POS.z * side);
    camera.lookAt(CAMERA_TARGET.x * side, CAMERA_TARGET.y, CAMERA_TARGET.z * side);
    this.baseQuaternion.copy(camera.quaternion);

    window.addEventListener('pointermove', this.onPointerMove);
    document.documentElement.addEventListener('pointerleave', this.onPointerLeave);

    this.lastTime = performance.now();
    const animate = (now: number) => {
      this.frameId = requestAnimationFrame(animate);
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      this.update(dt);
    };
    this.frameId = requestAnimationFrame(animate);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('pointermove', this.onPointerMove);
    document.documentElement.removeEventListener('pointerleave', this.onPointerLeave);
  }

  /** Map a -1..1 screen coordinate to a tilt amount: 0 inside the dead zone,
   * ramping to ±1 at the screen edge. */
  private edgeAmount(n: number): number {
    const beyond = Math.max(Math.abs(n) - DEAD_ZONE, 0) / (1 - DEAD_ZONE);
    return Math.sign(n) * Math.min(beyond, 1);
  }

  private update(dt: number): void {
    const t = 1 - Math.exp(-DAMPING * dt);
    this.currentX += (this.targetX - this.currentX) * t;
    this.currentY += (this.targetY - this.currentY) * t;

    // Yaw toward the mouse's side, pitch toward its vertical edge, on top of
    // the base look-at pose ('YXZ' keeps yaw about the world-up axis).
    this.offsetEuler.set(-this.currentY * MAX_PITCH, -this.currentX * MAX_YAW, 0);
    this.offset.setFromEuler(this.offsetEuler);
    this.sceneCamera.camera.quaternion.copy(this.baseQuaternion).multiply(this.offset);
  }
}
