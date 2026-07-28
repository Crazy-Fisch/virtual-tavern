import { Component, OnDestroy, effect, inject, input, untracked } from '@angular/core';
import { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { AssetLoaderService } from '../asset-loader.service';
import { CARD_MODEL_URL } from '../scene-assets';
import { SceneGraph } from '../scene-graph';
import { CardInteractions } from './card-interactions';
import { CardState } from './card.types';

const HALF_PI = Math.PI / 2;
/** Slight white tint (emissive) applied to a card's non-art materials while hovered. */
const HOVER_TINT = 0x333333;
/**
 * The front (art) face is self-lit from its texture (emissiveMap at this
 * intensity), so a card on the table reads at the same full brightness as the
 * same art shown in the DOM (hand/ghost/deck screens) instead of the dimmer,
 * light-dependent look a plain lit material gives (playerui.md "card material").
 * Hover nudges it a little brighter rather than tinting, keeping the colours true.
 */
const FRONT_EMISSIVE = 1;
const FRONT_EMISSIVE_HOVER = 1.28;
/**
 * Card.glb is authored at 10× a real card (0.635 × 0.889 m). 0.5 brings a card
 * down to 0.32 × 0.44 m — well above true proportion, chosen for readability on
 * the (oversized, 4 × 6 m) table under the fixed orthographic camera, where it
 * works out to roughly 82 × 114 CSS px on a 1080p screen.
 */
const CARD_SCALE = 0.5;

/**
 * A single playing card in the 3D scene, rendering the CardState it receives
 * from the Scene's @for over CardStore. Renders no DOM — it clones the shared
 * card model, textures its front face (the material named like "front" or
 * "artwork") with the state's src, mounts itself into the SceneGraph, and
 * registers with CardInteractions for raycast picking. Pose follows the state:
 * position, yaw about world-up, and faceUp (flip = the card turned over).
 */
@Component({
  selector: 'app-card',
  templateUrl: './card.html',
  standalone: true,
})
export class Card implements OnDestroy {
  readonly state = input.required<CardState>();

  private readonly assets = inject(AssetLoaderService);
  private readonly graph = inject(SceneGraph);
  private readonly interactions = inject(CardInteractions);

  private instance?: Group;
  private frontMaterial?: MeshStandardMaterial;
  /** Per-instance clones of every material, so hover can tint the whole mesh. */
  private ownedMaterials: MeshStandardMaterial[] = [];
  private appliedSrc?: string;
  private destroyed = false;

  constructor() {
    void this.spawn();
    // React to later state changes; initial values are applied by spawn().
    effect(() => {
      const src = this.state().src;
      if (this.frontMaterial && src !== this.appliedSrc) void this.applyImage(src);
    });
    effect(() => {
      const { position, yaw, faceUp, tapped } = this.state();
      this.applyPose(position, yaw, faceUp, tapped);
    });
    // Selected cards wear the hover highlight too, so a marquee selection reads
    // at a glance (cardselection.md).
    effect(() => {
      const id = this.state().id;
      this.applyHover(this.interactions.hoveredId() === id || this.interactions.isSelected(id));
    });
    // While a DOM "ghost" stands in for this card (a lone card being dragged),
    // hide its 3D instance: the ghost follows the cursor on top of everything,
    // so the dragged card never disappears behind the hand or pile UI. A whole
    // selection being dragged has no ghost and stays visible in the scene.
    // Local-only — remote players never receive the drag preview.
    effect(() => {
      const ghosted = this.interactions.dragGhost()?.id === this.state().id;
      if (this.instance) this.instance.visible = !ghosted;
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.interactions.unregister(untracked(this.state).id);
    if (this.instance) this.graph.root.remove(this.instance);
    // Only this instance's cloned materials are ours; geometry and textures
    // stay shared with the loader cache.
    for (const material of this.ownedMaterials) material.dispose();
  }

  private async spawn(): Promise<void> {
    try {
      const model = await this.assets.load(CARD_MODEL_URL);
      if (this.destroyed) return;

      const clone = model.clone();
      const front = this.findFrontMesh(clone);
      if (!front) return;
      // The front mesh's node carries the authored transform and its back/side
      // siblings; using it (not the whole file) drops any stray extra meshes.
      const cardNode = front.parent && front.parent !== clone ? front.parent : front;
      this.claimMaterials(cardNode);

      const wrapper = new Group();
      wrapper.add(cardNode);
      wrapper.scale.setScalar(CARD_SCALE);
      this.instance = wrapper;
      const state = untracked(this.state);
      // A card spawned already mid-drag (played from the hand) shows as the DOM
      // ghost, not here, until the drop lands.
      wrapper.visible = untracked(this.interactions.dragGhost)?.id !== state.id;
      this.applyPose(state.position, state.yaw, state.faceUp, state.tapped);
      this.graph.root.add(wrapper);
      this.interactions.register(state.id, wrapper);
      this.applyHover(untracked(this.interactions.hoveredId) === state.id);

      await this.applyImage(state.src);
    } catch (err) {
      console.warn('[card] Card model unavailable.', err);
    }
  }

  private applyPose(
    position: [number, number, number],
    yaw: number,
    faceUp: boolean,
    tapped: boolean,
  ): void {
    if (!this.instance) return;
    this.instance.position.set(...position);
    // 'YXZ': yaw about world-up first (tapped adds a clockwise quarter turn),
    // then lie flat — face up or turned over.
    const spin = yaw + (tapped ? -HALF_PI : 0);
    this.instance.rotation.set(faceUp ? -HALF_PI : HALF_PI, spin, 0, 'YXZ');
  }

  private applyHover(hovered: boolean): void {
    for (const material of this.ownedMaterials) {
      // The art face carries its texture in `emissive`/`emissiveMap` (see
      // applyImage), so tinting would recolour the art — brighten it instead.
      if (material === this.frontMaterial && material.emissiveMap) {
        material.emissiveIntensity = hovered ? FRONT_EMISSIVE_HOVER : FRONT_EMISSIVE;
      } else {
        material.emissive.setHex(hovered ? HOVER_TINT : 0x000000);
      }
    }
  }

  /** The mesh whose material is named like the card front. */
  private findFrontMesh(root: Object3D): Mesh | null {
    let found: Mesh | null = null;
    const seen: string[] = [];
    root.traverse((obj) => {
      if (found || !(obj instanceof Mesh)) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      seen.push(...materials.map((m) => m.name));
      if (materials.some((m) => /front|artwork/i.test(m.name))) found = obj;
    });
    if (!found) {
      console.warn(
        `[card] No front-face material (matching /front|artwork/i) in ${CARD_MODEL_URL}; materials found:`,
        seen,
      );
    }
    return found;
  }

  /** Give this instance its own copy of every material under the card node. */
  private claimMaterials(node: Object3D): void {
    node.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      const owned = materials.map((m) => {
        const clone = m.clone() as MeshStandardMaterial;
        // Z-fighting fix (option A): a small negative polygon offset biases the
        // card faces apart in the depth buffer, so cards laid coplanar next to
        // each other stop flickering — without moving any geometry, so stacking
        // and the "drop onto another card" ray are unaffected.
        clone.polygonOffset = true;
        clone.polygonOffsetFactor = -1;
        clone.polygonOffsetUnits = -1;
        this.ownedMaterials.push(clone);
        if (/front|artwork/i.test(m.name)) this.frontMaterial = clone;
        return clone;
      });
      obj.material = Array.isArray(obj.material) ? owned : owned[0]!;
    });
  }

  private async applyImage(url: string): Promise<void> {
    this.appliedSrc = url;
    if (!this.frontMaterial) return;
    if (!url) {
      // No art: fall back to a plainly lit face (no self-illumination).
      this.frontMaterial.map = null;
      this.frontMaterial.emissiveMap = null;
      this.frontMaterial.color.setHex(0xffffff);
      this.frontMaterial.emissive.setHex(0x000000);
      this.frontMaterial.emissiveIntensity = FRONT_EMISSIVE;
      this.frontMaterial.needsUpdate = true;
      return;
    }
    try {
      const texture = await this.assets.loadTexture(url);
      if (this.destroyed || !this.frontMaterial) return;
      // Show the art unlit at full brightness, like an HTML <img>: kill the
      // light-dependent diffuse (colour → black) and drive the face from the
      // texture as an emissive map.
      this.frontMaterial.map = texture;
      this.frontMaterial.emissiveMap = texture;
      this.frontMaterial.color.setHex(0x000000);
      this.frontMaterial.emissive.setHex(0xffffff);
      const id = untracked(this.state).id;
      const hovered =
        this.interactions.hoveredId() === id || this.interactions.isSelected(id);
      this.frontMaterial.emissiveIntensity = hovered ? FRONT_EMISSIVE_HOVER : FRONT_EMISSIVE;
      this.frontMaterial.needsUpdate = true;
    } catch (err) {
      console.warn(`[card] Could not load card image ${url}`, err);
    }
  }
}
