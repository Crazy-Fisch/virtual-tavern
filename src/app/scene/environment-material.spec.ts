import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Texture,
} from 'three';
import { vi } from 'vitest';
import { AssetLoaderService } from './asset-loader.service';
import { applyTextureSet } from './environment-material';
import { PbrTextureSet } from './scene-assets';

const SET: PbrTextureSet = {
  baseColor: 'textures/base.jpg',
  normal: 'textures/normal.jpg',
  roughness: 'textures/roughness.jpg',
  ao: 'textures/ao.jpg',
  tileMetres: 1,
};

/** Records what was asked for and hands back a distinct texture per URL. */
function fakeAssets(): {
  service: AssetLoaderService;
  calls: { url: string; kind: string }[];
  fail: (url: string) => void;
} {
  const calls: { url: string; kind: string }[] = [];
  const failing = new Set<string>();
  const service = {
    loadTexture: vi.fn((url: string, kind = 'color') => {
      calls.push({ url, kind });
      if (failing.has(url)) return Promise.reject(new Error(`nope: ${url}`));
      const texture = new Texture();
      texture.name = url;
      return Promise.resolve(texture);
    }),
  } as unknown as AssetLoaderService;
  return { service, calls, fail: (url) => failing.add(url) };
}

/**
 * A flat `size × size` m plane whose UVs run 0..1 — i.e. exactly `1 / size` UV
 * units per metre, so the expected repeat is easy to state.
 */
function plane(size: number, material = new MeshStandardMaterial()): Group {
  const mesh = new Mesh(new PlaneGeometry(size, size), material);
  const group = new Group();
  group.add(mesh);
  return group;
}

function materialsIn(group: Group): MeshStandardMaterial[] {
  const found: MeshStandardMaterial[] = [];
  group.traverse((obj) => {
    if (obj instanceof Mesh) found.push(obj.material as MeshStandardMaterial);
  });
  return found;
}

describe('applyTextureSet', () => {
  it('loads base colour as art and every other map as data', async () => {
    const assets = fakeAssets();
    await applyTextureSet(plane(2), SET, assets.service);

    expect(assets.calls).toEqual([
      { url: 'textures/base.jpg', kind: 'color' },
      { url: 'textures/normal.jpg', kind: 'data' },
      { url: 'textures/roughness.jpg', kind: 'data' },
      { url: 'textures/ao.jpg', kind: 'data' },
    ]);
  });

  it('replaces every material in the model with one standard material carrying the maps', async () => {
    const assets = fakeAssets();
    const group = plane(2);
    group.add(new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial()));

    await applyTextureSet(group, SET, assets.service);

    const materials = materialsIn(group);
    expect(materials).toHaveLength(2);
    expect(materials[0]).toBe(materials[1]); // one material shared by the model
    const material = materials[0]!;
    expect(material).toBeInstanceOf(MeshStandardMaterial);
    expect(material.map?.name).toBe('textures/base.jpg');
    expect(material.normalMap?.name).toBe('textures/normal.jpg');
    expect(material.roughnessMap?.name).toBe('textures/roughness.jpg');
    expect(material.aoMap?.name).toBe('textures/ao.jpg');
    expect(material.metalness).toBe(0);
    // AO reads UV channel 0, so the model's single authored UV set is enough.
    expect(material.aoMap?.channel).toBe(0);
  });

  it('omits maps the set does not list, without requesting them', async () => {
    const assets = fakeAssets();
    const group = plane(2);

    await applyTextureSet(group, { baseColor: 'textures/base.jpg', tileMetres: 1 }, assets.service);

    expect(assets.calls).toEqual([{ url: 'textures/base.jpg', kind: 'color' }]);
    const material = materialsIn(group)[0]!;
    expect(material.map?.name).toBe('textures/base.jpg');
    expect(material.normalMap).toBeNull();
    expect(material.roughnessMap).toBeNull();
    expect(material.aoMap).toBeNull();
  });

  it('tiles from the model’s own UV scale, not its bounding box', async () => {
    const assets = fakeAssets();
    // 4 m across with UVs over 0..1 → 0.25 uv/m → a 1 m tile needs 4 repeats.
    const group = plane(4);

    await applyTextureSet(group, SET, assets.service);

    const material = materialsIn(group)[0]!;
    expect(material.map!.repeat.x).toBeCloseTo(4, 5);
    expect(material.map!.repeat.y).toBeCloseTo(4, 5);
    // Every map has to tile identically or they slide against each other.
    for (const map of [material.normalMap, material.roughnessMap, material.aoMap]) {
      expect(map!.repeat.x).toBeCloseTo(4, 5);
    }
  });

  it('scales the repeat with the requested tile size', async () => {
    const assets = fakeAssets();
    const group = plane(4);

    await applyTextureSet(group, { ...SET, tileMetres: 2 }, assets.service);

    expect(materialsIn(group)[0]!.map!.repeat.x).toBeCloseTo(2, 5);
  });

  it('accounts for the model’s world transform when measuring metres', async () => {
    const assets = fakeAssets();
    const group = plane(4);
    group.scale.setScalar(0.5); // a 4 m plane shrunk to 2 m of world surface

    await applyTextureSet(group, SET, assets.service);

    expect(materialsIn(group)[0]!.map!.repeat.x).toBeCloseTo(2, 5);
  });

  it('falls back to repeat 1 for a model with no UVs', async () => {
    const assets = fakeAssets();
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3),
    );
    const group = new Group();
    group.add(new Mesh(geometry, new MeshStandardMaterial()));

    await applyTextureSet(group, SET, assets.service);

    expect(materialsIn(group)[0]!.map!.repeat.x).toBe(1);
  });

  it('keeps the authored sidedness', async () => {
    const assets = fakeAssets();
    const doubleSided = plane(2, new MeshStandardMaterial({ side: DoubleSide }));
    const singleSided = plane(2, new MeshStandardMaterial({ side: FrontSide }));

    await applyTextureSet(doubleSided, SET, assets.service);
    await applyTextureSet(singleSided, SET, assets.service);

    expect(materialsIn(doubleSided)[0]!.side).toBe(DoubleSide);
    expect(materialsIn(singleSided)[0]!.side).toBe(FrontSide);
  });

  it('disposes the material it replaced, and the maps that came with it', async () => {
    const assets = fakeAssets();
    const embedded = new Texture();
    const embeddedDispose = vi.spyOn(embedded, 'dispose');
    const authored = new MeshBasicMaterial({ map: embedded });
    const authoredDispose = vi.spyOn(authored, 'dispose');

    await applyTextureSet(
      plane(2, authored as unknown as MeshStandardMaterial),
      SET,
      assets.service,
    );

    expect(authoredDispose).toHaveBeenCalled();
    expect(embeddedDispose).toHaveBeenCalled();
  });

  it('runs once per model, however many scenes mount it', async () => {
    const assets = fakeAssets();
    const group = plane(2);

    await applyTextureSet(group, SET, assets.service);
    const first = materialsIn(group)[0];
    await applyTextureSet(group, SET, assets.service);

    expect(assets.calls).toHaveLength(4); // not re-requested
    expect(materialsIn(group)[0]).toBe(first); // not rebuilt
  });

  it('dedupes concurrent calls for the same model', async () => {
    const assets = fakeAssets();
    const group = plane(2);

    await Promise.all([
      applyTextureSet(group, SET, assets.service),
      applyTextureSet(group, SET, assets.service),
    ]);

    expect(assets.calls).toHaveLength(4);
  });

  it('leaves the authored material alone when a map fails, and allows a retry', async () => {
    const assets = fakeAssets();
    assets.fail('textures/normal.jpg');
    const authored = new MeshStandardMaterial();
    const group = plane(2, authored);

    await expect(applyTextureSet(group, SET, assets.service)).rejects.toThrow('nope');
    expect(materialsIn(group)[0]).toBe(authored);

    // The failure is evicted, so the next scene mount tries again.
    const retry = fakeAssets();
    await applyTextureSet(group, SET, retry.service);
    expect(materialsIn(group)[0]).not.toBe(authored);
  });
});
