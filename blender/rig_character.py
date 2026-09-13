# rig_character.py -- give the normalised chibi a biped armature and the clips the web app needs.
#
# The Meshy model arrives as one unrigged mesh, so it can stand but not walk or sit. This
# script builds a 17-bone armature sized to the 1.38 m chibi, binds the mesh to it, authors
# Idle / Walk / Sit / SitIdle as separate Actions, and re-exports the GLB with all four as
# glTF animation clips.
#
#   blender -b --python rig_character.py
#   blender -b --python rig_character.py -- --id eng_m1 --no-render
#
# Outputs: export/characters/<id>.glb (now rigged), characters.json, ube_characters.blend,
#          renders/rig_*.png
#
# Seat height contract: the Sit clip finishes with the hips at SIT_HIP_Y above the object
# origin. The runtime puts the root at (seat.y - SIT_HIP_Y) so one clip serves all 16 seats,
# whose hip heights range 0.45-0.55 m. SIT_HIP_Y is written into characters.json.

import bpy, sys, os, json, math, argparse
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import normalize_character as T   # reuse clear_scene / import_any / normalize / studio / render

R = math.radians
OUT_DIR = T.OUT_DIR
REF_HEIGHT = 1.38                 # the height BONES below were measured on
SIT_HIP_Y  = 0.46                 # hip height at the end of the Sit clip, metres

# ============================ skeleton ============================
# head -> tail, in the normalised model's space: feet on z=0, hips 0.50, shoulders 0.80,
# chin 0.85, top of hair 1.38. Character faces +Y.
BONES = [
    # name          head                 tail                 parent        connected
    ("Root",       (0.000, 0.00, 0.000), (0.000, 0.00, 0.100), None,        False),
    ("Hips",       (0.000, 0.00, 0.500), (0.000, 0.00, 0.660), "Root",      False),
    ("Spine",      (0.000, 0.00, 0.660), (0.000, 0.00, 0.820), "Hips",      True),
    ("Head",       (0.000, 0.00, 0.840), (0.000, 0.00, 1.300), "Spine",     False),
    ("UpperArm.L", (0.170, 0.00, 0.790), (0.260, 0.00, 0.630), "Spine",     False),
    ("LowerArm.L", (0.260, 0.00, 0.630), (0.300, 0.00, 0.500), "UpperArm.L", True),
    ("Hand.L",     (0.300, 0.00, 0.500), (0.300, 0.00, 0.430), "LowerArm.L", True),
    ("UpperArm.R", (-0.170, 0.00, 0.790), (-0.260, 0.00, 0.630), "Spine",   False),
    ("LowerArm.R", (-0.260, 0.00, 0.630), (-0.300, 0.00, 0.500), "UpperArm.R", True),
    ("Hand.R",     (-0.300, 0.00, 0.500), (-0.300, 0.00, 0.430), "LowerArm.R", True),
    ("UpperLeg.L", (0.085, 0.00, 0.490), (0.090, 0.00, 0.280), "Hips",      False),
    ("LowerLeg.L", (0.090, 0.00, 0.280), (0.090, 0.00, 0.090), "UpperLeg.L", True),
    ("Foot.L",     (0.090, 0.00, 0.090), (0.090, 0.14, 0.030), "LowerLeg.L", True),
    ("UpperLeg.R", (-0.085, 0.00, 0.490), (-0.090, 0.00, 0.280), "Hips",    False),
    ("LowerLeg.R", (-0.090, 0.00, 0.280), (-0.090, 0.00, 0.090), "UpperLeg.R", True),
    ("Foot.R",     (-0.090, 0.00, 0.090), (-0.090, 0.14, 0.030), "LowerLeg.R", True),
]
LEG_BONES  = {"UpperLeg.L", "LowerLeg.L", "Foot.L", "UpperLeg.R", "LowerLeg.R", "Foot.R"}
HAND_BONES = {"Hand.L", "Hand.R"}

def build_armature(name="rig", scale=1.0):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    bpy.context.collection.objects.link(arm)
    T.select([arm], arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    for bname, head, tail, parent, connect in BONES:
        b = eb.new(bname)
        b.head, b.tail = Vector(head) * scale, Vector(tail) * scale
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm

# ============================ binding ============================
def bind(mesh, arm, scale=1.0):
    """Heat-map weights, then prove the bind is sane before trusting it."""
    T.select([mesh, arm], arm)
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    problems = check_weights(mesh, True, scale)
    if problems:
        for p in problems:
            T.log("  bind warning:", p)
        T.log("  falling back to rigid per-region weights")
        rigid_weights(mesh, arm, scale)
        problems = check_weights(mesh, False, scale)
        for p in problems:
            T.log("  still odd after fallback:", p)
    else:
        T.log("  automatic weights look clean")
    return mesh

def check_weights(mesh, strict=True, scale=1.0):
    """Catch the two ways a chibi bind goes wrong: legs grabbing the head, hands grabbing
    the torso. Both show up as weight far from where the bone actually is."""
    byindex = {g.index: g.name for g in mesh.vertex_groups}
    bad = []
    leg_on_head = hand_on_torso = unweighted = 0
    lowest = 1.0
    for v in mesh.data.vertices:
        total = sum(g.weight for g in v.groups)
        lowest = min(lowest, total)
        if total < 0.5:                       # genuinely unbound, not a rounding difference
            unweighted += 1
        for g in v.groups:
            gname = byindex.get(g.group)
            if gname is None or g.weight < 0.2:
                continue
            if gname in LEG_BONES and v.co.z > 0.86 * scale:
                leg_on_head += 1
            if gname in HAND_BONES and abs(v.co.x) < 0.12 * scale:
                hand_on_torso += 1
    T.log("  weights: %d groups, lowest vertex total %.3f" % (len(mesh.vertex_groups), lowest))
    if leg_on_head:
        bad.append("%d verts above the chin are weighted to a leg bone" % leg_on_head)
    if hand_on_torso:
        bad.append("%d torso verts are weighted to a hand bone" % hand_on_torso)
    if strict and unweighted:
        bad.append("%d verts are unbound" % unweighted)
    return bad

def rigid_weights(mesh, arm, scale=1.0):
    """One bone per region, weight 1.0. Ugly at the joints but never catastrophic."""
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    groups = {b[0]: mesh.vertex_groups.new(name=b[0]) for b in BONES}

    def region(co):
        x, y, z = co
        z /= scale; x /= scale
        if z > 0.845:
            return "Head"
        if z < 0.50:                                   # below the belt: legs, unless it is a hand
            if abs(x) > 0.24:
                return "Hand.L" if x > 0 else "Hand.R"
            side = "L" if x > 0 else "R"
            if z > 0.28: return "UpperLeg." + side
            if z > 0.09: return "LowerLeg." + side
            return "Foot." + side
        if abs(x) > 0.155:                             # out past the torso: arms
            side = "L" if x > 0 else "R"
            return "UpperArm." + side if z > 0.66 else "LowerArm." + side
        return "Spine" if z > 0.66 else "Hips"

    buckets = {}
    for v in mesh.data.vertices:
        buckets.setdefault(region(v.co), []).append(v.index)
    for name, idx in buckets.items():
        groups[name].add(idx, 1.0, "REPLACE")
    if not any(m.type == "ARMATURE" for m in mesh.modifiers):
        md = mesh.modifiers.new("Armature", "ARMATURE")
        md.object = arm
        mesh.parent = arm

# ============================ clips ============================
# Every pose is {bone: (rx, ry, rz)} in degrees, plus an optional "Hips@loc" translation.
# Bone local +Y runs head->tail, so a rotation about local X swings a limb forward/back.
A_POSE = {}

WALK = {
    1:  {"UpperLeg.L": (26, 0, 0), "LowerLeg.L": (-8, 0, 0),
         "UpperLeg.R": (-24, 0, 0), "LowerLeg.R": (-30, 0, 0),
         "UpperArm.L": (-18, 0, 0), "LowerArm.L": (14, 0, 0),
         "UpperArm.R": (18, 0, 0),  "LowerArm.R": (20, 0, 0),
         "Spine": (2, 0, 0), "Hips@loc": (0, 0.0, 0)},
    7:  {"UpperLeg.L": (2, 0, 0),  "LowerLeg.L": (-4, 0, 0),
         "UpperLeg.R": (-2, 0, 0), "LowerLeg.R": (-14, 0, 0),
         "UpperArm.L": (-2, 0, 0), "LowerArm.L": (16, 0, 0),
         "UpperArm.R": (2, 0, 0),  "LowerArm.R": (16, 0, 0),
         "Spine": (2, 0, 0), "Hips@loc": (0, 0.022, 0)},
    13: {"UpperLeg.L": (-24, 0, 0), "LowerLeg.L": (-30, 0, 0),
         "UpperLeg.R": (26, 0, 0),  "LowerLeg.R": (-8, 0, 0),
         "UpperArm.L": (18, 0, 0),  "LowerArm.L": (20, 0, 0),
         "UpperArm.R": (-18, 0, 0), "LowerArm.R": (14, 0, 0),
         "Spine": (2, 0, 0), "Hips@loc": (0, 0.0, 0)},
    19: {"UpperLeg.L": (-2, 0, 0), "LowerLeg.L": (-14, 0, 0),
         "UpperLeg.R": (2, 0, 0),  "LowerLeg.R": (-4, 0, 0),
         "UpperArm.L": (2, 0, 0),  "LowerArm.L": (16, 0, 0),
         "UpperArm.R": (-2, 0, 0), "LowerArm.R": (16, 0, 0),
         "Spine": (2, 0, 0), "Hips@loc": (0, 0.022, 0)},
}
WALK[25] = WALK[1]

IDLE = {
    1:  {"Spine": (0, 0, 0),    "Head": (0, 0, 0),
         "UpperArm.L": (0, 0, 0), "UpperArm.R": (0, 0, 0)},
    30: {"Spine": (-1.6, 0, 0), "Head": (1.0, 0, 0),
         "UpperArm.L": (-2, 0, 0), "UpperArm.R": (-2, 0, 0), "Hips@loc": (0, 0.008, 0)},
    60: {"Spine": (0, 0, 0),    "Head": (0, 0, 0),
         "UpperArm.L": (0, 0, 0), "UpperArm.R": (0, 0, 0)},
}

SEATED = {
    "UpperLeg.L": (88, 0, 0), "LowerLeg.L": (-82, 0, 0), "Foot.L": (-8, 0, 0),
    "UpperLeg.R": (88, 0, 0), "LowerLeg.R": (-82, 0, 0), "Foot.R": (-8, 0, 0),
    "UpperArm.L": (14, 0, 8), "LowerArm.L": (34, 0, 0),
    "UpperArm.R": (14, 0, -8), "LowerArm.R": (34, 0, 0),
    "Spine": (-6, 0, 0), "Head": (3, 0, 0),
    "Hips@loc": (0, SIT_HIP_Y - 0.50, 0),          # bone local +Y is up, so this lowers the hips
}
SIT = {1: dict(A_POSE), 12: {k: v for k, v in SEATED.items()}, 30: dict(SEATED)}
SIT[12] = {k: (tuple(c * 0.55 for c in v) if k != "Hips@loc" else tuple(c * 0.55 for c in v))
           for k, v in SEATED.items()}

SIT_IDLE = {
    1:  dict(SEATED),
    30: dict(SEATED, Spine=(-7.4, 0, 0), Head=(3.8, 0, 0)),
    60: dict(SEATED),
}

def apply_pose(arm, pose, scale=1.0):
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    for key, val in pose.items():
        if key.endswith("@loc"):
            bone = key.split("@")[0]
            if bone in arm.pose.bones:
                arm.pose.bones[bone].location = Vector(val) * scale
        elif key in arm.pose.bones:
            arm.pose.bones[key].rotation_euler = tuple(R(a) for a in val)

def make_action(arm, name, frames, scale=1.0):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    for f in sorted(frames):
        bpy.context.scene.frame_set(f)
        apply_pose(arm, frames[f], scale)
        for pb in arm.pose.bones:
            pb.keyframe_insert(data_path="rotation_euler", frame=f)
            pb.keyframe_insert(data_path="location", frame=f)
    act.use_frame_range = True
    act.frame_start, act.frame_end = min(frames), max(frames)
    T.log("  clip %-8s frames %d-%d" % (name, min(frames), max(frames)))
    return act

def author_clips(arm, scale=1.0):
    acts = [make_action(arm, "Idle", IDLE, scale),
            make_action(arm, "Walk", WALK, scale),
            make_action(arm, "Sit", SIT, scale),
            make_action(arm, "SitIdle", SIT_IDLE, scale)]
    arm.animation_data.action = acts[0]
    bpy.context.scene.frame_set(1)
    apply_pose(arm, A_POSE, scale)
    return [a.name for a in acts]

# ============================ trim for the web ============================
# Meshy ships base colour + normal + roughness at 2048 each. The office it has to stand in
# has no textures at all and is lit by two lights, so the normal and roughness maps are paid
# for and never seen. Dropping them and halving the base colour takes a character from
# ~5.6 MB to well under 1 MB without touching geometry, UVs or colour.
WEB = dict(max_texture=1024, drop_maps=True, roughness=0.62)

def slim_for_web(objs, cfg=WEB):
    mats = {s.material for o in objs if o.type == "MESH" for s in o.material_slots if s.material}
    kept = dropped = 0
    before = after = 0
    for m in mats:
        if not m.use_nodes:
            continue
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        base_tex = T._find_image_node(nt, bsdf.inputs["Base Color"])
        if cfg["drop_maps"]:
            for k in ("Normal", "Roughness", "Metallic", "Specular IOR Level", "Coat Weight"):
                if k in bsdf.inputs:
                    for l in list(bsdf.inputs[k].links):
                        nt.links.remove(l)
            bsdf.inputs["Roughness"].default_value = cfg["roughness"]
            bsdf.inputs["Metallic"].default_value = 0.0
        # anything no longer feeding the shader would still be packed into the GLB
        for n in list(nt.nodes):
            if n.type == "TEX_IMAGE" and n is not base_tex and not n.outputs[0].links:
                if n.image:
                    before += n.image.size[0] * n.image.size[1]
                nt.nodes.remove(n)
                dropped += 1
        if base_tex and base_tex.image:
            img = base_tex.image
            w, h = img.size
            before += w * h
            mx = cfg["max_texture"]
            if max(w, h) > mx:
                s = mx / max(w, h)
                img.scale(max(1, int(w * s)), max(1, int(h * s)))
            after += img.size[0] * img.size[1]
            kept += 1
    T.log("  web: kept %d texture(s), dropped %d -- %.1f -> %.1f megapixels"
          % (kept, dropped, before / 1e6, after / 1e6))

# ============================ export ============================
def export(cid, mesh, arm, clips, scale=1.0):
    os.makedirs(OUT_DIR, exist_ok=True)
    T.select([mesh, arm], arm)
    path = os.path.join(OUT_DIR, cid + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_apply=False, export_yup=True,
                              export_lights=False, export_cameras=False,
                              export_skins=True, export_animations=True,
                              export_animation_mode="ACTIONS",
                              export_bake_animation=True)
    mesh.data.calc_loop_triangles()
    info = {"file": cid + ".glb",
            "label": T.ROSTER.get(cid, {}).get("label", cid),
            "height_m": T.ROSTER.get(cid, {}).get("height", 1.38),
            "rigged": True,
            "bones": [b[0] for b in BONES],
            "animations": clips,
            "sit_hip_y": round(SIT_HIP_Y * scale, 4),
            "tris": len(mesh.data.loop_triangles)}
    mpath = os.path.join(OUT_DIR, "characters.json")
    doc = {"meta": {}, "characters": {}}
    if os.path.exists(mpath):
        with open(mpath, encoding="utf-8") as f:
            doc = json.load(f)
    doc.setdefault("meta", {}).update({
        "units": "metres", "up": "+Y",
        "forward": "-Z in three.js (character faces -Z)",
        "origin": "between the feet, on the floor",
        "sit_note": "the Sit clip ends with the hips at sit_hip_y above the origin; "
                    "put the root at (seat.y - sit_hip_y) so one clip fits every seat",
    })
    chars = doc.setdefault('characters', {})
    chars[cid] = info
    # drop entries whose GLB is gone -- ids get reassigned as real models arrive
    for k in [k for k, v in chars.items() if not os.path.exists(os.path.join(OUT_DIR, v.get('file', '')))]:
        del chars[k]
        T.log('  manifest: dropped %s (no glb)' % k)
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    T.log("  exported", path, "(%.2f MB)" % (os.path.getsize(path) / 1048576))
    return info

# ============================ verification sheet ============================
def rig_check(arm, clips, out, samples=64, cid="char"):
    """One frame from each clip. The character faces +Y, and normalize_character.ortho_cam puts the
    camera at -cos(yaw) on Y -- so yaw 180 is the FRONT view, not yaw 0."""
    T.studio(res=(460, 660), samples=samples, focus=(0, 0, 0.72))
    T.ground()
    shots = [("rest", "Idle", 1, 152), ("walk", "Walk", 4, 152),
             ("sit", "Sit", 30, 130), ("sit_side", "Sit", 30, 90)]
    paths = []
    for tag, clip, frame, yaw in shots:
        act = bpy.data.actions.get(clip)
        if act:
            arm.animation_data.action = act
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
        T.ortho_cam((0, 0, 0.70), 6.0, yaw, 6, 1.75)
        p = os.path.join(T.RENDERS, "rig_%s_%s.png" % (cid, tag))
        bpy.context.scene.render.resolution_x = 460
        bpy.context.scene.render.resolution_y = 660
        T.render_to(p, samples)
        paths.append(p)
    return paths

# ============================ main ============================
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="rig_character")
    ap.add_argument("--id", default="eng_m1")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--tex", type=int, default=WEB["max_texture"],
                    help="longest edge of the base colour texture, px (default 1024)")
    ap.add_argument("--keep-maps", action="store_true",
                    help="keep the normal / roughness maps the office never samples")
    a = ap.parse_args(argv)

    cid = a.id
    spec = T.ROSTER.get(cid)
    if not spec:
        T.log("unknown id", cid); return
    src = T.source_for(cid, spec)
    if not src or not os.path.exists(src):
        T.log("no source for", cid); return

    T.clear_scene()
    T.log("rigging", cid, "from", os.path.basename(src))
    objs = T.import_any(src)
    root, objs, s = T.normalize(objs, spec["height"], spec["yaw"], cid)
    mesh = next(o for o in objs if o.type == "MESH")

    slim_for_web(objs, dict(WEB, max_texture=a.tex, drop_maps=not a.keep_maps))
    scale = spec["height"] / REF_HEIGHT
    arm = build_armature(cid + "_rig", scale)
    bind(mesh, arm, scale)
    clips = author_clips(arm, scale)
    info = export(cid, mesh, arm, clips, scale)
    bpy.ops.wm.save_as_mainfile(filepath=T.BLEND)
    T.log("  saved", T.BLEND)
    if not a.no_render:
        rig_check(arm, clips, T.RENDERS, a.samples, cid)
    T.log("done:", info["tris"], "tris,", len(clips), "clips")

if __name__ == "__main__":
    main()
