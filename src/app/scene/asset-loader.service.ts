import { Injectable, computed, signal } from '@angular/core';
import { Group, Material, Mesh, Object3D, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * GLB loader with caching and aggregate progress signals. Loaded scenes are
 * cached for the app's lifetime (rejoining a room re-adds the same Group
 * instantly; Three re-uploads GPU resources on demand after a renderer is
 * disposed), so never call dispose() on a Group returned by load()/loadAll() —
 * dispose() is for replaced procedural placeholders only.
 */
@Injectable({ providedIn: 'root' })
export class AssetLoaderService {
  private loader?: GLTFLoader;
  private textureLoader?: TextureLoader;
  private readonly cache = new Map<string, Promise<Group>>();
  private readonly textureCache = new Map<string, Promise<Texture>>();
  /** Download fraction (0..1) per URL in the current loading batch. */
  private readonly inFlight = signal<Map<string, number>>(new Map());
  private readonly _error = signal<string | null>(null);

  readonly loading = computed(() => this.inFlight().size > 0);
  /** 0..1 across the current batch; files without a computable length count 0 until done. */
  readonly progress = computed(() => {
    const fractions = Array.from(this.inFlight().values());
    if (fractions.length === 0) return 0;
    return fractions.reduce((sum, f) => sum + f, 0) / fractions.length;
  });
  readonly error = this._error.asReadonly();

  /** Cached + deduped; same URL always yields the same Group. Failures are evicted so retries work. */
  load(url: string): Promise<Group> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const promise = this.loadFresh(url);
    this.cache.set(url, promise);
    return promise;
  }

  /** Load several models, driving the shared loading/progress signals. Rejects if any fail. */
  loadAll(urls: readonly string[]): Promise<Group[]> {
    return Promise.all(urls.map((u) => this.load(u)));
  }

  /**
   * Cached image texture, configured for use on glTF-authored UVs (sRGB,
   * flipY = false). Shared across consumers — never dispose it. Does not drive
   * the loading/progress signals (textures pop in; the overlay is for models).
   */
  loadTexture(url: string): Promise<Texture> {
    const cached = this.textureCache.get(url);
    if (cached) return cached;
    const promise = new Promise<Texture>((resolve, reject) => {
      this.textureLoader ??= new TextureLoader();
      this.textureLoader.load(
        url,
        (texture) => {
          texture.colorSpace = SRGBColorSpace;
          texture.flipY = false;
          texture.needsUpdate = true;
          resolve(texture);
        },
        undefined,
        (err) => {
          this.textureCache.delete(url); // allow retry
          reject(err instanceof Error ? err : new Error(`Failed to load texture ${url}`));
        },
      );
    });
    this.textureCache.set(url, promise);
    return promise;
  }

  /** Dispose geometries, materials, and their textures. NOT for cached environment Groups. */
  dispose(root: Object3D): void {
    root.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      obj.geometry.dispose();
      const materials: Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof Texture) value.dispose();
        }
        material.dispose();
      }
    });
  }

  private loadFresh(url: string): Promise<Group> {
    this._error.set(null);
    this.setFraction(url, 0);
    return new Promise<Group>((resolve, reject) => {
      this.loader ??= new GLTFLoader();
      this.loader.load(
        url,
        (gltf) => {
          this.settle(url, 1);
          resolve(gltf.scene);
        },
        (event) => {
          if (event.lengthComputable && event.total > 0) {
            this.setFraction(url, Math.min(1, event.loaded / event.total));
          }
        },
        (err) => {
          this.cache.delete(url); // allow retry once the file exists
          this.settle(url, null);
          this._error.set(err instanceof Error ? err.message : `Failed to load ${url}`);
          reject(err instanceof Error ? err : new Error(`Failed to load ${url}`));
        },
      );
    });
  }

  private setFraction(url: string, fraction: number): void {
    this.inFlight.update((m) => new Map(m).set(url, fraction));
  }

  /** Mark a load finished (fraction 1) or failed (removed); empty the batch once all are done. */
  private settle(url: string, fraction: number | null): void {
    this.inFlight.update((m) => {
      const next = new Map(m);
      if (fraction === null) next.delete(url);
      else next.set(url, fraction);
      const allDone = Array.from(next.values()).every((f) => f >= 1);
      return allDone ? new Map<string, number>() : next;
    });
  }
}
