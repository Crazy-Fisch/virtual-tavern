import { AfterViewInit, Component, ElementRef, OnDestroy, inject, viewChild } from '@angular/core';
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene as ThreeScene,
  WebGLRenderer,
} from 'three';
import { Zones } from '../zones/zones';
import { AssetLoaderService } from './asset-loader.service';
import { CameraRig } from './camera-rig/camera-rig';
import { Card } from './card/card';
import { CardInteractions } from './card/card-interactions';
import { CardOverlay } from './card/card-overlay/card-overlay';
import { CardStore } from './card/card-store';
import { ENVIRONMENT_ASSETS } from './scene-assets';
import { SceneCamera } from './scene-camera';
import { SceneGraph } from './scene-graph';
import { UtilWindow } from './util-window/util-window';

/** The card table view: environment GLBs + card objects projected from the
 * room's shared world state, seen from a fixed camera (posed and subtly
 * panned by CameraRig). Picking, moving, and the context menus are handled by
 * CardInteractions + CardOverlay; the zone UI (hand/deck/graveyard) and the
 * add-to-game util window are DOM overlays rendered on top of the canvas. */
@Component({
  selector: 'app-scene',
  imports: [Card, CardOverlay, CameraRig, UtilWindow, Zones],
  templateUrl: './scene.html',
  styleUrl: './scene.scss',
  standalone: true,
  providers: [SceneGraph, SceneCamera, CardStore, CardInteractions],
})
export class Scene implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly assets = inject(AssetLoaderService);
  protected readonly cards = inject(CardStore).cards;
  private readonly graph = inject(SceneGraph);
  private readonly camera = inject(SceneCamera).camera;
  private readonly interactions = inject(CardInteractions);

  private renderer?: WebGLRenderer;
  private scene?: ThreeScene;
  private frameId = 0;
  private resizeObserver?: ResizeObserver;
  private destroyed = false;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;

    this.scene = new ThreeScene();
    this.scene.background = new Color(0x12121a);
    this.scene.add(this.graph.root); // objects contributed by child components (cards, …)

    this.scene.add(new HemisphereLight(0xffffff, 0x202028, 1.2));
    const key = new DirectionalLight(0xffffff, 1.4);
    key.position.set(5, 8, 4);
    this.scene.add(key);

    // Placeholder floor, swapped for the authored environment once loaded.
    const floor = new Mesh(
      new PlaneGeometry(40, 40),
      new MeshStandardMaterial({ color: 0x2a2a36, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    this.interactions.addSurface(floor);
    void this.loadEnvironment(floor);
    this.interactions.attach(canvas);

    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    const animate = () => {
      this.frameId = requestAnimationFrame(animate);
      this.renderer!.render(this.scene!, this.camera);
    };
    animate();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.interactions.detach();
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.renderer?.dispose();
  }

  /** Swap the placeholder floor for the authored environment once its GLBs are loaded. */
  private async loadEnvironment(placeholderFloor: Mesh): Promise<void> {
    try {
      const groups = await this.assets.loadAll(ENVIRONMENT_ASSETS.map((a) => a.url));
      if (this.destroyed || !this.scene) return;
      this.scene.remove(placeholderFloor);
      this.assets.dispose(placeholderFloor);
      this.interactions.removeSurface(placeholderFloor);
      for (const group of groups) {
        this.scene.add(group); // authored positions: 1u = 1m, Y-up
        this.interactions.addSurface(group); // cards can be placed on the environment
      }
    } catch (err) {
      console.warn('[scene] Environment models unavailable, keeping placeholder floor.', err);
    }
  }

  private resize(): void {
    if (!this.renderer) return;
    const canvas = this.canvasRef().nativeElement;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
