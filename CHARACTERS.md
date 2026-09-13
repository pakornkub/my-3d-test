# UBE Office — interactive isometric scene

An isometric office built in Blender, exported to glTF, and driven in the browser with
Vite + three.js. Click the floor and the chibi engineer walks there; click a chair and he
walks over and sits down.

```
blender/iso_office_lib.py ───────────► export/ube_office.glb
                                       export/seats.json + obstacles.json
                                               │
blender/source/*_meshy.blend                   │
        │  normalize_character.py (scale / origin / facing)
        ▼                                      │
        │  rig_character.py (armature + Idle/Walk/Sit/SitIdle)
        ▼                                      ▼
export/characters/*.glb ─────────────► src/*.js  →  browser
```

## Where things live

```
blender/                  everything Blender touches
  iso_office_lib.py       builds the office, exports the GLB + seats + obstacles
  normalize_character.py  scale / origin / facing for any generated character
  rig_character.py        armature, skin weights, the four clips
  layout_plan.svg         the floor plan the office was laid out from
  scenes/                 editable .blend files
  source/                 raw generator downloads, kept for re-runs
  raw/                    drop new generator output here as <id>.glb
export/                   THE RUNTIME CONTRACT -- vite serves this as the site root
  ube_office.glb  seats.json  obstacles.json  characters/
renders/                  verification images
src/                      the web app
```

`export/` is deliberately not tucked inside `blender/`: it is `publicDir` in
`vite.config.js`, so `export/ube_office.glb` is served at `/ube_office.glb`. Moving it would
change every URL the app fetches.

## Run it

```bash
npm install
npm run dev
```

`vite.config.js` sets `publicDir: 'export'`, so the Blender output is served straight from
where the pipeline writes it — nothing is copied, and re-exporting a GLB is picked up on the
next reload. Source lives in `src/` for exactly that reason: `publicDir` is served verbatim.

## What the app does

| Interaction | Result |
| --- | --- |
| Click the floor or the rug | The character paths around the furniture and walks there |
| Click any of the 13 chairs | Walks to the chair's approach spot, turns, and sits |
| Click an object | A card opens with its name and a list of suggested actions |
| Drag (right button) / scroll | Orbit and zoom |
| `Iso` / `Free` | Orthographic preset matching `renders/ube_iso_office_final.png`, or a free perspective orbit |
| `Reset view` | Back to the reference framing |

Only the chair actions are wired to real behaviour. Every other action button raises its id
and shows a toast — filling them in means editing `src/hotspots.js` and adding a branch to
`runAction()` in `src/main.js`, nothing else.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/main.js` | wiring, picking, actions |
| `src/scene.js` | renderer, lights, the two cameras, OrbitControls |
| `src/characters.js` | asset loading, spawning, material matching, clip playback |
| `src/character.js` | the walk / turn / sit state machine |
| `src/nav.js` | occupancy grid, A\*, path smoothing, approach-point repair |
| `src/hotspots.js` | object name → label, category, suggested actions |
| `src/ui.js` | HUD, object card, toast |

`window.__ube` exposes `{ viewer, pack, controller, nav, hero, step, screenOf }` for poking
at the scene from the devtools console. `__ube.step(n)` advances the simulation by hand,
which is the only way to test in an embedded preview pane — those park
`requestAnimationFrame` when the pane is not painted.

## Rebuilding the character

```bash
# 1. scale / origin / facing only, textures untouched
blender -b --python blender/normalize_character.py -- --stage all

# 2. armature, skin weights, the four clips
blender -b --python blender/rig_character.py
```

**Order matters.** Step 1 exports an unrigged mesh, so running it after step 2 would throw
the armature away. It refuses to do that to an already-rigged character; pass `--force` if
you really do want to rebuild from source. To only redo the rig, run step 2 on its own — it
re-normalises from the source file internally.

`normalize_character.py` fixes what a generator gets wrong:

| Problem | Fix |
| --- | --- |
| model normalised into a unit box | scaled to the `ROSTER` height (1.31–1.40 m) |
| origin floating mid-body | moved to the floor, centred between the feet |
| arbitrary facing | rotated by `yaw` so it faces `+Y` in Blender = `-Z` in three.js |
| photographic PBR texture | posterised — **off for this model** (`restyle=False`) |

Sources come from `blender/raw/<id>.glb` (or `.blend`) by default; the `src=` field in a
`ROSTER` entry overrides that, which is how `eng_m1` points at
`blender/source/eng_m1_meshy.blend`. `--chibi 1.45` force-scales the head bone if a generator
under-delivers on proportions.

`rig_character.py` adds a 17-bone biped scaled to the character's height, binds it with
automatic weights (validated, with a rigid per-region fallback), authors `Idle`, `Walk`,
`Sit`, `SitIdle`, and trims the textures the office never samples. It writes verification
renders to `renders/rig_<id>_*.png` — check those before opening the browser.

Useful flags: `--id <name>` picks one character, `--tex 2048` keeps a bigger base colour,
`--keep-maps` keeps the normal and roughness maps, `--no-render` skips the check renders.

### The seat-height contract

The `Sit` clip ends with the hips at `sit_hip_y` above the object origin, and the runtime
puts the root at `seat.y - sit_hip_y`. One clip therefore serves all 16 seats even though
their hip heights range 0.45–0.55 m. The value is written into `characters.json` per
character, because the armature is scaled by `height / 1.38` — a 1.31 m engineer gets 0.437
and the 1.40 m manager gets 0.467. This works because a chibi's legs are shorter than the
chairs: the feet dangle and never touch the floor, so the offset never shows.

## Things that bite

- **`seats.json` has four bad approach points.** `Sofa_seat1/2/3` and `MC2` sit inside
  furniture, because the generator used `seat − forward × 0.75` even where `−forward` points
  into a wall. `NavGrid.repairApproaches()` re-derives them at load and logs a table. Fix the
  generator if you regenerate the scene.
- **glTF node names are not the Blender names.** `GLTFLoader` strips dots, so `Picture.001`
  arrives as `Picture001` and `Window_1.6` as `Window_16`. `src/hotspots.js` uses the loaded
  spelling.
- **Office nodes are not all flat.** Some, like `TV`, wrap child meshes, so a raycast hit has
  to be walked up to the child of the loaded glTF scene — that is what `topName()` does.
- **Asset weight is 11 MB** (office 5.8 + character 5.6). Fine on localhost. Most of the
  character is three 2048² textures where the scene only uses base colour; dropping the
  normal and roughness maps and halving the base colour would get it near 0.4 MB.
- **59k triangles on the character** against the ~15k that five characters would want. Fine
  for one.

## Adding the rest of the cast

`ROSTER` in `blender/normalize_character.py` already lists `eng_m2`, `eng_f1`, `eng_f2` and
`manager`. Drop a model at `blender/raw/<id>.glb`, run both Blender scripts, and they appear in
`characters.json`. The app spawns from the manifest, so the only app-side change is deciding
where each one starts.
