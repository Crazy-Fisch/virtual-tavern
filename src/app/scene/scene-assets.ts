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

/**
 * A PBR texture set that replaces a model's authored material (see
 * `environment-material.ts`). Paths are under public/, like the models.
 *
 * All maps are optional but `baseColor`; a missing one simply isn't requested.
 * There is deliberately no displacement/height entry — displacement is a
 * per-vertex offset, and these environment models are low-poly boxes with
 * nothing to displace, so the relief has to come from `normal` (which encodes
 * the same detail) instead.
 */
export interface PbrTextureSet {
  readonly baseColor: string;
  readonly normal?: string;
  readonly roughness?: string;
  readonly ao?: string;
  /**
   * How much of the model, in metres, one tile of the texture should cover. The
   * repeat is derived from this and the model's own UV scale, so it stays right
   * if the model is re-authored or re-unwrapped.
   */
  readonly tileMetres: number;
}

// const PLANK_FLOOR = 'textures/PlankFloor/Substance_Graph_';
const PLANK_FLOOR = 'textures/AIWood/WoodAI_';

/**
 * Substance's parquet wood, used for the tabletop (textures.md). One tile is
 * ~8 blocks across, so a 1.2 m tile puts a block at ~15 cm — fine parquetry
 * next to a 0.48 m card, and detailed enough to read under the fixed camera.
 */
const PLANK_WOOD: PbrTextureSet = {
  baseColor: `${PLANK_FLOOR}BaseColor.png`,
  // normal: `textures/PlankFloor/Substance_Graph_Normal.jpg`,
  // roughness: `${PLANK_FLOOR}Roughness.jpg`,
  // ao: `${PLANK_FLOOR}AmbientOcclusion.jpg`,
  tileMetres: 1.5,
};

export interface EnvironmentAsset {
  /** Path under public/, served from the site root. */
  readonly url: string;
  /** Replaces every material in the GLB once its maps have loaded. */
  readonly material?: PbrTextureSet;
}

/** Static environment models. Missing files fall back to the procedural floor. */
export const ENVIRONMENT_ASSETS: readonly EnvironmentAsset[] = [
  { url: 'models/Table01.glb', material: PLANK_WOOD },
];

/**
 * The card model is NOT a static environment asset — it is instanced per card by
 * the `Card` component (src/app/scene/card/card.ts), which textures its front
 * face (material name matching /front|artwork/i) with a per-card image.
 */
export const CARD_MODEL_URL = 'models/Card.glb';

/**
 * Optional authored models for table items (dice, coins, counters), instanced
 * by the `Item` component. A kind with no entry here renders the procedural
 * placeholder from `item/item-geometry.ts`, so no missing-file request is ever
 * made. Drop e.g. `models/D20.glb` into `public/models/` and add
 * `d20: 'models/D20.glb'`: the item then spawns that model instead, keeping
 * its pose, animation and picking behaviour. Authored scale and origin don't
 * matter — the Item component normalises the model to the placeholder's size,
 * centred on its bounding box (see `Item.normalizeModel`).
 */
export const ITEM_MODEL_URLS: Readonly<Partial<Record<string, string>>> = {
  d4: 'models/d4.glb',
};
