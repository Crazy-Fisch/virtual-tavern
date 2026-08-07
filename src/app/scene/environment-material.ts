import {
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RepeatWrapping,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { AssetLoaderService } from './asset-loader.service';
import { PbrTextureSet } from './scene-assets';

/** Keeps the grain crisp where the tabletop runs away from the camera. */
const ANISOTROPY = 8;
/** Wood: no metal, and let the roughness map carry the full range. */
const METALNESS = 0;
const ROUGHNESS = 1;

/**
 * One in-flight/finished application per model. `AssetLoaderService` caches
 * loaded Groups for the app's lifetime and hands the same instance to every
 * scene mount, so re-materialling must happen once per model — not once per
 * visit to the tavern. A failure is evicted so the next mount can retry.
 */
const applied = new WeakMap<Object3D, Promise<void>>();

/**
 * Replace every material under `root` with one PBR material built from `set`,
 * tiled to the model's own UV scale.
 *
 * Environment GLBs ship with whatever material they were authored with; this is
 * how the app dresses them (textures.md). Idempotent per model, and safe to let
 * run in the background: until it resolves the model keeps its authored look
 * rather than showing nothing.
 */
export function applyTextureSet(
  root: Object3D,
  set: PbrTextureSet,
  assets: AssetLoaderService,
): Promise<void> {
  const existing = applied.get(root);
  if (existing) return existing;
  const promise = buildAndApply(root, set, assets).catch((err: unknown) => {
    applied.delete(root); // keep the authored material; allow a retry
    throw err;
  });
  applied.set(root, promise);
  return promise;
}

async function buildAndApply(
  root: Object3D,
  set: PbrTextureSet,
  assets: AssetLoaderService,
): Promise<void> {
  const load = (url?: string): Promise<Texture | null> =>
    url ? assets.loadTexture(url, 'data') : Promise.resolve(null);
  const [map, normalMap, roughnessMap, aoMap] = await Promise.all([
    assets.loadTexture(set.baseColor, 'color'),
    load(set.normal),
    load(set.roughness),
    load(set.ao),
  ]);

  const repeat = tileRepeat(root, set.tileMetres);
  for (const texture of [map, normalMap, roughnessMap, aoMap]) {
    if (!texture) continue;
    // These maps are only ever used by the model they were registered for, so
    // tiling the shared (cached) texture in place is safe.
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(repeat, repeat);
    texture.anisotropy = Math.max(texture.anisotropy, ANISOTROPY);
    texture.needsUpdate = true;
  }

  const material = new MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    // Ambient occlusion reads UV channel 0 by default (Texture.channel), so the
    // model's single authored UV set is all it needs.
    aoMap,
    metalness: METALNESS,
    roughness: ROUGHNESS,
    // Whether the model is single- or double-sided is an authoring decision;
    // carry it over rather than forcing Three's front-side default.
    side: authoredSide(root),
  });

  const retired = new Set<Material>();
  root.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    for (const old of materialsOf(obj)) retired.add(old);
    obj.material = material;
  });
  for (const old of retired) disposeMaterial(old);
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** The `side` of the first material found, defaulting to Three's front-side. */
function authoredSide(root: Object3D): MeshStandardMaterial['side'] {
  let side: MeshStandardMaterial['side'] | undefined;
  root.traverse((obj) => {
    if (side !== undefined || !(obj instanceof Mesh)) return;
    side = materialsOf(obj)[0]?.side;
  });
  return side ?? new MeshStandardMaterial().side;
}

/** The replaced material and the maps the GLB embedded for it are now garbage. */
function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

const pa = new Vector3();
const pb = new Vector3();
const pc = new Vector3();
const ab = new Vector3();
const ac = new Vector3();
const ta = new Vector2();
const tb = new Vector2();
const tc = new Vector2();

/**
 * Texture repeats that make one tile cover `tileMetres` of the model's surface.
 *
 * The repeat cannot be read off the bounding box: a Blender unwrap packs the
 * faces into an atlas, so 0..1 in UV space is the whole model, not one face. It
 * comes instead from the ratio of UV area to world area summed over every
 * triangle — the square root of which is "UV units per metre", the unwrap's
 * scale. Table01.glb measures 0.109 uv/m (one tile per 9.2 m at repeat 1), so a
 * 1.2 m tile works out to ~7.7 repeats.
 *
 * A model with no UVs, or a degenerate unwrap, falls back to repeat 1.
 */
function tileRepeat(root: Object3D, tileMetres: number): number {
  let worldArea = 0;
  let uvArea = 0;
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    const position = obj.geometry.getAttribute('position');
    const uv = obj.geometry.getAttribute('uv');
    if (!position || !uv) return;
    const index = obj.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      pa.fromBufferAttribute(position, a).applyMatrix4(obj.matrixWorld);
      pb.fromBufferAttribute(position, b).applyMatrix4(obj.matrixWorld);
      pc.fromBufferAttribute(position, c).applyMatrix4(obj.matrixWorld);
      worldArea += ab.subVectors(pb, pa).cross(ac.subVectors(pc, pa)).length() / 2;
      ta.fromBufferAttribute(uv, a);
      tb.fromBufferAttribute(uv, b);
      tc.fromBufferAttribute(uv, c);
      uvArea += Math.abs((tb.x - ta.x) * (tc.y - ta.y) - (tc.x - ta.x) * (tb.y - ta.y)) / 2;
    }
  });
  if (worldArea <= 0 || uvArea <= 0 || tileMetres <= 0) return 1;
  const uvPerMetre = Math.sqrt(uvArea / worldArea);
  return 1 / (tileMetres * uvPerMetre);
}
