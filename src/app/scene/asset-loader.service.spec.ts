import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AssetLoaderService } from './asset-loader.service';

type LoadCall = {
  url: string;
  onLoad: (gltf: { scene: object }) => void;
  onProgress: (e: { lengthComputable: boolean; loaded: number; total: number }) => void;
  onError: (err: unknown) => void;
};

const loadCalls: LoadCall[] = [];

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(
      url: string,
      onLoad: LoadCall['onLoad'],
      onProgress: LoadCall['onProgress'],
      onError: LoadCall['onError'],
    ): void {
      loadCalls.push({ url, onLoad, onProgress, onError });
    }
  },
}));

describe('AssetLoaderService', () => {
  let service: AssetLoaderService;

  beforeEach(() => {
    loadCalls.length = 0;
    service = TestBed.inject(AssetLoaderService);
  });

  it('dedupes concurrent loads and caches resolved scenes', async () => {
    const p1 = service.load('models/a.glb');
    const p2 = service.load('models/a.glb');
    expect(loadCalls).toHaveLength(1);

    const scene = {};
    loadCalls[0]!.onLoad({ scene });
    expect(await p1).toBe(scene);
    expect(await p2).toBe(scene);

    // Cache hit: no new underlying load, no loading state.
    expect(await service.load('models/a.glb')).toBe(scene);
    expect(loadCalls).toHaveLength(1);
    expect(service.loading()).toBe(false);
  });

  it('aggregates progress across files, treating non-computable lengths as 0 until done', async () => {
    const pa = service.load('models/a.glb');
    const pb = service.load('models/b.glb');
    expect(service.loading()).toBe(true);
    expect(service.progress()).toBe(0);

    loadCalls[0]!.onProgress({ lengthComputable: true, loaded: 50, total: 100 });
    expect(service.progress()).toBe(0.25); // (0.5 + 0) / 2

    // b reports without a computable length — contributes 0 until it completes.
    loadCalls[1]!.onProgress({ lengthComputable: false, loaded: 10, total: 0 });
    expect(service.progress()).toBe(0.25);

    loadCalls[1]!.onLoad({ scene: {} });
    expect(service.progress()).toBe(0.75); // (0.5 + 1) / 2

    loadCalls[0]!.onLoad({ scene: {} });
    expect(service.loading()).toBe(false);
    expect(service.progress()).toBe(0);
    await Promise.all([pa, pb]);
  });

  it('rejects on error, sets the error signal, and evicts the cache so retries re-load', async () => {
    const p = service.load('models/missing.glb');
    loadCalls[0]!.onError(new Error('404 Not Found'));

    await expect(p).rejects.toThrow('404 Not Found');
    expect(service.error()).toBe('404 Not Found');
    expect(service.loading()).toBe(false);

    // Retry issues a fresh underlying load.
    const retry = service.load('models/missing.glb');
    expect(loadCalls).toHaveLength(2);
    const scene = {};
    loadCalls[1]!.onLoad({ scene });
    expect(await retry).toBe(scene);
  });
});
