import { AfterViewInit, Component, ElementRef, OnDestroy, inject, viewChild } from '@angular/core';
import {
  BufferAttribute,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
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
import { applyTextureSet } from './environment-material';
import { Item } from './item/item';
import { ItemStore } from './item/item-store';
import {
  ENVIRONMENT_ASSETS,
  TABLE_DEPTH,
  TABLE_MATERIAL,
  TABLE_WIDTH,
  TABLE_Y,
} from './scene-assets';
import { SceneCamera } from './scene-camera';
import { SceneGraph } from './scene-graph';
import { UtilWindow } from './util-window/util-window';

/**
 * Tavern lighting (textures.md): warm throughout, as if the room were lit by
 * fire rather than daylight.
 *
 * The ambient is a hemisphere — amber from above, a dark warm bounce from the
 * floorboards below — so nothing on the table is ever black and nothing reads
 * cold. The overhead fill is deliberately weak: it exists to keep the tabletop's
 * normal map from flattening out, while the two torches do the shaping.
 *
 * The tints are gentler than "firelight" sounds, and that is deliberate. Three
 * shades diffuse as `albedo / π × irradiance`, and the plank texture is already
 * a deep brown (its average is #562a07 — barely any blue left), so a saturated
 * light multiplied into it crushes the remaining green and blue and the table
 * comes out a flat orange silhouette. Only the torches are properly fire-
 * coloured; the ambient and fill stay near white, and the warmth reads anyway.
 *
 * The intensities together put roughly π of irradiance on the tabletop, which is
 * the amount at which a surface renders as its own base colour: the middle of
 * the table lands on #542103 against that #562a07 texture — the same wood, a
 * shade deeper and warmer — while the near edge reaches #5e2404. Sitting on that
 * mark also keeps the headroom the renderer needs: it runs with no tone mapping
 * so card art (drawn emissive at full strength, see card.ts) matches the same
 * image shown in the DOM, which means bright lit surfaces clip instead of
 * rolling off. The brightest one in the app — a card model with no art on it,
 * at the hottest spot on the table — peaks just under white.
 */
const BACKGROUND = 0x140e09;
const AMBIENT_SKY = 0xffe9d2;
const AMBIENT_GROUND = 0x3a2a1e;
const AMBIENT_INTENSITY = 1.35;
const FILL_COLOR = 0xfff0e0;
const FILL_INTENSITY = 0.9;

/**
 * Two torches bracketing the table. They are lights only (nothing to see), so the
 * camera's pan and zoom cannot frame them. The table is 7 × 10 m (TABLE_WIDTH ×
 * TABLE_DEPTH); at x = ±9, y = 2.6 their inverse-square falloff still rakes
 * across it as it did across the old 4 × 6 m one. Summing ambient + fill +
 * torches (with the cosine term) at tabletop height gives ≈3.0 at the centre,
 * ≈3.7 at the long edges and ≈2.8 at the short ends, against 3.0 / 3.6 / 2.8
 * before: a gradient you read as firelight rather than as two spotlights.
 *
 * The intensity is in Three's physical units — candela against the default
 * `decay = 2` — so it buys about `140 / d²` at the table, not the ~1 an ambient
 * light means by the same number. It is also the one value here with a ceiling:
 * much more and the near edge starts clipping lit props (see above).
 */
const TORCH_COLOR = 0xffa15a;
const TORCH_INTENSITY = 140;
const TORCH_X = 9;
const TORCH_Y = 2.6;
/** Fire, not a lamp: a slow ±8% wobble, out of phase between the two torches. */
const FLICKER_AMOUNT = 0.08;

/** Two incommensurate sines: no visible repeat, no allocation, roughly ±1. */
function flicker(seconds: number, phase: number): number {
  return 0.6 * Math.sin(seconds * 5.7 + phase) + 0.4 * Math.sin(seconds * 9.1 + phase * 1.7);
}

/** The card table view: environment GLBs + card objects projected from the
 * room's shared world state, seen from a fixed camera (posed by CameraRig).
 * Picking, moving, and the context menus are handled by
 * CardInteractions + CardOverlay; the zone UI (hand/deck/graveyard) and the
 * add-to-game util window are DOM overlays rendered on top of the canvas. */
@Component({
  selector: 'app-scene',
  imports: [Card, CardOverlay, CameraRig, Item, UtilWindow, Zones],
  templateUrl: './scene.html',
  styleUrl: './scene.scss',
  standalone: true,
  providers: [SceneGraph, SceneCamera, CardStore, CardInteractions],
})
export class Scene implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly assets = inject(AssetLoaderService);
  protected readonly cards = inject(CardStore).cards;
  protected readonly items = inject(ItemStore).items;
  private readonly graph = inject(SceneGraph);
  private readonly sceneCamera = inject(SceneCamera);
  private readonly camera = this.sceneCamera.camera;
  private readonly interactions = inject(CardInteractions);

  private renderer?: WebGLRenderer;
  private scene?: ThreeScene;
  private torches: PointLight[] = [];
  private frameId = 0;
  private resizeObserver?: ResizeObserver;
  private destroyed = false;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;

    this.scene = new ThreeScene();
    this.scene.background = new Color(BACKGROUND);
    this.scene.add(this.graph.root); // objects contributed by child components (cards, …)

    this.scene.add(new HemisphereLight(AMBIENT_SKY, AMBIENT_GROUND, AMBIENT_INTENSITY));
    const fill = new DirectionalLight(FILL_COLOR, FILL_INTENSITY);
    fill.position.set(2, 7, 3);
    this.scene.add(fill);
    this.torches = [-1, 1].map((side) => {
      const torch = new PointLight(TORCH_COLOR, TORCH_INTENSITY); // default decay 2, unbounded
      torch.position.set(TORCH_X * side, TORCH_Y, 0);
      this.scene!.add(torch);
      return torch;
    });

    // Placeholder floor, swapped for the authored environment once loaded.
    // Dark boards rather than the old blue-grey, so the fallback belongs to the
    // same room as the lighting above.
    const floor = new Mesh(
      new PlaneGeometry(40, 40),
      new MeshStandardMaterial({ color: 0x2a1d13, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    this.interactions.addSurface(floor);
    this.addTable();
    void this.loadEnvironment(floor);
    this.interactions.attach(canvas);
    this.sceneCamera.attach(canvas);

    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    const animate = () => {
      this.frameId = requestAnimationFrame(animate);
      this.flickerTorches();
      this.renderer!.render(this.scene!, this.camera);
    };
    animate();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.interactions.detach();
    this.sceneCamera.detach();
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.renderer?.dispose();
  }

  /** The torches burn rather than glow — a small wobble around their intensity. */
  private flickerTorches(): void {
    const seconds = performance.now() / 1000;
    for (const [i, torch] of this.torches.entries()) {
      torch.intensity = TORCH_INTENSITY * (1 + FLICKER_AMOUNT * flicker(seconds, i * 2.1));
    }
  }

  /**
   * The table: a flat plane at TABLE_Y wearing the plank texture. Its UVs are
   * scaled to a square so the tile is not stretched on the 7 × 10 m rectangle and
   * `tileRepeat` (environment-material.ts) measures the right metres per tile.
   */
  private addTable(): void {
    const geometry = new PlaneGeometry(TABLE_WIDTH, TABLE_DEPTH);
    const uv = geometry.getAttribute('uv') as BufferAttribute;
    const side = Math.sqrt(TABLE_WIDTH * TABLE_DEPTH);
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(
        i,
        ((uv.getX(i) - 0.5) * TABLE_WIDTH) / side + 0.5,
        ((uv.getY(i) - 0.5) * TABLE_DEPTH) / side + 0.5,
      );
    }
    const table = new Mesh(geometry, new MeshStandardMaterial({ color: 0x562a07, roughness: 1 }));
    table.rotation.x = -Math.PI / 2;
    table.position.y = TABLE_Y;
    this.scene!.add(table);
    this.interactions.addSurface(table);
    table.updateMatrixWorld(true);
    void applyTextureSet(table, TABLE_MATERIAL, this.assets).catch((err: unknown) => {
      console.warn('[scene] Table textures unavailable, keeping plain material.', err);
    });
  }

  /** Add the authored environment GLBs (if any are registered); the dark floor stays as the fallback surface. */
  private async loadEnvironment(placeholderFloor: Mesh): Promise<void> {
    if (ENVIRONMENT_ASSETS.length === 0) return;
    try {
      const groups = await this.assets.loadAll(ENVIRONMENT_ASSETS.map((a) => a.url));
      if (this.destroyed || !this.scene) return;
      this.scene.remove(placeholderFloor);
      this.assets.dispose(placeholderFloor);
      this.interactions.removeSurface(placeholderFloor);
      for (const [i, group] of groups.entries()) {
        this.scene.add(group); // authored positions: 1u = 1m, Y-up
        this.interactions.addSurface(group); // cards can be placed on the environment
        // Dressing the model is deliberately not awaited: the table is usable,
        // wearing its authored material, while its maps download.
        const material = ENVIRONMENT_ASSETS[i]?.material;
        if (material) {
          void applyTextureSet(group, material, this.assets).catch((err: unknown) => {
            console.warn('[scene] Environment textures unavailable, keeping model material.', err);
          });
        }
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
    // Orthographic: the vertical world extent is fixed, so a wider viewport
    // reveals more table instead of scaling the cards down.
    this.sceneCamera.setAspect(width / height);
  }
}
