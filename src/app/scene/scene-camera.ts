import { Injectable } from '@angular/core';
import { OrthographicCamera } from 'three';

/**
 * Vertical slice of the world the camera shows, in metres. Kept fixed while the
 * viewport aspect only widens the horizontal extent: a 16:9 screen frames the
 * table (4 × 6 m, tabletop at y ≈ 0.2), and an ultrawide (UWQHD, 21:9) one sees
 * more floor to the sides instead of shrinking everything.
 *
 * 4.2 covers ~4.7 m of table depth from this tilt — the player's own half plus
 * a good way past the centre line — and puts a card at ~82 × 114 px on a 1080p
 * screen, which is the "better card view" the design doc asked for.
 */
const VIEW_HEIGHT = 4.2;

/**
 * Bridge letting the CameraRig component drive the camera the Scene component
 * renders with, mirroring the SceneGraph pattern. Provided BY the Scene
 * component: the Scene keeps the frustum in sync on resize (`setAspect`);
 * CameraRig positions and animates it.
 *
 * The camera is **orthographic** (the design doc's "isometric" view): with no
 * perspective divide every card is drawn at the same size and with the same
 * shape wherever it sits on the table, so a card at the far end reads exactly
 * like one in front of you — the whole point of the switch.
 */
@Injectable()
export class SceneCamera {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

  constructor() {
    this.setAspect(1);
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
}
