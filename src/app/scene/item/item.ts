import {
  Component,
  OnDestroy,
  afterNextRender,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import {
  Box3,
  BufferGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
} from 'three';
import { RoomService } from '../../room/room.service';
import { AssetLoaderService } from '../asset-loader.service';
import { CardInteractions } from '../card/card-interactions';
import { CardStore } from '../card/card-store';
import { ITEM_MODEL_URLS } from '../scene-assets';
import { SceneGraph } from '../scene-graph';
import {
  COIN_RADIUS,
  COUNTER_RADIUS,
  DIE_RADIUS,
  ValueCanvas,
  counterFaceCount,
  counterFaceSlot,
  dieColorHex,
  makeCoinGeometry,
  makeCoinTextures,
  makeCounterGeometry,
  makeCounterTexture,
  makeD6PipTextures,
  makeDiceGeometry,
  makeValueCanvas,
  restLift,
} from './item-geometry';
import { DIE_FACES, DiceKind, ItemKind, ItemState, isDice } from './item.types';

/** Slight white tint (emissive) applied while hovered, matching cards. */
const HOVER_TINT = 0x333333;
/** Roll animation length — the design doc's 1.5 s lerp across every euler. */
const ROLL_MS = 1500;
/** Coin flip: a shorter hop, since it also has to land. */
const FLIP_MS = 1200;
/**
 * Peak of the coin's hop. The design doc says +2, which was written for a
 * different scale — on this table a card is 0.32 m across, so 0.5 m is the same
 * gesture: clearly airborne, still on screen under the overhead camera.
 */
const FLIP_HOP = 0.5;
/**
 * How often the label of a tumbling polyhedron shows a different number. The
 * die's result is decided the moment it is rolled (it has to be — it is shared
 * state), but showing it for the whole 1.5 s tumble gives the throw away, so
 * the label cycles random in-range numbers until the die settles
 * (newmechanics.md "dice objects").
 */
const SCRAMBLE_MS = 70;
/** Placeholder body colours per kind. */
const COIN_EDGE_COLOR = 0xb99442;

/** Largest dimension a registered GLB is normalised to, matching the placeholder. */
function modelTargetSize(kind: ItemKind): number {
  if (kind === 'coin') return COIN_RADIUS * 2;
  if (kind === 'counter') return COUNTER_RADIUS * 2;
  return DIE_RADIUS * 2;
}

/**
 * A single table item — die, coin or counter — rendering the ItemState it
 * receives from the Scene's `@for` over ItemStore. Renders no DOM: it builds
 * (or clones, if a model is registered in ITEM_MODEL_URLS) a body, mounts it
 * into the SceneGraph, and registers with CardInteractions for raycast picking,
 * exactly like `Card`.
 *
 * The object is three nested nodes: a wrapper at the item's world position, a
 * pivot lifted so the body rests on the surface (and hops when a coin flips),
 * and the body itself, which is what a roll rotates. A counter attached to a
 * card stores its position as an offset and follows that card around the table.
 */
@Component({
  selector: 'app-item',
  templateUrl: './item.html',
  standalone: true,
})
export class Item implements OnDestroy {
  readonly state = input.required<ItemState>();

  private readonly assets = inject(AssetLoaderService);
  private readonly graph = inject(SceneGraph);
  private readonly interactions = inject(CardInteractions);
  private readonly cards = inject(CardStore);
  private readonly room = inject(RoomService);

  private wrapper?: Group;
  private pivot?: Group;
  private body?: Object3D;
  private label?: Sprite;
  /** Repaintable canvas behind the label, and the texture uploading it. */
  private labelCanvas?: ValueCanvas;
  private labelTexture?: CanvasTexture;
  /** Faces of this die — the range the label scrambles through while it rolls. */
  private faces = 0;
  private lift = 0;
  /** Everything this instance owns and must dispose (shared caches are never ours). */
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly textures: Texture[] = [];
  /** The redrawn counter face / die label, replaced whenever the value changes. */
  private valueTexture?: Texture;
  /** Rotation the body is travelling toward, and the animation doing it. */
  private target: [number, number, number] = [0, 0, 0];
  private animation: {
    from: [number, number, number];
    to: [number, number, number];
    start: number;
    duration: number;
    hop: number;
    /** Cycle random numbers on the label while this one runs (a die roll). */
    scramble: boolean;
    /** When the scrambled number was last redrawn. */
    lastScramble: number;
  } | null = null;
  private frameId = 0;
  private appliedValue?: number;
  private destroyed = false;

  constructor() {
    // Not in the constructor body itself: spawn() reads the required `state`
    // input synchronously, which is only bound after construction (NG0950).
    afterNextRender(() => void this.spawn());
    // Position: world, or an offset from the card a counter is attached to.
    effect(() => {
      const { position, attachedTo } = this.state();
      const anchor = attachedTo ? this.cards.card(attachedTo)?.position : undefined;
      this.applyPosition(position, anchor);
    });
    effect(() => {
      this.animateTo(this.state().rotation);
    });
    effect(() => {
      const { value, variant, kind, color } = this.state();
      if (value !== this.appliedValue) this.applyValue(value, variant, kind, color);
    });
    effect(() => {
      const hovered = this.interactions.hoveredId() === this.state().id;
      for (const material of this.materials) {
        material.emissive.setHex(hovered ? HOVER_TINT : 0x000000);
      }
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frameId);
    this.interactions.unregister(untracked(this.state).id);
    if (this.wrapper) this.graph.root.remove(this.wrapper);
    for (const material of this.materials) material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const texture of this.textures) texture.dispose();
    this.valueTexture?.dispose();
    this.labelTexture?.dispose();
    if (this.label) (this.label.material as SpriteMaterial | undefined)?.dispose();
  }

  private async spawn(): Promise<void> {
    const state = untracked(this.state);
    this.lift = restLift(state.kind);
    const wrapper = new Group();
    const pivot = new Group();
    pivot.position.y = this.lift;
    // A counter's printed value should read right way up from wherever the
    // viewer is sitting (finaltouches.md "counter"). This turn is deliberately
    // *local* — not in the shared ItemState — so each player reads it from
    // their own end of the table. Both counter bodies are symmetric about their
    // axis, so nothing but the text moves. Dice and coins are left alone: they
    // have no text to face and a roll must look the same to everyone.
    if (untracked(this.state).kind === 'counter') pivot.rotation.y = this.room.seatYaw();
    wrapper.add(pivot);
    this.wrapper = wrapper;
    this.pivot = pivot;

    this.body = await this.buildBody(state);
    if (this.destroyed) return;
    pivot.add(this.body);
    this.body.rotation.set(...state.rotation);
    this.target = [...state.rotation];

    if (isDice(state.kind) && state.kind !== 'd6') {
      // A placeholder polyhedron has no readable faces, so the rolled number
      // rides above it on a label instead (the d6 shows real pips). The canvas
      // is kept and repainted so a rolling die can cycle numbers cheaply.
      this.faces = DIE_FACES[state.kind as DiceKind];
      this.labelCanvas = makeValueCanvas();
      this.labelTexture = new CanvasTexture(this.labelCanvas.canvas);
      this.label = new Sprite(
        new SpriteMaterial({ map: this.labelTexture, depthTest: false, transparent: true }),
      );
      this.label.position.y = this.lift + 0.16;
      this.label.scale.setScalar(0.14);
      wrapper.add(this.label);
    }
    this.applyValue(state.value, state.variant, state.kind, state.color);

    const anchor = state.attachedTo
      ? untracked(() => this.cards.card(state.attachedTo!)?.position)
      : undefined;
    this.applyPosition(state.position, anchor);
    this.graph.root.add(wrapper);
    this.interactions.register(state.id, wrapper);
  }

  /** The registered model for this kind, else the procedural placeholder. */
  private async buildBody(state: ItemState): Promise<Object3D> {
    const url = ITEM_MODEL_URLS[state.kind];
    if (url) {
      try {
        const model = (await this.assets.load(url)).clone();
        this.claimMaterials(model);
        // An authored die still wears the player's chosen colour, so a green
        // set is green whether or not a GLB happens to exist for that kind.
        if (isDice(state.kind)) this.tintDice(state.color);
        this.normalizeModel(model, state.kind);
        return model;
      } catch (err) {
        console.warn(`[item] Model ${url} unavailable, using the placeholder.`, err);
      }
    }
    return this.buildPlaceholder(state);
  }

  /**
   * Fit a registered model to the placeholder's size and resting pose whatever
   * scale or origin it was authored at: uniformly scaled so its largest
   * dimension matches the placeholder's, centred on its bounding box (rolls
   * tumble about the middle), with the pivot lift recomputed so it rests on
   * the surface. The provided d4.glb, for instance, is authored ~1.7 m wide —
   * raw, it dwarfed the table (stabilityandimprovements.md "items").
   */
  private normalizeModel(model: Object3D, kind: ItemKind): void {
    const box = new Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const size = box.getSize(new Vector3());
    const largest = Math.max(size.x, size.y, size.z);
    if (largest <= 0) return;
    const scale = modelTargetSize(kind) / largest;
    model.scale.multiplyScalar(scale);
    model.position.sub(box.getCenter(new Vector3()).multiplyScalar(scale));
    this.lift = (size.y * scale) / 2;
    if (this.pivot) this.pivot.position.y = this.lift;
  }

  private buildPlaceholder(state: ItemState): Object3D {
    if (state.kind === 'coin') {
      const geometry = makeCoinGeometry();
      const [heads, tails] = makeCoinTextures();
      this.geometries.push(geometry);
      this.textures.push(heads, tails);
      // CylinderGeometry material order: side, top (+Y = heads), bottom.
      const materials = [
        this.own(new MeshStandardMaterial({ color: COIN_EDGE_COLOR, roughness: 0.4 })),
        this.own(new MeshStandardMaterial({ map: heads, roughness: 0.5 })),
        this.own(new MeshStandardMaterial({ map: tails, roughness: 0.5 })),
      ];
      return new Mesh(geometry, materials);
    }
    if (state.kind === 'counter') {
      // A disc for ±1/±1, a squared tile for the x counter — the printed face
      // sits on a different material slot on each (newmechanics.md "counter").
      const geometry = makeCounterGeometry(state.variant);
      this.geometries.push(geometry);
      const face = this.own(new MeshStandardMaterial({ roughness: 0.6 }));
      const side = this.own(new MeshStandardMaterial({ color: 0x1b1b24, roughness: 0.8 }));
      const slot = counterFaceSlot(state.variant);
      const materials = Array.from({ length: counterFaceCount(state.variant) }, (_, i) =>
        i === slot ? face : side,
      );
      return new Mesh(geometry, materials);
    }
    const geometry = makeDiceGeometry(state.kind);
    this.geometries.push(geometry);
    if (state.kind === 'd6') {
      const pips = makeD6PipTextures(state.color);
      this.textures.push(...pips);
      return new Mesh(
        geometry,
        pips.map((map) => this.own(new MeshStandardMaterial({ map, roughness: 0.5 }))),
      );
    }
    return new Mesh(
      geometry,
      this.own(
        new MeshStandardMaterial({
          color: dieColorHex(state.color),
          roughness: 0.5,
          flatShading: true,
        }),
      ),
    );
  }

  /**
   * Paint a loaded die model in its colour. Only untextured materials are
   * touched — a model that came with its own artwork keeps it rather than
   * having the colour multiplied into every texel.
   */
  private tintDice(color: ItemState['color']): void {
    for (const material of this.materials) {
      if (!material.map) material.color.setHex(dieColorHex(color));
    }
  }

  /** Track a material as ours (hover tints it, destroy disposes it). */
  private own(material: MeshStandardMaterial): MeshStandardMaterial {
    this.materials.push(material);
    return material;
  }

  /** Give a loaded model per-instance materials, like Card does. */
  private claimMaterials(node: Object3D): void {
    node.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      const owned = materials.map((m) => {
        const clone = this.own((m as MeshStandardMaterial).clone());
        // A glTF primitive with no material gets the spec default: white at
        // FULL metalness — which renders near-black without an environment
        // map (the invisible d4). Treat such untextured full-metal surfaces
        // as plain matte instead.
        if (clone.metalness === 1 && !clone.metalnessMap) clone.metalness = 0.1;
        return clone;
      });
      obj.material = Array.isArray(obj.material) ? owned : owned[0]!;
    });
  }

  private applyPosition(
    position: [number, number, number],
    anchor: [number, number, number] | undefined,
  ): void {
    if (!this.wrapper) return;
    if (anchor) {
      this.wrapper.position.set(
        anchor[0] + position[0],
        anchor[1] + position[1],
        anchor[2] + position[2],
      );
    } else {
      this.wrapper.position.set(...position);
    }
  }

  /** Start (or skip) the tumble toward a new rotation. */
  private animateTo(rotation: [number, number, number]): void {
    if (!this.body) return;
    if (
      rotation[0] === this.target[0] &&
      rotation[1] === this.target[1] &&
      rotation[2] === this.target[2]
    ) {
      return; // unchanged — a position or value write, not a roll
    }
    const from: [number, number, number] = [
      this.body.rotation.x,
      this.body.rotation.y,
      this.body.rotation.z,
    ];
    this.target = [...rotation];
    const coin = untracked(this.state).kind === 'coin';
    this.animation = {
      from,
      to: [...rotation],
      start: performance.now(),
      duration: coin ? FLIP_MS : ROLL_MS,
      hop: coin ? FLIP_HOP : 0,
      // A rotation change on a labelled die is a roll: cycle its number.
      scramble: !!this.label,
      lastScramble: 0,
    };
    cancelAnimationFrame(this.frameId);
    this.frameId = requestAnimationFrame(this.tick);
  }

  /** Lerp every euler toward the target (no physics — see additionalitems.md). */
  private readonly tick = (now: number): void => {
    const animation = this.animation;
    if (!animation || !this.body || !this.pivot) return;
    const t = Math.min(1, (now - animation.start) / animation.duration);
    this.body.rotation.set(
      animation.from[0] + (animation.to[0] - animation.from[0]) * t,
      animation.from[1] + (animation.to[1] - animation.from[1]) * t,
      animation.from[2] + (animation.to[2] - animation.from[2]) * t,
    );
    // A coin arcs up and back down over the same span.
    this.pivot.position.y = this.lift + animation.hop * Math.sin(Math.PI * t);
    if (t < 1) {
      if (animation.scramble && now - animation.lastScramble >= SCRAMBLE_MS) {
        animation.lastScramble = now;
        this.drawLabel(1 + Math.floor(Math.random() * this.faces));
      }
      this.frameId = requestAnimationFrame(this.tick);
      return;
    }
    this.animation = null;
    this.pivot.position.y = this.lift;
    // Landed: the die "decides" — show the value that was rolled.
    if (animation.scramble) this.drawLabel(untracked(this.state).value);
  };

  /** Repaint the floating label with a number (the roll's result, or a
   * scrambled one while it is still tumbling). */
  private drawLabel(value: number): void {
    if (!this.labelCanvas || !this.labelTexture) return;
    this.labelCanvas.draw(value, untracked(this.state).color);
    this.labelTexture.needsUpdate = true;
  }

  /**
   * Repaint whatever shows the item's value: a counter's face, or the label
   * floating over a polyhedral die. A counter's drawing is disposed as it is
   * replaced, so clicking one repeatedly never piles up textures; the die's
   * label owns one canvas for its lifetime and simply re-uploads it.
   */
  private applyValue(
    value: number,
    variant: ItemState['variant'],
    kind: ItemState['kind'],
    color: ItemState['color'],
  ): void {
    this.appliedValue = value;
    if (kind === 'counter') {
      const material = this.counterFaceMaterial(variant);
      if (!material) return;
      this.valueTexture?.dispose();
      this.valueTexture = makeCounterTexture(value, variant);
      material.map = this.valueTexture;
      material.needsUpdate = true;
      return;
    }
    if (!this.labelCanvas || !this.labelTexture) return;
    // A roll in flight owns the label until it lands (see `tick`).
    if (this.animation?.scramble) return;
    this.labelCanvas.draw(value, color);
    this.labelTexture.needsUpdate = true;
  }

  /** The counter's printed face — the cylinder's top cap, or the box's +Y side. */
  private counterFaceMaterial(variant: ItemState['variant']): MeshStandardMaterial | undefined {
    const mesh = this.body;
    if (!(mesh instanceof Mesh) || !Array.isArray(mesh.material)) return undefined;
    return mesh.material[counterFaceSlot(variant)] as MeshStandardMaterial | undefined;
  }
}
