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
