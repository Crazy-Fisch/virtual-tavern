# Textures & lighting — implementation results

Implements `textures.md`: the table wears the **PlankFloor PBR set**, and the scene is lit
like a **warm tavern** with two offscreen torches.

`npm test`: **210 tests, all green** (12 of them new for this doc).
`npm run build`: clean.

> **Not visually confirmed.** No browser automation was available in this session and the
> scene sits behind auth + a joined room, so I could not screenshot it. Instead of guessing
> at values, I derived them by reproducing Three's shading math against the textures'
> measured colours — the numbers below are computed, not eyeballed. §5 says which knob to
> turn if something reads wrong on screen.

---

## 1. The table material

`Table01.glb` ships one mesh with one material (a plain base-colour PNG). Rather than teach
the scene about "the table", the manifest entry grew a texture set:

```ts
// scene-assets.ts
export const ENVIRONMENT_ASSETS = [{ url: 'models/Table01.glb', material: PLANK_WOOD }];
```

and a new **`applyTextureSet`** (`src/app/scene/environment-material.ts`) replaces every
material in a loaded model with one `MeshStandardMaterial` built from the set. Any future
environment GLB gets dressed by adding a `material:` line — no scene code.

Four of the five provided maps are wired up:

| File                                   | Use            | Colour space |
| -------------------------------------- | -------------- | ------------ |
| `Substance_Graph_BaseColor.jpg`        | `map`          | sRGB         |
| `Substance_Graph_Normal.jpg`           | `normalMap`    | linear       |
| `Substance_Graph_Roughness.jpg`        | `roughnessMap` | linear       |
| `Substance_Graph_AmbientOcclusion.jpg` | `aoMap`        | linear       |
| `Substance_Graph_Height.jpg`           | **unused**     | —            |

**Height is deliberately left on the floor.** A height map drives `displacementMap`, which is
a per-vertex offset — and this table is a 120-vertex box. There is nothing to displace; it
would warp the eight corners of each face and nothing else. The same relief is already in the
normal map, which is where it comes from on low-poly geometry. The file stays in the repo in
case the table is ever re-authored with real topology. Not downloading it also saves a
request.

The colour-space split needed a small change to `AssetLoaderService.loadTexture`, which
previously forced sRGB (it only ever loaded card art). It now takes a **`TextureKind`** —
`'color'` (default, unchanged for every existing caller) or `'data'` — and the cache key
includes it. This is not cosmetic: gamma-decoding a normal or roughness map bends its numbers
and the surface lights wrongly.

### Tiling: measured, not guessed

The interesting part. The obvious way to scale a texture onto a model is to divide by its
bounding box — and it would have been wrong here. Blender's unwrap packs the faces into an
**atlas**, so UV 0..1 is the whole model, not one face; the tabletop is just one island
inside it. At `repeat = 1` a single 1024² tile would have stretched across ~9 m of table.

So `tileRepeat()` measures the unwrap instead: summing UV area and world area over every
triangle, `sqrt(uvArea / worldArea)` is the unwrap's scale in **UV units per metre**. For
`Table01.glb` that comes out at:

```
world area 71.31 m²   uv area 0.8425
0.1087 uv/m  ->  one tile spans 9.20 m at repeat 1
repeat for a 1.2 m tile = 7.67
```

That makes `tileMetres` in the manifest mean actual metres, and it survives the table being
re-authored or re-unwrapped. `tileMetres: 1.2` puts a parquet block (the tile is ~8 across)
at **~15 cm** — about 3 blocks to the width of a card, which reads as fine parquetry rather
than floorboards on a 4 × 6 m table.

The world matrix is applied while measuring, so a scaled model still tiles correctly (there's
a test).

### Details worth knowing

- **Runs once per model.** `AssetLoaderService` caches Groups for the app's lifetime and
  hands the same instance to every scene mount, so re-materialling is memoised in a
  `WeakMap` — otherwise every visit to the tavern would rebuild the material and leak the
  last one. A failure is evicted so the next mount retries.
- **Not awaited.** The table is added to the scene, interactive, wearing its authored
  material while the ~810 KB of maps download; the PBR material swaps in when ready. Awaiting
  it would have shown an empty room instead, since `loading()` (and so the loading overlay)
  deliberately doesn't track textures.
- **Sidedness is carried over** from the authored material rather than forced to Three's
  front-side default — that's an authoring decision, and the table is marked double-sided.
- `aoMap` reads **UV channel 0** (`Texture.channel`, default), so the model's single authored
  UV set is enough; no `uv1` needed.
- The replaced material and its embedded PNG are disposed.
- Maps get `RepeatWrapping` and `anisotropy = 8`, which is what keeps the grain from smearing
  where the tabletop runs away from the camera.

## 2. Lighting

Replaces the old white hemisphere + white key (`scene.ts`):

| Light                       | Colour                       | Intensity | Position       |
| --------------------------- | ---------------------------- | --------- | -------------- |
| `HemisphereLight` (ambient) | `#ffe9d2` / `#3a2a1e` ground | 1.35      | —              |
| `DirectionalLight` (fill)   | `#fff0e0`                    | 0.9       | (2, 7, 3)      |
| `PointLight` ×2 (torches)   | `#ffa15a`                    | 30        | (±4.8, 2.3, 0) |

Scene background went from a cold `#12121a` to `#140e09`, and the placeholder floor (shown
only while loading, or if the GLB is missing) from blue-grey to dark boards, so the fallback
belongs to the same room.

**The torches are offscreen.** The orthographic view is `VIEW_HEIGHT` = 4.2 m tall and so
~7.5 m wide at 16:9 — visible out to x ≈ ±3.7 — and the table is 4 m across. At x = ±4.8 they
stay out of shot at any aspect while their inverse-square falloff still rakes the tabletop.
They **flicker**: ±8%, from two out-of-phase sines evaluated in the existing render loop
(which already ran every frame, so this costs nothing).

Torch intensity is in Three's physical units — candela against the default `decay = 2` — so
30 buys about `30 / d²` at the table, not the ~1 the same number means on an ambient light.
That unit difference is the easiest thing to get wrong here.

## 3. Why the tints are gentler than "firelight" sounds

The first pass used a saturated amber ambient and a `#ff8b3d` torch, and the arithmetic said
it would look bad. Three shades diffuse as `albedo / π × irradiance`, and the plank texture's
**measured average is `#562a07`** — a deep brown with a blue channel of 7/255, essentially
nothing. Multiplying that by a saturated light crushes the little green and blue it has left
and the table renders as a flat orange silhouette of itself.

So only the torches are properly fire-coloured; the ambient and fill sit near white with the
warmth in the last third of each channel. The warmth still reads — it just doesn't eat the
material.

The total is aimed at **~π of irradiance**, which is exactly the amount at which a surface
renders as its own base colour. Computed against the real texture average:

```
base colour texture              rgb(86,42,7) #562a07   (unlit reference)

table centre       (0, z 0)      #542103   irradiance 3.03 / 2.11 / 1.56   (PI = 3.14)
near edge          (x 2, z 0)    #5e2404   irradiance 3.79 / 2.38 / 1.63
own end            (0, z 2.5)    #512103   irradiance 2.79 / 2.03 / 1.53
far end            (0, z -3)     #502003   irradiance 2.72 / 2.00 / 1.52
```

The middle of the table lands on `#542103` against that `#562a07` texture — the same wood, a
shade deeper and warmer — and the near edges reach `#5e2404`, ~12% hotter. That gradient is
the point: it reads as firelight from the sides rather than as two spotlights.

Sitting on the π mark is also a **hard constraint**, not just taste. The renderer runs with
no tone mapping, on purpose — card art is drawn emissive at full strength so a card on the
table matches the same image shown in the DOM — which means bright lit surfaces **clip**
instead of rolling off. The brightest lit surface in the app is a card model with no art on
it (albedo 0.8, white); at the hottest spot on the table it peaks at `#fbccad`, just under
white. `TORCH_INTENSITY` is the value with the ceiling: at 34 that same card clipped its red
channel, which is why it is 30.

Dice are safe by a wide margin — the most exposed palette colour, yellow `#e0b32c`, reaches
0.93 of full red at the table edge.

## 4. How the numbers were derived

Two throwaway scripts, in the scratchpad, not the repo:

1. A **JPEG average-colour reader** (DC coefficients only, handles the progressive files
   Substance exported). Its own output validates it: the normal map averages `#7f7ffe`,
   exactly the flat tangent-space normal, and the height map averages mid-grey. It gave the
   `#562a07` albedo above, and incidentally that the wood is fairly glossy (roughness
   averages 0.21).
2. A **shading reproduction** — hemisphere, directional and point-light irradiance exactly as
   Three computes it, Lambert `albedo/π`, then linear→sRGB — evaluated at points across the
   tabletop. That produced the table in §3 and picked `TORCH_INTENSITY`.

Worth re-running the second one (it is ~60 lines) before changing a light constant, rather
than nudging by eye.

## 5. If it looks wrong on screen

Everything is a named constant at the top of `scene.ts`:

- **Table too dark / too bright** — `AMBIENT_INTENSITY`. It is the biggest single
  contributor and the safest to move.
- **Not warm enough** — pull `AMBIENT_SKY` and `FILL_COLOR` toward amber. They are near-white
  by design (§3), so go in small steps and watch the blue channel.
- **Torches not readable as torches** — `TORCH_INTENSITY` up steepens the edge-to-middle
  gradient, but see the clipping ceiling; moving `TORCH_X` inward from 4.8 sharpens the
  falloff without adding total light, which is the better knob. Below ~3.9 they enter frame.
- **Flicker distracting** — `FLICKER_AMOUNT` to 0 disables it; the loop cost stays nil.
- **Parquet too big / too small** — `tileMetres` on `PLANK_WOOD` in `scene-assets.ts`, in
  metres. Lower = finer.

## 6. Tests

`src/app/scene/environment-material.spec.ts`, 12 cases, no WebGL needed (Three's scene graph
and math run fine in jsdom; the asset loader is faked at the service seam like the rest of
the suite): colour-space per map, one shared material carrying all four maps, optional maps
not requested, repeat measured from the UV scale rather than the bounding box, repeat scaling
with `tileMetres`, world-transform handling, the no-UV fallback, sidedness carried over, the
old material and its embedded texture disposed, once-per-model memoisation, concurrent-call
dedupe, and a failed map leaving the authored material intact and retryable.

## 7. Not done

- **No shadows.** Cards don't cast onto the table. That needs a shadow-map pass, shadow
  cameras on the torches, and per-object `castShadow`/`receiveShadow` — a real change with a
  real frame cost, and outside what this doc asked for. It is the obvious next step if the
  table wants more depth.
- **No environment map**, so the wood's glossiness (roughness ~0.21) only shows as direct
  specular from the fill and torches. A small baked cube map would make it read as varnished.
- **No visible torch geometry** — the lights are offscreen and have no bodies, per the doc
  ("offscreen but reaching the table").
