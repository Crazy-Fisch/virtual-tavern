import { Injectable } from '@angular/core';
import { PerspectiveCamera } from 'three';

/**
 * Bridge letting the CameraRig component drive the camera the Scene component
 * renders with, mirroring the SceneGraph pattern. Provided BY the Scene
 * component: the Scene renders through `camera` and keeps its aspect in sync
 * on resize; CameraRig positions and animates it.
 */
@Injectable()
export class SceneCamera {
  readonly camera = new PerspectiveCamera(60, 1, 0.1, 200);
}
