import { Injectable, computed, signal } from '@angular/core';
import {
  Group,
  Material,
  Mesh,
  NoColorSpace,
  Object3D,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * What a texture's channels mean. `'color'` is art (card faces, base-colour
 * maps) and is decoded from sRGB; `'data'` is a PBR map whose numbers must reach
 * the shader untouched — a gamma-decoded normal, roughness or AO map is simply
 * wrong.
 */
export type TextureKind = 'color' | 'data';

/** Shared conventions: colour space per kind, glTF-authored UVs (top-down image). */
function configureTexture(texture: Texture, kind: TextureKind): Texture {
  texture.colorSpace = kind === 'color' ? SRGBColorSpace : NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

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
   * Cached image texture, configured for use on glTF-authored UVs (flipY =
   * false, colour space per `kind`). Shared across consumers — never dispose it.
   * Does not drive the loading/progress signals (textures pop in; the overlay is
   * for models). The cache key includes the kind, so the same image can serve as
   * both art and a data map without one stomping the other's colour space.
   */
  loadTexture(url: string, kind: TextureKind = 'color'): Promise<Texture> {
    const key = `${kind}:${url}`;
    const cached = this.textureCache.get(key);
    if (cached) return cached;
    const promise = this.loadTextureFresh(url, kind).catch((err: unknown) => {
      this.textureCache.delete(key); // allow retry
      throw err instanceof Error ? err : new Error(`Failed to load texture ${url}`);
    });
    this.textureCache.set(key, promise);
    return promise;
  }

  /**
   * Load through an <img> first (cheapest, browser-decoded), falling back to
   * fetching the bytes ourselves.
   *
   * The fallback matters: card art is also shown in the DOM (hand, piles,
   * search results, deck view). If one of those <img>s pulled it in *without*
   * `crossorigin`, the browser can hand this cross-origin request the same
   * opaque cache entry and the upload to WebGL fails — cards with images
   * everywhere except on the table. Every card <img> now sets
   * `crossorigin="anonymous"` so both paths share one CORS-clean entry; this
   * re-fetch heals whatever slipped through (or was cached before the fix).
   */
  private async loadTextureFresh(url: string, kind: TextureKind): Promise<Texture> {
    try {
      return await this.loadTextureViaImage(url, kind);
    } catch {
      return await this.loadTextureFromBytes(url, kind);
    }
  }

  private loadTextureViaImage(url: string, kind: TextureKind): Promise<Texture> {
    return new Promise<Texture>((resolve, reject) => {
      this.textureLoader ??= new TextureLoader();
      // Explicit (and matching the <img crossorigin="anonymous">) so the
      // response is usable as a WebGL texture instead of tainting the canvas.
      this.textureLoader.setCrossOrigin('anonymous');
      this.textureLoader.load(
        url,
        (texture) => resolve(configureTexture(texture, kind)),
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(`Failed to load texture ${url}`)),
      );
    });
  }

  /** CORS re-fetch: build the texture from the bytes, skipping the HTTP cache. */
  private async loadTextureFromBytes(url: string, kind: TextureKind): Promise<Texture> {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload' });
    if (!response.ok) throw new Error(`Failed to load texture ${url} (${response.status})`);
    const blob = await response.blob();
    // ImageBitmap ignores Texture.flipY, but its default orientation already
    // matches flipY = false (top-left origin), which is what glTF UVs expect.
    const bitmap = await createImageBitmap(blob);
    return configureTexture(new Texture(bitmap), kind);
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
