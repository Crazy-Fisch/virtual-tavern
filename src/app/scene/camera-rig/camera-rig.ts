import { Component, inject } from '@angular/core';
import { Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { SceneCamera } from '../scene-camera';

/**
 * Fixed camera base pose: a bird's-eye view ~26° off vertical from the player's
 * table end (+Z for the room owner), looking down at the tabletop (y ≈ 0.2).
 * The camera is orthographic (see SceneCamera), so this distance only decides
 * clipping, never the on-screen size of anything — how much table is framed is
 * SceneCamera's VIEW_HEIGHT. Non-owners get the pose mirrored to the −Z end.
 */
const CAMERA_POS = new Vector3(0, 6, 2.8);
// Aimed slightly toward the player's own end, so their whole half of the table
// is framed and the crop falls on the far end they care least about.
const CAMERA_TARGET = new Vector3(0, 0.2, 0.3);

/**
 * Poses the SceneCamera provided by the Scene component: the fixed pose above,
 * mirrored for the player's table end. The former slight pan toward the mouse
 * near screen edges was removed — under the fixed orthographic view it read as
 * irritating rather than immersive (stabilityandimprovements.md "camera
 * movement"). Renders no DOM.
 */
@Component({
  selector: 'app-camera-rig',
  templateUrl: './camera-rig.html',
  standalone: true,
})
export class CameraRig {
  constructor() {
    const camera = inject(SceneCamera).camera;
    // The room owner sits at +Z; everyone else at the mirrored −Z table end
    // (seating is fixed for the stay in the room — set once on mount).
    const side = inject(RoomService).isRoomOwner() ? 1 : -1;
    camera.position.set(CAMERA_POS.x * side, CAMERA_POS.y, CAMERA_POS.z * side);
    camera.lookAt(CAMERA_TARGET.x * side, CAMERA_TARGET.y, CAMERA_TARGET.z * side);
  }
}
