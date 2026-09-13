# normalize_character.py -- put a generated character into the UBE office's coordinate system.
#
# Meshy, Tripo and friends all hand back the same three problems: the mesh is normalised into
# a unit box, its origin floats mid-body, and it faces an arbitrary direction. The office is
# real-scale (desk 0.74 m, chair seat 0.51 m), so none of that lines up. This fixes all three
# in one pass, optionally flattens a photographic texture to match the office's 28 flat
# colours, and leaves two usable things:
#
#   blender/scenes/ube_characters.blend  -- open it and keep working by hand
#   export/characters/*.glb              -- served straight to the web app
#
# Workflow
#   1. put new generator output in  blender/raw/  named  eng_m2.glb, eng_f1.glb, ...
#      (or point a ROSTER entry at any file with src=, which is how eng_m1 works)
#   2. blender -b --python normalize_character.py -- --stage all
#   3. check renders/characters_lineup.png -- if somebody faces the wrong way,
#      set their "yaw" in ROSTER below (90 / 180 / 270) and run again
#   4. check renders/office_with_people.png -- that is the real "does it fit" test
#   5. then rig them: blender -b --python rig_character.py
#
# Stages:  normalize | check | all     (default: all)

import bpy, sys, os, re, json, math, argparse
import numpy as np
from mathutils import Vector

# This file lives in blender/; the web app's static root is ../export.
HERE    = os.path.dirname(os.path.abspath(__file__))
ROOT    = os.path.dirname(HERE)
RAW_DIR = os.path.join(HERE, "raw")                       # drop new generator output here
OUT_DIR = os.path.join(ROOT, "export", "characters")      # served by vite as /characters
RENDERS = os.path.join(ROOT, "renders")
OFFICE  = os.path.join(HERE, "scenes", "ube_iso_office.blend")
SEATS   = os.path.join(ROOT, "export", "seats.json")
BLEND   = os.path.join(HERE, "scenes", "ube_characters.blend")

# ============================ roster ============================
# Big-head chibi, about 3 heads tall. Those heights are not arbitrary: at 3 heads a
# 1.38 m chibi has roughly a 0.46 m head, a 0.38 m torso and 0.54 m legs, so the hip
# joint lands within 3 cm of the 0.51 m chair seat already in export/seats.json --
# they sit down without touching the office. Standing, the eyes clear a 0.74 m desk
# and the 1.07 m top of a monitor, and the head is ~50 px at the iso camera
# (110 px/m) instead of the ~25 px a realistic head would get.
#
# height   : metres, floor to top of head (hair included).
# yaw      : degrees about Z so the character ends up facing +Y in Blender
#            (= -Z in three.js, the forward this project uses). Fix by eye, step 3.
# stand_at : seat name from export/seats.json. The check render stands them on that
#            chair's "approach" spot, facing the chair's forward.
# src      : optional. By default the source is blender/raw/<id>.glb (or .blend). Point this
#            at any path instead -- Meshy hands back a .blend, Tripo a .glb.
ROSTER = {
    "eng_m1":  dict(label="Male Engineer 1",   height=1.38, yaw=180.0, stand_at="ChairA1",
                    src="source/eng_m1_meshy.blend", restyle=False),
    "eng_m2":  dict(label="Male Engineer 2",   height=1.36, yaw=180.0, stand_at="ChairB2"),
    "eng_f1":  dict(label="Female Engineer 1", height=1.31, yaw=180.0, stand_at="ChairA4",
                    src="source/eng_f1_meshy.blend", restyle=False),
    "eng_f2":  dict(label="Female Engineer 2", height=1.30, yaw=0.0, stand_at="ChairB4"),
    "manager": dict(label="Manager",           height=1.40, yaw=180.0, stand_at="ManagerChair",
                    src="source/manager_meshy.blend", restyle=False),
}

# ============================ chibi safety net ============================
# Generators often soften a "3 heads tall" prompt back towards normal proportions. If the
# lineup render comes back not cute enough, turn this on: it scales the head bone and
# bakes the result into the rest pose, so the chibi shape ships inside the GLB.
# Needs a rigged model -- it is a no-op on an unrigged one.
CHIBI = dict(
    enabled    = False,            # flip to True only if the generator under-delivers
    head_scale = 1.45,             # 1.3 = a nudge, 1.6 = very big head
    head_bone  = r"head|skull",    # matched case-insensitively against the bone names
)

# ============================ look ============================
# The office has 28 flat colours and zero textures, so a photographic generator texture
# sticks out badly. We posterise it and pull the saturation down until it reads as the
# same art direction. This is done on the image PIXELS rather than with shader nodes,
# so the result survives the glTF export: Blender and three.js show the same thing.
STYLE = dict(
    steps      = 4,     # colour levels per channel; 4-6 reads flat, 10+ keeps photo detail
    saturation = 0.74,  # the office palette is muted
    value      = 1.04,  # lift back up after desaturating
    roughness  = 0.62,  # matches the office matte surfaces
    drop_maps  = True,  # throw away normal / roughness / metallic maps
    smooth_deg = 16.0,  # low on purpose: the office is faceted, so the chibi stays faceted
)

# ============================ small helpers ============================
def log(*a):
    print("[blender]", *a)

def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures,
              bpy.data.actions, bpy.data.lights, bpy.data.cameras):
        for d in list(c):
            if d.users == 0:
                try: c.remove(d)
                except Exception: pass

def select(objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)

def world_bbox(objs):
    lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo[i], w[i]) for i in range(3)))
            hi = Vector((max(hi[i], w[i]) for i in range(3)))
    return lo, hi

def roots_of(objs):
    s = set(objs)
    return [o for o in objs if o.parent is None or o.parent not in s]

# ============================ 1. import + normalise ============================
def source_for(cid, spec):
    """blender/raw/<id>.glb by default; a ROSTER 'src' overrides it. .blend is fine too."""
    if spec.get("src"):
        p = spec["src"]
        return p if os.path.isabs(p) else os.path.join(HERE, p)
    for ext in (".glb", ".gltf", ".blend"):
        p = os.path.join(RAW_DIR, cid + ext)
        if os.path.exists(p):
            return p
    return None

def import_any(path):
    """Import a glTF, or append every object out of a .blend."""
    before = set(bpy.data.objects)
    if path.lower().endswith(".blend"):
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = list(src.objects)
        for o in dst.objects:
            if o is not None:
                bpy.context.collection.objects.link(o)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]

import_glb = import_any        # kept: stage_check imports the exported GLBs

def chibify(objs, cfg=CHIBI):
    """Scale the head bone and bake it into the rest pose. Run before normalize()."""
    if not cfg["enabled"]:
        return
    arm = next((o for o in objs if o.type == "ARMATURE"), None)
    if not arm:
        log("  chibi: no armature, nothing to scale")
        return
    pb = next((b for b in arm.pose.bones if re.search(cfg["head_bone"], b.name, re.I)), None)
    if not pb:
        log("  chibi: no bone matching %r in %s" % (cfg["head_bone"],
                                                   [b.name for b in arm.pose.bones][:12]))
        return
    try:
        select([arm], arm)
        bpy.ops.object.mode_set(mode="POSE")
        pb.scale = (cfg["head_scale"],) * 3
        bpy.ops.object.mode_set(mode="OBJECT")
        for o in objs:                      # freeze the pose into the meshes...
            mods = [m for m in o.modifiers if m.type == "ARMATURE"] if o.type == "MESH" else []
            for m in mods:
                select([o], o)
                bpy.ops.object.modifier_copy(modifier=m.name)   # keep one for later
                bpy.ops.object.modifier_apply(modifier=m.name)
        select([arm], arm)                  # ...then make it the new rest pose
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.armature_apply()
        bpy.ops.object.mode_set(mode="OBJECT")
        log("  chibi: head bone %r scaled x%.2f" % (pb.name, cfg["head_scale"]))
    except Exception as e:
        try: bpy.ops.object.mode_set(mode="OBJECT")
        except Exception: pass
        log("  chibi: skipped --", e)

def normalize(objs, height, yaw_deg, name):
    """Real-scale, feet on the floor, centred on the origin, facing +Y."""
    rts = roots_of(objs)
    if not rts:
        raise RuntimeError("nothing imported")
    if len(rts) == 1:
        root = rts[0]
    else:                                     # give the character one handle
        root = bpy.data.objects.new(name + "_root", None)
        bpy.context.collection.objects.link(root)
        for o in rts:
            mw = o.matrix_world.copy(); o.parent = root; o.matrix_world = mw
        objs = objs + [root]
    root.name = name

    root.rotation_mode = "XYZ"
    root.rotation_euler.z += math.radians(yaw_deg)
    bpy.context.view_layer.update()

    lo, hi = world_bbox(objs)
    span = hi.z - lo.z
    if span < 1e-6:
        raise RuntimeError("zero-height mesh")
    s = height / span
    root.scale = tuple(v * s for v in root.scale)
    bpy.context.view_layer.update()

    lo, hi = world_bbox(objs)
    root.location -= Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    bpy.context.view_layer.update()

    select([o for o in objs if o.type in {"MESH", "ARMATURE", "EMPTY"}], root)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    lo, hi = world_bbox(objs)
    log("  %-8s %.3f m tall, %.3f m wide, source scale x%.3f"
        % (name, hi.z - lo.z, hi.x - lo.x, s))
    return root, objs, s

# ============================ 2. restyle ============================
def _srgb(a):
    return np.where(a <= 0.0031308, a * 12.92,
                    1.055 * np.power(np.clip(a, 1e-8, None), 1 / 2.4) - 0.055)

def _linear(a):
    return np.where(a <= 0.04045, a / 12.92,
                    np.power((np.clip(a, 0, None) + 0.055) / 1.055, 2.4))

def posterize_image(img, steps, sat, val):
    """Flatten a Tripo texture into office-style poster colours. Returns a NEW image."""
    w, h = img.size
    if w * h == 0:
        return img
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    a = buf.reshape(-1, 4)
    rgb = _srgb(a[:, :3])                                    # work in display space
    rgb = np.floor(rgb * steps + 0.5) / steps                # posterise
    lum = (rgb * np.array([0.2126, 0.7152, 0.0722])).sum(1, keepdims=True)
    rgb = np.clip((lum + (rgb - lum) * sat) * val, 0, 1)     # desaturate, then lift
    a[:, :3] = _linear(rgb)
    out = bpy.data.images.new(img.name + "_flat", w, h, alpha=True, float_buffer=False)
    out.pixels.foreach_set(a.reshape(-1))
    out.pack()
    return out

def _find_image_node(nt, socket):
    """Walk back from a socket to the Image Texture feeding it, if any."""
    n = socket.links[0].from_node if socket.is_linked else None
    seen = 0
    while n is not None and n.type != "TEX_IMAGE" and seen < 8:
        ins = [i for i in n.inputs if i.is_linked]
        n = ins[0].links[0].from_node if ins else None
        seen += 1
    return n if (n is not None and n.type == "TEX_IMAGE") else None

def restyle(objs, st=STYLE):
    done = {}
    mats = {s.material for o in objs if o.type == "MESH"
            for s in o.material_slots if s.material}
    for m in mats:
        if not m.use_nodes:
            continue
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        base = bsdf.inputs["Base Color"]
        tex = _find_image_node(nt, base)
        if tex is not None and tex.image:
            key = tex.image.name
            if key not in done:
                done[key] = posterize_image(tex.image, st["steps"], st["saturation"], st["value"])
            tex.image = done[key]
            tex.image.colorspace_settings.name = "sRGB"
            nt.links.new(tex.outputs["Color"], base)   # bypass any mix chain in between
        if st["drop_maps"]:
            for k in ("Normal", "Roughness", "Metallic", "Specular IOR Level", "Coat Weight"):
                if k in bsdf.inputs:
                    for l in list(bsdf.inputs[k].links):
                        nt.links.remove(l)
        bsdf.inputs["Roughness"].default_value = st["roughness"]
        bsdf.inputs["Metallic"].default_value = 0.0
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.28
    for o in objs:
        if o.type != "MESH":
            continue
        select([o], o)
        try:
            bpy.ops.object.shade_auto_smooth(angle=math.radians(st["smooth_deg"]))
        except Exception:
            bpy.ops.object.shade_smooth()
    log("  restyled %d material(s), %d texture(s)" % (len(mats), len(done)))

# ============================ 3. export ============================
def export_character(cid, objs, root, height, src_scale):
    os.makedirs(OUT_DIR, exist_ok=True)
    keep = root.location.copy()
    root.location = (0, 0, 0)
    bpy.context.view_layer.update()
    select([o for o in objs if o.type in {"MESH", "ARMATURE", "EMPTY"}], root)
    path = os.path.join(OUT_DIR, cid + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_apply=False, export_yup=True,
                              export_lights=False, export_cameras=False,
                              export_animations=True, export_skins=True)
    root.location = keep
    bpy.context.view_layer.update()
    arm = next((o for o in objs if o.type == "ARMATURE"), None)
    tris = 0
    for o in objs:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    return {"file": cid + ".glb",
            "height_m": round(height, 3),
            "source_scale": round(src_scale, 5),
            "rigged": bool(arm),
            "bones": sorted(b.name for b in arm.data.bones)[:80] if arm else [],
            "animations": sorted({a.name for a in bpy.data.actions}) if arm else [],
            "tris": tris}

# ============================ 4. studio + render ============================
def _area(name, loc, aim, energy, size):
    d = bpy.data.lights.new(name, type="AREA"); d.energy = energy; d.size = size
    o = bpy.data.objects.new(name, d); bpy.context.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return o

def use_gpu(scene):
    for dev in (os.environ.get("CYCLES_DEVICE", "CUDA"), "OPTIX", "HIP", "ONEAPI"):
        try:
            p = bpy.context.preferences.addons["cycles"].preferences
            p.compute_device_type = dev
            p.get_devices()
            if any(d.type == dev for d in p.devices):
                for d in p.devices:
                    d.use = True
                scene.cycles.device = "GPU"
                log("  render device:", dev)
                return
        except Exception:
            continue
    scene.cycles.device = "CPU"

def studio(res, samples, focus=(0, 0, 0.95), bg=0.70):
    sc = bpy.context.scene
    w = sc.world or bpy.data.worlds.new("World"); sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    b = nt.nodes.new("ShaderNodeBackground")
    b.inputs["Color"].default_value = (bg, bg, bg * 1.02, 1)
    b.inputs["Strength"].default_value = 0.8
    nt.links.new(b.outputs["Background"], out.inputs["Surface"])
    _area("Key",  (-2.6, -3.2, 3.4), focus, 900, 3.0)
    _area("Fill", (3.2, -2.2, 1.8), focus, 300, 3.4)
    _area("Rim",  (1.4, 3.4, 3.2), focus, 500, 2.6)
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    use_gpu(sc)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Base Contrast"

def ortho_cam(target, dist, yaw, pitch, ortho, name="Cam"):
    for c in [o for o in bpy.data.objects if o.type == "CAMERA" and o.name.startswith(name)]:
        bpy.data.objects.remove(c, do_unlink=True)
    d = bpy.data.cameras.new(name); d.type = "ORTHO"; d.ortho_scale = ortho
    c = bpy.data.objects.new(name, d); bpy.context.collection.objects.link(c)
    t = Vector(target)
    v = Vector((math.sin(math.radians(yaw)) * math.cos(math.radians(pitch)),
                -math.cos(math.radians(yaw)) * math.cos(math.radians(pitch)),
                math.sin(math.radians(pitch))))
    c.location = t + v * dist
    c.rotation_euler = (t - c.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = c
    return c

def render_to(path, samples=None):
    sc = bpy.context.scene
    if samples:
        sc.cycles.samples = samples
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    log("  wrote", path)

def ground(size=14.0):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    p = bpy.context.active_object
    p.name = "Ground"
    m = bpy.data.materials.new("Ground")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.78, 0.78, 0.79, 1)
    b.inputs["Roughness"].default_value = 0.85
    p.data.materials.append(m)
    return p

# ============================ stages ============================
def stage_normalize(samples=96, force=False):
    clear_scene()
    manifest = {"meta": {"units": "metres",
                         "forward": "-Z in three.js (character faces -Z)",
                         "up": "+Y",
                         "origin": "between the feet, on the floor",
                         "source": "generated model, normalised by blender/normalize_character.py",
                         "style": dict(STYLE)},
                "characters": {}}
    srcs = {c: source_for(c, ROSTER[c]) for c in ROSTER}
    ids = [c for c in ROSTER if srcs[c] and os.path.exists(srcs[c])]
    missing = [c for c in ROSTER if c not in ids]
    if missing:
        log("no source for:", ", ".join(missing))
    if not ids:
        os.makedirs(RAW_DIR, exist_ok=True)
        log("nothing to do -- put eng_m2.glb etc. in", RAW_DIR,
            "or point a ROSTER entry at a file with src=")
        return manifest

    # This stage exports an UNRIGGED mesh. Running it after rig_character.py would silently
    # throw the armature and all four clips away, and the app would stop walking.
    already = set()
    mpath = os.path.join(OUT_DIR, "characters.json")
    if os.path.exists(mpath):
        with open(mpath, encoding="utf-8") as f:
            doc = json.load(f)
        already = {c for c, v in doc.get("characters", {}).items() if v.get("rigged")}
    clash = already & set(ids)
    if clash and not force:
        log("refusing to overwrite rigged character(s):", ", ".join(sorted(clash)))
        log("  re-running this stage would drop their armature and clips.")
        log("  to rebuild from source anyway:  -- --stage normalize --force")
        log("  to only re-rig:                 blender -b --python rig_character.py")
        ids = [c for c in ids if c not in clash]
        if not ids:
            return manifest

    built = []
    for cid in ids:
        spec = ROSTER[cid]
        log("importing", cid, "from", os.path.basename(srcs[cid]))
        objs = import_any(srcs[cid])
        chibify(objs)
        root, objs, s = normalize(objs, spec["height"], spec["yaw"], cid)
        # A generator that already ships flat, scene-appropriate colours is left alone;
        # only photographic output needs posterising.
        if spec.get("restyle", True):
            restyle(objs)
        else:
            log("  restyle skipped -- keeping the original textures untouched")
        info = export_character(cid, objs, root, spec["height"], s)
        info["label"] = spec["label"]
        manifest["characters"][cid] = info
        built.append(root)

    span = 0.95
    for i, root in enumerate(built):                      # lay the lineup out centred
        root.location.x = (i - (len(built) - 1) / 2) * span

    with open(os.path.join(OUT_DIR, "characters.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    log("wrote", os.path.join(OUT_DIR, "characters.json"))

    ground()
    res = (1800, 900)
    studio(res=res, samples=samples, focus=(0, 0, 0.95))
    tallest = max(ROSTER[c]["height"] for c in ids)
    # ortho_scale is the horizontal span, so frame on whichever of the two is tighter
    ortho = max(span * len(built) + 0.8, (tallest + 0.35) * res[0] / res[1])
    ortho_cam((0, 0, tallest / 2), 8.0, -12, 6, ortho)
    render_to(os.path.join(RENDERS, "characters_lineup.png"))
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    log("saved", BLEND)
    return manifest

def stage_check(samples=110):
    """Put everybody in the real office and render with the office's own iso camera."""
    if not os.path.exists(OFFICE):
        log("no office blend at", OFFICE)
        return
    clear_scene()
    with bpy.data.libraries.load(OFFICE, link=False) as (src, dst):
        dst.objects = list(src.objects)
        dst.worlds = list(src.worlds)               # the white studio backdrop lives here
    for o in dst.objects:
        if o is not None:
            bpy.context.collection.objects.link(o)
    if dst.worlds:
        bpy.context.scene.world = dst.worlds[0]
    cam = next((o for o in bpy.data.objects if o.type == "CAMERA"), None)
    if cam:
        bpy.context.scene.camera = cam
    log("office loaded:", len(dst.objects), "objects,", len(dst.worlds), "world(s)")

    seats = {}
    if os.path.exists(SEATS):
        with open(SEATS, encoding="utf-8") as f:
            seats = {s["name"]: s for s in json.load(f)["seats"]}

    for cid, spec in ROSTER.items():
        glb = os.path.join(OUT_DIR, cid + ".glb")
        if not os.path.exists(glb):
            continue
        objs = import_glb(glb)
        root = roots_of(objs)[0]
        st = seats.get(spec["stand_at"])
        if st:
            ap = st["blender"]["approach"]
            fw = st["blender"]["forward"]
            root.location = (ap[0], ap[1], 0.0)
            root.rotation_mode = "XYZ"
            root.rotation_euler.z = -math.atan2(fw[0], fw[1])
            log("  placed %-8s at %s" % (cid, spec["stand_at"]))

    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    use_gpu(sc)
    sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
    sc.view_settings.view_transform = "Standard"    # same grade as renders/ube_iso_office_final
    sc.view_settings.exposure = -0.3
    render_to(os.path.join(RENDERS, "office_with_people.png"))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "ube_office_people.blend"))

# ============================ cli ============================
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="normalize_character")
    ap.add_argument("--stage", default="all", choices=["normalize", "check", "all"])
    ap.add_argument("--samples", type=int, default=96)
    ap.add_argument("--chibi", type=float, metavar="SCALE",
                    help="force the head bigger, e.g. --chibi 1.45 (overrides CHIBI in this file)")
    ap.add_argument("--force", action="store_true",
                    help="re-normalise even a character that is already rigged (drops its clips)")
    a = ap.parse_args(argv)
    if a.chibi:
        CHIBI["enabled"] = True
        CHIBI["head_scale"] = a.chibi
    if a.stage in ("normalize", "all"):
        stage_normalize(a.samples, a.force)
    if a.stage in ("check", "all"):
        stage_check(a.samples + 16)
    log("done")

if __name__ == "__main__":
    main()
