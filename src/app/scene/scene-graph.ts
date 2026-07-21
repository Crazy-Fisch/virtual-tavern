import { Injectable } from '@angular/core';
import { Group } from 'three';

/**
 * Bridge letting Angular components (e.g. Card) contribute objects to the
 * Three.js scene without referencing the Scene component. Provided BY the Scene
 * component, which adds `root` to its Three scene on init — children added here
 * before that moment appear as soon as the scene mounts.
 */
@Injectable()
export class SceneGraph {
  readonly root = new Group();
}
