import { Component, inject } from '@angular/core';
import { Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { TABLE_Y } from '../scene-assets';
import { SceneCamera } from '../scene-camera';

/**
 * Camera base pose: a bird's-eye view ~26° off vertical from the player's
 * table end (+Z for the room owner), looking down at the tabletop (TABLE_Y).
 * The camera is orthographic (see SceneCamera), so this distance only decides
 * clipping, never the on-screen size of anything — how much table is framed is
 * SceneCamera's VIEW_HEIGHT. Non-owners get the pose mirrored to the −Z end.
 */
const CAMERA_TARGET = new Vector3(0, TABLE_Y, 1);
const CAMERA_OFFSET = new Vector3(0, 5.8, 2.5);

/**
 * Seats the SceneCamera: hands it the base pose above, mirrored for the player's
 * table end. Panning, zooming and recentering are SceneCamera's (middle-drag,
 * wheel, hotkey); the base pose is what recentering returns to. The former slight
 * pan toward the mouse near screen edges stays removed (stabilityandimprovements.md
 * "camera movement"). Renders no DOM.
 */
@Component({
  selector: 'app-camera-rig',
  templateUrl: './camera-rig.html',
  standalone: true,
})
export class CameraRig {
  constructor() {
    // The room owner sits at +Z; everyone else at the mirrored −Z table end
    // (seating is fixed for the stay in the room — set once on mount).
    const side = inject(RoomService).isRoomOwner() ? 1 : -1;
    const target = new Vector3(CAMERA_TARGET.x * side, CAMERA_TARGET.y, CAMERA_TARGET.z * side);
    const position = new Vector3(
      target.x + CAMERA_OFFSET.x * side,
      target.y + CAMERA_OFFSET.y,
      target.z + CAMERA_OFFSET.z * side,
    );
    inject(SceneCamera).setBasePose(position, target);
  }
}
