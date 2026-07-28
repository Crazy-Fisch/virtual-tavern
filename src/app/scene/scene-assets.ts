/**
 * Manifest of static environment models loaded when entering the tavern.
 * Add a GLB to `public/models/` and register it here — nothing else needed.
 *
 * Blender export convention (File → Export → glTF 2.0):
 * - Format: glTF Binary (.glb), compression OFF (no Draco)
 * - Transform: +Y Up (exporter default)
 * - Scale: 1 Blender unit = 1 meter; floor at Z=0 in Blender (= ground level
 *   in-app); origin at world origin — models are added at authored positions
 * - Mesh: Apply Modifiers ON; include Materials + Images (textures embed)
 * - The camera is fixed in front of the table looking at the origin (see
 *   CAMERA_POS in scene.ts), so author the table centered on the origin.
 */

export interface EnvironmentAsset {
  /** Path under public/, served from the site root. */
  readonly url: string;
}

/** Static environment models. Missing files fall back to the procedural floor. */
export const ENVIRONMENT_ASSETS: readonly EnvironmentAsset[] = [{ url: 'models/Table01.glb' }];

/**
 * The card model is NOT a static environment asset — it is instanced per card by
 * the `Card` component (src/app/scene/card/card.ts), which textures its front
 * face (material name matching /front|artwork/i) with a per-card image.
 */
export const CARD_MODEL_URL = 'models/Card.glb';

/**
 * Optional authored models for table items (dice, coins, counters), instanced
 * by the `Item` component. A kind with no entry here renders the procedural
 * placeholder from `item/item-geometry.ts` — which is every kind today, so no
 * missing-file requests are ever made. Drop e.g. `models/D20.glb` into
 * `public/models/` and add `d20: 'models/D20.glb'`: the item then spawns that
 * model instead, keeping its pose, animation and picking behaviour. Author it
 * centred on its own origin, sized in metres (a card is 0.32 × 0.44 m).
 */
export const ITEM_MODEL_URLS: Readonly<Partial<Record<string, string>>> = {"d4": 'models/d4.glb'};
