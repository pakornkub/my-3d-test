# iso_office_lib.py -- UBE isometric cutaway office, clean layout (v2)
# Run inside Blender via the MCP:  import iso_office_lib; iso_office_lib.build()
import bpy, math, random, os
from mathutils import Vector

RX, RY, RZ = 10.0, 8.0, 3.0  # room size (x, y, height); visible walls at x=0 (left) and y=RY (back)
T = 0.18                     # wall thickness
DH = 0.74                    # desk height
M = {}

# ============================ helpers ============================
def clear():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)
    for c in list(bpy.data.curves): bpy.data.curves.remove(c)
    for me in list(bpy.data.meshes):
        if me.users == 0: bpy.data.meshes.remove(me)
    for l in list(bpy.data.lights):
        if l.users == 0: bpy.data.lights.remove(l)
    for c in list(bpy.data.cameras):
        if c.users == 0: bpy.data.cameras.remove(c)

def mat(name, color, rough=0.6, metal=0.0, emit=None, strength=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit is not None:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    M[name] = m
    return m

def make_materials():
    mat("white", (0.93,0.93,0.93), 0.45)
    mat("wall", (0.88,0.89,0.90), 0.75)
    mat("shell", (0.15,0.17,0.22), 0.6)
    mat("floor", (0.50,0.51,0.53), 0.55)
    mat("wood", (0.80,0.64,0.44), 0.5)
    mat("darkwood", (0.42,0.28,0.17), 0.5)
    mat("navy", (0.07,0.09,0.13), 0.4)
    mat("black", (0.03,0.03,0.035), 0.5)
    mat("gray", (0.48,0.49,0.51), 0.6)
    mat("lightgray", (0.72,0.73,0.75), 0.6)
    mat("leaf", (0.20,0.48,0.22), 0.5)
    mat("leaf2", (0.30,0.58,0.28), 0.5)
    mat("stem", (0.30,0.40,0.18), 0.6)
    mat("soil", (0.25,0.18,0.12), 0.9)
    mat("pot", (0.95,0.95,0.95), 0.4)
    mat("blue", (0.0,0.42,0.82), 0.35)
    mat("orange", (0.95,0.45,0.10), 0.5)
    mat("red", (0.8,0.15,0.15), 0.5)
    mat("yellow", (0.95,0.8,0.2), 0.5)
    mat("glass", (0.95,0.97,1.0), 0.1, emit=(1.0,0.98,0.94), strength=1.2)
    mat("cardboard", (0.72,0.56,0.36), 0.8)
    mat("steel", (0.75,0.76,0.78), 0.3, 0.9)
    mat("screen", (0.55,0.62,0.72), 0.2, emit=(0.55,0.65,0.8), strength=0.5)
    mat("tvscreen", (0.10,0.13,0.18), 0.15, emit=(0.2,0.28,0.4), strength=0.25)
    mat("warm", (1,0.85,0.6), 0.5, emit=(1.0,0.75,0.45), strength=2.5)
    mat("rug", (0.68,0.72,0.78), 0.9)
    mat("paper", (0.97,0.97,0.95), 0.7)
    mat("waterblue", (0.35,0.6,0.9), 0.1)
    # subtle variation on the floor so it is not a flat fill
    m = M["floor"]; nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexNoise"); tex.inputs["Scale"].default_value = 3.0; tex.inputs["Detail"].default_value = 4
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.46,0.47,0.49,1); ramp.color_ramp.elements[1].color = (0.56,0.57,0.59,1)
    nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"]); nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])

def box(size, loc, m, rot=(0,0,0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.data.materials.append(M[m]); return o

def cyl(r, d, loc, m, rot=(0,0,0), v=16):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc, rotation=rot, vertices=v)
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    o.data.materials.append(M[m]); return o

def ellipsoid(size, loc, rot, m, smooth=True):
    """Smooth-shaded ellipsoid; used for leaves."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.0, location=loc, rotation=rot)
    o = bpy.context.active_object; o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.data.materials.append(M[m])
    if smooth:
        for pl in o.data.polygons: pl.use_smooth = True
    return o

def group(parts, name, loc=(0,0,0), rot_z=0, bevel=0.008):
    """Join parts built in local coords around (0,0,0), reset origin, then place."""
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts: p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1: bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name
    bpy.context.scene.cursor.location = (0,0,0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    o.rotation_euler = (0,0,math.radians(rot_z)); o.location = loc
    if bevel:
        md = o.modifiers.new("Bevel","BEVEL"); md.width = bevel; md.segments = 2; md.limit_method = 'ANGLE'
    return o

def aim(v):
    """Euler rotation that points a cylinder's +Z axis along vector v."""
    return Vector(v).to_track_quat('Z','Y').to_euler()

# ============================ room shell ============================
def room():
    box((RX+T, RY+T, 0.06), (RX/2 - T/2, RY/2 + T/2, -0.03), "floor").name = "Floor"
    box((RX+T, RY+T, 0.4), (RX/2 - T/2, RY/2 + T/2, -0.26), "shell").name = "FloorShell"
    box((RX+T, T, RZ), (RX/2 - T/2, RY + T/2, RZ/2), "wall").name = "BackWall"
    box((RX+T+0.04, 0.06, RZ+0.02), (RX/2 - T/2, RY + T + 0.03, RZ/2 - 0.01), "shell").name = "BackWallShell"
    box((T, RY, RZ), (-T/2, RY/2, RZ/2), "wall").name = "LeftWall"
    box((0.06, RY+0.02, RZ+0.02), (-T - 0.03, RY/2, RZ/2 - 0.01), "shell").name = "LeftWallShell"
    box((RX, 0.025, 0.1), (RX/2, RY - 0.0125, 0.05), "shell").name = "SkirtBack"
    box((0.025, RY, 0.1), (0.0125, RY/2, 0.05), "shell").name = "SkirtLeft"
    box((RX+T+0.04, T+0.06, 0.03), (RX/2 - T/2, RY + T/2 + 0.03, RZ + 0.015), "white").name = "CapBack"
    box((T+0.06, RY+0.02, 0.03), (-T/2 - 0.03, RY/2, RZ + 0.015), "white").name = "CapLeft"

# ============================ wall-mounted ============================
def window(cy, w=1.6, h=1.8, cz=1.65):
    p = [box((0.10, w, h), (0.0, 0, 0), "navy"),
         box((0.04, w-0.16, h-0.16), (0.045, 0, 0), "glass"),
         box((0.06, 0.04, h-0.16), (0.05, 0, 0), "navy")]
    for dz in (-h/6, h/6):
        p.append(box((0.06, w-0.16, 0.04), (0.05, 0, dz), "navy"))
    return group(p, "Window_%s" % cy, (0.0, cy, cz), bevel=0.004)

def sconce(x, z=2.4):
    p = [box((0.12, 0.04, 0.18), (0, 0, 0), "navy"), ellipsoid((0.05,0.05,0.05), (0, -0.05, 0.03), (0,0,0), "warm")]
    group(p, "Sconce_%s" % x, (x, RY-0.02, z), bevel=0.003)
    ld = bpy.data.lights.new("SconceLight_%s" % x, type='POINT'); ld.energy = 5; ld.color = (1.0,0.8,0.55); ld.shadow_soft_size = 0.1
    lo = bpy.data.objects.new("SconceLight_%s" % x, ld); bpy.context.collection.objects.link(lo)
    lo.location = (x, RY-0.12, z+0.05)

def noticeboard(x, z=1.95, w=1.2, h=0.8):
    p = [box((w, 0.04, h), (0,0,0), "navy"), box((w-0.08, 0.01, h-0.08), (0,-0.025,0), "cardboard")]
    random.seed(4)
    for i in range(6):
        nx = random.uniform(-w/2+0.12, w/2-0.12); nz = random.uniform(-h/2+0.12, h/2-0.12)
        p.append(box((0.14, 0.006, 0.18), (nx, -0.033, nz), "paper", rot=(0,random.uniform(-0.1,0.1),0)))
        p.append(cyl(0.012, 0.01, (nx, -0.04, nz+0.08), ["red","blue","yellow"][i%3], rot=(math.radians(90),0,0), v=8))
    group(p, "NoticeBoard", (x, RY-0.02, z), bevel=0.003)

def door(x, w=0.9, h=2.1):
    p = [box((w+0.1, 0.05, h+0.05), (0, 0.0, (h+0.05)/2), "navy"),
         box((w, 0.05, h), (0, -0.01, h/2), "gray"),
         box((w-0.2, 0.01, 0.5), (0, -0.04, h*0.72), "lightgray"),
         box((w-0.2, 0.01, 0.8), (0, -0.04, h*0.3), "lightgray"),
         cyl(0.015, 0.1, (-w/2+0.1, -0.06, 1.0), "steel", rot=(math.radians(90),0,0), v=8),
         box((0.1, 0.02, 0.02), (-w/2+0.14, -0.1, 1.0), "steel")]
    return group(p, "Door", (x, RY-0.03, 0), bevel=0.004)

def tv(x, z=1.85, w=1.3, h=0.75):
    p = [box((w, 0.05, h), (0,0,0), "navy"), box((w-0.06, 0.01, h-0.06), (0,-0.03,0), "tvscreen")]
    return group(p, "TV", (x, RY-0.04, z), bevel=0.004)

def picture(loc, w=0.5, h=0.65, color="blue", rot_z=0):
    p = [box((w, 0.03, h), (0,0,0), "navy"), box((w-0.06, 0.01, h-0.06), (0,-0.02,0), "white"),
         box((w-0.16, 0.005, h-0.2), (0,-0.028,0.02), color)]
    return group(p, "Picture", loc, rot_z, bevel=0.002)

def clock(loc):
    p = [cyl(0.17, 0.03, (0,0,0), "navy", rot=(math.radians(90),0,0), v=24),
         cyl(0.15, 0.01, (0,-0.02,0), "white", rot=(math.radians(90),0,0), v=24),
         box((0.01, 0.005, 0.1), (0,-0.03,0.05), "navy"), box((0.07, 0.005, 0.01), (0.035,-0.03,0), "navy")]
    return group(p, "Clock", loc, bevel=0)

# ============================ storage / props ============================
def credenza(x, w=1.8, d=0.45, h=0.8):
    p = [box((w, d, h-0.08), (0, 0, (h-0.08)/2 + 0.08), "wood"),
         box((w-0.1, d-0.1, 0.08), (0, 0, 0.04), "navy")]
    for k in range(2):
        gx = -w/2 + (k+1)*w/3
        p.append(box((0.012, 0.02, h-0.2), (gx, -d/2-0.005, h/2+0.04), "darkwood"))
    for k in range(3):
        hx = -w/2 + (k+0.5)*w/3
        p.append(box((0.16, 0.02, 0.02), (hx, -d/2-0.015, h*0.6), "steel"))
    return group(p, "Credenza", (x, RY - d/2 - 0.02, 0))

def low_cabinet(loc, w=1.3, rot_z=0):
    p = [box((w, 0.4, 0.5), (0,0,0.27), "white"), box((w-0.1, 0.3, 0.04), (0,0,0.02), "navy"),
         box((0.012, 0.02, 0.4), (0, -0.2, 0.27), "lightgray"), box((0.25, 0.18, 0.06), (-0.3, 0, 0.55), "navy")]
    return group(p, "LowCabinet", loc, rot_z, bevel=0.004)

def bookshelf(loc, rot_z=0, w=0.9, d=0.35, h=1.9):
    p = [box((d, 0.03, h), (0, -w/2, h/2), "wood"), box((d, 0.03, h), (0, w/2, h/2), "wood"),
         box((0.02, w, h), (-d/2+0.01, 0, h/2), "wood")]
    for k in range(5):
        z = 0.05 + k*(h-0.1)/4
        p.append(box((d, w, 0.03), (0, 0, z), "wood"))
    random.seed(11)
    cols = ["blue","red","navy","orange","yellow","leaf","white"]
    for k in range(4):
        z = 0.05 + k*(h-0.1)/4 + 0.015
        y = -w/2 + 0.06
        for i in range(random.randint(4,7)):
            bh = random.uniform(0.18,0.27); bt = random.uniform(0.03,0.05)
            p.append(box((d-0.1, bt, bh), (0.0, y + bt/2, z + bh/2), cols[random.randrange(len(cols))]))
            y += bt + 0.005
        if k == 1: p.append(box((0.2, 0.2, 0.15), (0, w/2-0.15, z+0.075), "cardboard"))
    return group(p, "Bookshelf", loc, rot_z, bevel=0.003)

def water_cooler(loc, rot_z=0):
    p = [box((0.32, 0.32, 1.0), (0,0,0.5), "white"), box((0.28, 0.05, 0.12), (0, -0.16, 0.7), "lightgray"),
         cyl(0.13, 0.4, (0,0,1.2), "waterblue", v=16), cyl(0.06, 0.06, (0,0,1.43), "waterblue", v=12)]
    return group(p, "WaterCooler", loc, rot_z, bevel=0.005)

def printer(loc, rot_z=0):
    p = [box((0.5, 0.42, 0.22), (0,0,0.11), "lightgray"), box((0.42, 0.34, 0.06), (0,0,0.25), "white"),
         box((0.3, 0.25, 0.01), (0, -0.05, 0.285), "paper"), box((0.12, 0.04, 0.02), (0.15, -0.2, 0.2), "navy")]
    return group(p, "Printer", loc, rot_z, bevel=0.005)

def books(loc, n=3, rot_z=0):
    p = []; random.seed(n)
    cols = ["blue","red","navy","orange"]
    for i in range(n):
        p.append(box((0.22-0.02*i, 0.16, 0.03), (random.uniform(-0.02,0.02), random.uniform(-0.02,0.02), 0.015+0.03*i), cols[i%len(cols)]))
    return group(p, "Books", loc, rot_z, bevel=0.002)

def trash(loc):
    p = [cyl(0.13, 0.32, (0,0,0.16), "gray", v=14), cyl(0.11, 0.02, (0,0,0.31), "navy", v=14)]
    return group(p, "Trash", loc, bevel=0.003)

# ============================ plants ============================
def plant_ficus(name, loc, s=1.0, leaves=26, seed=1):
    """Floor plant: pot, trunk, and individual oval leaves on short stems (golden-angle spiral)."""
    random.seed(seed)
    p = [cyl(0.19*s, 0.34*s, (0,0,0.17*s), "pot", v=20),
         cyl(0.165*s, 0.02*s, (0,0,0.345*s), "soil", v=16),
         cyl(0.025*s, 1.05*s, (0,0,0.34*s+0.52*s), "darkwood", v=8)]
    for i in range(leaves):
        t = i/(leaves-1)
        h = (0.55 + 0.8*t)*s
        a = math.radians(i*137.5 + random.uniform(-10,10))
        tilt = math.radians(random.uniform(-10, 10) + 30*t)
        L = (0.30 - 0.12*t)*s
        S = 0.10*s
        d = Vector((math.cos(a)*math.cos(tilt), math.sin(a)*math.cos(tilt), math.sin(tilt)))
        stem_c = d*(0.03*s + S/2) + Vector((0,0,h))
        p.append(cyl(0.006*s, S, stem_c, "stem", rot=aim(d), v=6))
        leaf_c = d*(0.03*s + S + L*0.5) + Vector((0,0,h))
        p.append(ellipsoid((L/2, L*0.22, 0.008*s), leaf_c, (0, -tilt, a), ["leaf","leaf2"][i%2]))
    return group(p, name, loc, bevel=0)

def plant_vine(name, loc, strands=((275,0.20,0.55),(320,0.22,0.45),(10,0.22,0.5),(230,0.24,0.35)), s=1.0, seed=2):
    """Trailing pothos in a small pot. strands = (direction deg, distance to the edge it drops over, drop length)."""
    random.seed(seed)
    p = [cyl(0.075*s, 0.11*s, (0,0,0.055*s), "pot", v=16), cyl(0.065*s, 0.015*s, (0,0,0.115*s), "soil", v=14)]
    for i in range(6):
        a = math.radians(i*60+15)
        p.append(ellipsoid((0.05*s,0.04*s,0.012*s), (0.05*s*math.cos(a), 0.05*s*math.sin(a), 0.14*s), (0, math.radians(-20), a), ["leaf","leaf2"][i%2]))
    for (a_deg, edge, drop) in strands:
        a = math.radians(a_deg + random.uniform(-6,6))
        n = 10; pts = []
        for i in range(n):
            t = i/(n-1)
            if t <= 0.35:
                u = t/0.35
                r = 0.06*s + (edge-0.06*s)*u; z = 0.12*s + 0.04*s*math.sin(u*math.pi)
            else:
                u = (t-0.35)/0.65
                r = edge + 0.05*s*u; z = 0.12*s - drop*s*(u**1.1)
            pts.append(Vector((r*math.cos(a), r*math.sin(a), z)))
        for i in range(n-1):
            seg = pts[i+1]-pts[i]; mid = (pts[i]+pts[i+1])/2
            p.append(cyl(0.005*s, seg.length, mid, "stem", rot=aim(seg), v=5))
        for i in range(1, n):
            side = 1 if i%2==0 else -1
            tang = (pts[i]-pts[i-1]).normalized()
            yaw = math.atan2(tang.y, tang.x) + side*math.radians(35)
            pitch = math.radians(random.uniform(-15, 15))
            sz = (0.045 + random.uniform(-0.008, 0.01))*s
            p.append(ellipsoid((sz, sz*0.8, 0.008*s), pts[i] + Vector((0,0,0.005*s)), (math.radians(side*25), pitch, yaw), ["leaf","leaf2"][i%2]))
    return group(p, name, loc, bevel=0)

def plant_small(name, loc, s=1.0, seed=3):
    """Desk plant with long upright leaves (snake-plant look)."""
    random.seed(seed)
    p = [cyl(0.06*s, 0.09*s, (0,0,0.045*s), "pot", v=14), cyl(0.052*s, 0.012*s, (0,0,0.09*s), "soil", v=12)]
    for i in range(8):
        a = math.radians(i*45 + random.uniform(-10,10))
        tilt = math.radians(random.uniform(8, 25))
        L = random.uniform(0.14, 0.24)*s
        c = (math.sin(tilt)*L/2*math.cos(a), math.sin(tilt)*L/2*math.sin(a), 0.09*s + math.cos(tilt)*L/2)
        p.append(ellipsoid((0.012*s, 0.03*s, L/2), c, (0, tilt, a), ["leaf","leaf2"][i%2]))
    return group(p, name, loc, bevel=0)

# ============================ desks / seating ============================
def monitor(mx, my, z, face=-1, w=0.55, h=0.33):
    """Slim-bezel monitor on a flat base. face=-1: screen toward -y (user sits at -y)."""
    return [cyl(0.11, 0.012, (mx, my, z+0.006), "navy", v=20),
            box((0.05, 0.03, 0.16), (mx, my+0.02, z+0.09), "navy"),
            box((w, 0.02, h), (mx, my, z+0.34), "navy"),
            box((w-0.02, 0.006, h-0.02), (mx, my+face*0.012, z+0.34), "screen")]

def desk_items(p, w, z, side=-1, kb=True, mug=False, papers=False, phone=False, bottle=False, laptop=False, kx=0.0):
    """side=-1: the user sits at -y. Items are laid out relative to that side."""
    if kb:
        p.append(box((0.44, 0.14, 0.015), (kx, side*0.13, z+0.008), "lightgray"))
        p.append(box((0.06, 0.11, 0.025), (kx+0.33, side*0.13, z+0.012), "lightgray"))
    if mug: p.append(cyl(0.04, 0.09, (-w/2+0.18, side*0.15, z+0.045), "white", v=12))
    if papers: p.append(box((0.21, 0.29, 0.012), (w/2-0.25, side*0.08, z+0.006), "paper", rot=(0,0,math.radians(-8))))
    if phone: p.append(box((0.07, 0.14, 0.01), (w/2-0.12, -side*0.1, z+0.005), "black"))
    if bottle:
        p.append(cyl(0.03, 0.2, (w/2-0.15, side*0.05, z+0.1), "waterblue", v=12))
        p.append(cyl(0.02, 0.03, (w/2-0.15, side*0.05, z+0.215), "navy", v=10))
    if laptop:
        lx, ly = 0.5, side*0.02
        p.append(box((0.32, 0.22, 0.012), (lx, ly, z+0.006), "navy"))
        hinge = ly - side*0.11
        p.append(box((0.32, 0.012, 0.21), (lx, hinge - side*0.036, z+0.105), "navy", rot=(math.radians(side*20),0,0)))
        p.append(box((0.30, 0.005, 0.19), (lx, hinge - side*0.036 + side*0.009, z+0.105), "screen", rot=(math.radians(side*20),0,0)))

def desk(name, loc, rot_z=0, w=1.3, d=0.7, monitors=1, folder=False, **items):
    """Real-proportion desk: 3 cm white top on two dark steel loop legs + back stretcher."""
    z = DH
    p = [box((w, d, 0.03), (0,0,z-0.015), "white")]
    for sx in (-w/2+0.06, w/2-0.06):
        for sy in (-d/2+0.06, d/2-0.06):
            p.append(box((0.04, 0.04, z-0.03), (sx, sy, (z-0.03)/2), "navy"))
        p.append(box((0.04, d-0.12, 0.04), (sx, 0, 0.02), "navy"))
        p.append(box((0.04, d-0.12, 0.04), (sx, 0, z-0.05), "navy"))
    p.append(box((w-0.2, 0.04, 0.04), (0, d/2-0.06, z-0.05), "navy"))
    xs = [0] if monitors == 1 else [-0.3, 0.3]
    for mx in xs: p += monitor(mx, 0.2, z)
    if folder: p.append(box((0.24, 0.32, 0.03), (-w/2+0.25, 0.05, z+0.015), "blue"))
    desk_items(p, w, z, **items)
    return group(p, name, loc, rot_z)

def meeting_table(name, loc, rot_z=0, w=1.8, d=0.9):
    z = DH
    p = [box((w, d, 0.04), (0,0,z-0.02), "white")]
    for sx in (-w/2+0.1, w/2-0.1):
        for sy in (-d/2+0.1, d/2-0.1):
            p.append(cyl(0.025, z-0.04, (sx, sy, (z-0.04)/2), "navy", v=10))
    p.append(box((0.32, 0.22, 0.015), (-0.4, 0.1, z+0.008), "navy"))
    p.append(cyl(0.04, 0.09, (0.3, -0.2, z+0.045), "white", v=12))
    p.append(cyl(0.04, 0.09, (0.55, 0.15, z+0.045), "white", v=12))
    p.append(box((0.21, 0.29, 0.012), (0.2, 0.1, z+0.006), "paper", rot=(0,0,math.radians(12))))
    return group(p, name, loc, rot_z)

def manager_desk(name, loc, rot_z=0):
    """L-desk; the user sits at +y (behind it) facing -y, return arm on the left toward the front."""
    z = DH; w, d = 1.9, 0.85
    p = [box((w, d, 0.05), (0,0,z-0.025), "white"),
         box((0.8, 1.3, 0.05), (-w/2+0.4, -d/2-0.63, z-0.025), "white"),
         box((0.04, d-0.02, z-0.05), (w/2-0.02, 0, (z-0.05)/2), "navy"),
         box((0.04, d-0.02, z-0.05), (-w/2+0.02, 0, (z-0.05)/2), "navy"),
         box((0.78, 0.04, z-0.05), (-w/2+0.4, -d/2-1.26, (z-0.05)/2), "navy"),
         box((w-0.08, 0.03, 0.32), (0, -d/2+0.04, z-0.05-0.16), "navy")]
    p += monitor(0.2, -0.17, z, face=+1)
    desk_items(p, w, z, side=+1, kb=True, kx=0.2, phone=True, papers=True, mug=True)
    p.append(box((0.3, 0.22, 0.015), (-w/2+0.4, -d/2-0.5, z+0.008), "navy"))   # closed laptop on the return
    p.append(box((0.24, 0.32, 0.03), (-w/2+0.4, -d/2-0.95, z+0.015), "blue"))   # folder
    return group(p, name, loc, rot_z)

SEATS = []   # seat anchors collected while building: (name, x, y, seat_z, facing_deg, kind)

def register_seat(name, loc, rot_z, seat_z, kind):
    SEATS.append({"name": name, "x": loc[0], "y": loc[1], "z": seat_z, "facing_deg": rot_z, "kind": kind})

def chair(name, loc, rot_z=0, color="black"):
    """Office chair. Seat 0.48 square at 0.45 m; backrest upright, same width, flush with the rear edge, centred."""
    seat_z, seat_t = 0.45, 0.06
    p = [box((0.48, 0.48, seat_t), (0, 0, seat_z+seat_t/2), color),
         box((0.48, 0.05, 0.52), (0, -0.215, seat_z+seat_t+0.26), color),
         box((0.30, 0.03, 0.30), (0, -0.20, seat_z+seat_t+0.28), "gray"),          # mesh insert
         cyl(0.025, 0.40, (0,0,0.22), "steel", v=8), cyl(0.045, 0.05, (0,0,seat_z-0.025), color, v=8),
         cyl(0.06, 0.03, (0,0,0.03), color, v=8)]
    for sx in (-0.255, 0.255):
        p.append(box((0.03, 0.04, 0.18), (sx, 0.0, seat_z+seat_t+0.09), color))
        p.append(box((0.05, 0.30, 0.03), (sx, 0.0, seat_z+seat_t+0.195), color))
    for i in range(5):
        a = math.radians(72*i + 90)
        p.append(box((0.28, 0.035, 0.025), (0.13*math.cos(a), 0.13*math.sin(a), 0.03), color, rot=(0,0,a)))
        p.append(cyl(0.025, 0.03, (0.27*math.cos(a), 0.27*math.sin(a), 0.025), "navy", rot=(math.radians(90),0,0), v=8))
    register_seat(name, loc, rot_z, seat_z+seat_t, "office_chair")
    return group(p, name, loc, rot_z, bevel=0.006)

def exec_chair(name, loc, rot_z=0, color="black"):
    """Executive chair: wide padded seat, tall upright back with headrest, padded arms, chrome base."""
    seat_z, seat_t = 0.45, 0.10
    p = [box((0.54, 0.54, seat_t), (0, 0, seat_z+seat_t/2), color),
         box((0.54, 0.10, 0.66), (0, -0.22, seat_z+seat_t+0.33), color),
         box((0.44, 0.03, 0.52), (0, -0.16, seat_z+seat_t+0.30), "gray"),          # padded insert
         box((0.36, 0.10, 0.14), (0, -0.22, seat_z+seat_t+0.66+0.07), color),        # headrest
         cyl(0.03, 0.38, (0,0,0.2), "steel", v=10), cyl(0.06, 0.05, (0,0,seat_z-0.025), color, v=10),
         cyl(0.07, 0.03, (0,0,0.03), "steel", v=10)]
    for sx in (-0.295, 0.295):
        p.append(box((0.05, 0.05, 0.2), (sx, 0.0, seat_z+seat_t+0.10), color))
        p.append(box((0.08, 0.34, 0.05), (sx, 0.0, seat_z+seat_t+0.225), color))
    for i in range(5):
        a = math.radians(72*i + 90)
        p.append(box((0.32, 0.04, 0.03), (0.15*math.cos(a), 0.15*math.sin(a), 0.03), "steel", rot=(0,0,a)))
        p.append(cyl(0.03, 0.03, (0.31*math.cos(a), 0.31*math.sin(a), 0.03), "navy", rot=(math.radians(90),0,0), v=8))
    register_seat(name, loc, rot_z, seat_z+seat_t, "executive_chair")
    return group(p, name, loc, rot_z, bevel=0.01)

def simple_chair(name, loc, rot_z=0, color="white"):
    p = [box((0.42, 0.42, 0.05), (0,0,0.45), color), box((0.42, 0.04, 0.42), (0,-0.19,0.69), color)]
    for sx in (-0.17, 0.17):
        for sy in (-0.17, 0.17):
            p.append(cyl(0.015, 0.43, (sx, sy, 0.215), "darkwood", v=6))
    register_seat(name, loc, rot_z, 0.475, "side_chair")
    return group(p, name, loc, rot_z, bevel=0.004)

def round_table(loc):
    p = [cyl(0.45, 0.04, (0,0,DH-0.02), "white", v=32), cyl(0.04, DH-0.04, (0,0,(DH-0.04)/2), "steel", v=12),
         cyl(0.25, 0.03, (0,0,0.015), "steel", v=24),
         cyl(0.035, 0.09, (0.15, 0.1, DH+0.045), "white", v=12), box((0.3, 0.2, 0.012), (-0.12, -0.05, DH+0.006), "navy")]
    return group(p, "RoundTable", loc)

def sofa(name, loc, rot_z=0, w=1.6):
    p = [box((w, 0.85, 0.22), (0,0,0.22), "gray"), box((w, 0.22, 0.45), (0, -0.31, 0.5), "gray"),
         box((0.18, 0.85, 0.3), (-w/2+0.09, 0, 0.45), "gray"), box((0.18, 0.85, 0.3), (w/2-0.09, 0, 0.45), "gray")]
    n = 3; cw = (w-0.36)/n
    for i in range(n):
        cx = -w/2+0.18 + cw*(i+0.5)
        p.append(box((cw-0.03, 0.6, 0.12), (cx, 0.08, 0.39), "lightgray"))
        p.append(box((cw-0.03, 0.12, 0.35), (cx, -0.24, 0.6), "lightgray"))
    p.append(box((0.35, 0.35, 0.1), (-w/2+0.4, 0.05, 0.5), "blue", rot=(0,0,math.radians(15))))
    for sx in (-w/2+0.1, w/2-0.1):
        for sy in (-0.3, 0.3):
            p.append(cyl(0.02, 0.11, (sx, sy, 0.055), "darkwood", v=6))
    # three seats along the sofa, in world coords (sofa faces local +y)
    a = math.radians(rot_z)
    for i in range(n):
        cx = -w/2+0.18 + cw*(i+0.5)
        wx = loc[0] + cx*math.cos(a); wy = loc[1] + cx*math.sin(a)
        register_seat("%s_seat%d" % (name, i+1), (wx, wy, 0), rot_z, 0.45, "sofa")
    return group(p, name, loc, rot_z, bevel=0.01)

def coffee_table(loc, rot_z=0):
    p = [box((0.9, 0.5, 0.03), (0,0,0.4), "white")]
    for sx in (-0.4, 0.4):
        for sy in (-0.2, 0.2):
            p.append(cyl(0.015, 0.4, (sx, sy, 0.2), "darkwood", v=6))
    p.append(box((0.25, 0.32, 0.02), (-0.2, 0, 0.425), "blue")); p.append(box((0.25, 0.32, 0.02), (-0.15, 0.03, 0.445), "orange", rot=(0,0,math.radians(8))))
    p.append(cyl(0.035, 0.09, (0.25, 0.1, 0.46), "white", v=12))
    return group(p, "CoffeeTable", loc, rot_z, bevel=0.004)

def rug(loc, size=(2.1,1.6), rot_z=0):
    p = [box((size[0], size[1], 0.012), (0,0,0.006), "rug"), box((size[0]-0.2, size[1]-0.2, 0.013), (0,0,0.0065), "lightgray")]
    return group(p, "Rug", loc, rot_z, bevel=0)

# ============================ logo (letters straight on the wall) ============================
def logo(x=4.1, z=2.15):
    font = None
    for f in [r"C:\Windows\Fonts\ariblk.ttf", r"C:\Windows\Fonts\arialbd.ttf"]:
        if os.path.exists(f):
            font = bpy.data.fonts.load(f, check_existing=True); break
    def text3d(name, body, size, extrude, loc, m, shear=0.0):
        cu = bpy.data.curves.new(name, type='FONT')
        cu.body = body; cu.size = size; cu.extrude = extrude; cu.shear = shear
        cu.align_x = 'CENTER'; cu.align_y = 'CENTER'; cu.bevel_depth = 0.003; cu.bevel_resolution = 1
        if font: cu.font = font
        o = bpy.data.objects.new(name, cu); bpy.context.collection.objects.link(o)
        o.location = loc; o.rotation_euler = (math.radians(90), 0, 0); o.data.materials.append(M[m]); return o
    text3d("Logo_UBE", "UBE", 1.1, 0.04, (x, RY-0.04, z), "blue", shear=0.28)
    text3d("Logo_Sub", "UBE GROUP (THAILAND)", 0.17, 0.015, (x, RY-0.015, z-0.5), "navy")

# ============================ camera / light / render ============================
def camera_lights(samples=160, res=(1600,1000)):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("IsoCam"); cam_data.type = 'ORTHO'; cam_data.ortho_scale = 14.6
    cam = bpy.data.objects.new("IsoCam", cam_data); bpy.context.collection.objects.link(cam)
    target = Vector((5.3, 4.0, 1.5))
    cam.location = target + Vector((12, -12, 10.5))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z','Y').to_euler()
    scene.camera = cam
    sun_d = bpy.data.lights.new("Sun", type='SUN'); sun_d.energy = 2.5; sun_d.angle = math.radians(10)
    sun = bpy.data.objects.new("Sun", sun_d); bpy.context.collection.objects.link(sun)
    sun.rotation_euler = Vector((0.6, 0.9, -1.5)).to_track_quat('-Z','Y').to_euler()
    fill_d = bpy.data.lights.new("Fill", type='AREA'); fill_d.energy = 150; fill_d.size = 6
    fill = bpy.data.objects.new("Fill", fill_d); bpy.context.collection.objects.link(fill)
    fill.location = (8.3, -3.0, 6); fill.rotation_euler = (target - fill.location).to_track_quat('-Z','Y').to_euler()
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("World"); scene.world = world
    world.use_nodes = True; nt = world.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    b1 = nt.nodes.new("ShaderNodeBackground"); b1.inputs["Color"].default_value=(1,1,1,1); b1.inputs["Strength"].default_value=0.45
    b2 = nt.nodes.new("ShaderNodeBackground"); b2.inputs["Color"].default_value=(1,1,1,1); b2.inputs["Strength"].default_value=1.25
    lp = nt.nodes.new("ShaderNodeLightPath"); mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(b1.outputs["Background"], mix.inputs[1]); nt.links.new(b2.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    scene.render.engine = 'CYCLES'; scene.cycles.samples = samples; scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.view_settings.view_transform = 'Standard'; scene.view_settings.exposure = -0.3

# ============================ layout ============================
def build(samples=160, res=(1600,1000)):
    """Layout per layout_plan.svg: room 10 x 8, no door, 2 pods, manager, meeting, lounge, 1.2 m+ walkways."""
    clear(); make_materials(); room()
    SEATS.clear()

    # --- left wall (x = 0): three windows, one picture ---
    window(1.6); window(4.2); window(6.8)
    picture((0.03, 2.9, 2.05), 0.45, 0.55, "blue", rot_z=90)
    picture((0.03, 5.5, 2.05), 0.45, 0.55, "orange", rot_z=90)

    # --- back wall (y = RY), left to right ---
    bookshelf((0.6, RY-0.19, 0), rot_z=-90)
    credenza(2.2)
    printer((1.65, RY-0.23, 0.8)); books((2.3, RY-0.23, 0.8), n=3)
    plant_vine("Vine", (2.95, RY-0.25, 0.8), strands=((275,0.22,0.55),(10,0.25,0.5),(320,0.24,0.45),(230,0.26,0.35)), s=1.0)
    trash((3.55, RY-0.2, 0))
    noticeboard(2.2, z=1.95, w=1.4, h=0.8)
    sconce(3.6, 2.5); sconce(7.95, 2.5)
    logo(5.0, 2.3)
    low_cabinet((7.05, RY-0.22, 0), w=1.3)
    plant_small("CabPlant", (7.5, RY-0.25, 0.5), 1.1, seed=7)
    tv(7.05)
    desk("ManagerDesk", (9.2, 6.8, 0), 180, w=1.6, d=0.8, monitors=1, kb=True, phone=True, papers=True, mug=True, folder=True)
    exec_chair("ManagerChair", (9.2, 7.5, 0), 180, "black")
    plant_ficus("Ficus_Mgr", (9.72, 7.72, 0), 0.85, seed=2)

    # --- Pod A and Pod B: 2 x 2 facing pairs, low centre screen, 1.3 m main aisle between ---
    for tag, x0 in (("A", 1.55), ("B", 5.45)):
        for i, dx in enumerate((0.0, 1.3)):
            x = x0 + dx
            desk("Desk%s%d" % (tag, i+1), (x, 4.55, 0), 0,   monitors=2 if i == 0 else 1, kb=True, mug=(i == 0), bottle=(i == 1))
            desk("Desk%s%d" % (tag, i+3), (x, 5.25, 0), 180, monitors=1, kb=True, laptop=(i == 0), papers=(i == 1))
            chair("Chair%s%d" % (tag, i+1), (x, 3.9, 0), 0, "black")
            chair("Chair%s%d" % (tag, i+3), (x, 5.9, 0), 180, "black")
        box((2.6, 0.03, 0.35), (x0 + 0.65, 4.9, DH + 0.175), "lightgray").name = "Screen_%s" % tag
    plant_small("DeskPlantA", (3.35, 4.75, DH), 0.9, seed=8)
    plant_small("DeskPlantB", (5.0, 5.05, DH), 0.9, seed=9)

    # --- lounge, front-left ---
    rug((1.45, 1.4, 0), (2.5, 2.0))
    sofa("Sofa", (0.455, 1.4, 0), rot_z=-90, w=1.8)      # back flush with the left wall
    coffee_table((1.95, 1.4, 0))
    plant_ficus("Ficus_L", (0.5, 2.9, 0), 0.9, seed=1)

    # --- meeting table, front-right ---
    meeting_table("MeetingTable", (6.5, 1.35, 0))
    simple_chair("MC1", (6.05, 0.7, 0), 0); simple_chair("MC2", (6.95, 0.7, 0), 0)
    simple_chair("MC3", (6.05, 2.0, 0), 180); simple_chair("MC4", (6.95, 2.0, 0), 180)
    water_cooler((9.4, 0.5, 0))
    plant_ficus("Ficus_R", (9.6, 1.4, 0), 0.8, seed=4)

    camera_lights(samples, res)
    return len(bpy.data.objects)

# ============================ export for three.js ============================
def to_gltf(x, y, z):
    """Blender Z-up -> glTF/three.js Y-up (same convention the glTF exporter uses)."""
    return [round(x, 4), round(z, 4), round(-y, 4)]

def export_assets(out_dir):
    import json
    os.makedirs(out_dir, exist_ok=True)
    # --- seats ---
    seats = []
    for s in SEATS:
        a = math.radians(s["facing_deg"])
        fx, fy = -math.sin(a), math.cos(a)                          # chair faces local +y, rotated by facing_deg
        # stand-here point: 0.6 m behind the seat (the open side; the desk is in front). If that lands in a
        # wall (manager chair backs onto the back wall), step in from the side that faces the room instead.
        ax, ay = s["x"] - fx*0.6, s["y"] - fy*0.6
        if ay > RY - 0.35 or ax < 0.35 or ay < 0.35:
            px, py = -fy, fx                                        # perpendicular (left of forward)
            cx, cy = RX/2 - s["x"], RY/2 - s["y"]                   # toward the room centre
            if px*cx + py*cy < 0: px, py = -px, -py
            ax, ay = s["x"] + px*0.75, s["y"] + py*0.75
        f3 = to_gltf(fx, fy, 0)                                    # forward in three.js axes
        # rotation.y for a model whose forward is -Z: rotate (0,0,-1) about Y by yaw -> (-sin yaw, 0, -cos yaw)
        yaw = math.atan2(-f3[0], -f3[2])
        seats.append({
            "name": s["name"], "kind": s["kind"],
            "blender": {"seat": [round(s["x"],4), round(s["y"],4), round(s["z"],4)],
                        "forward": [round(fx,4), round(fy,4), 0], "approach": [round(ax,4), round(ay,4), 0]},
            "three": {"seat": to_gltf(s["x"], s["y"], s["z"]), "forward": f3,
                      "approach": to_gltf(ax, ay, 0), "rotation_y_rad": round(yaw, 4)}
        })
    # --- obstacles: world AABB of every mesh object except floor/rug ---
    skip = {"Floor", "FloorShell", "Rug", "CapBack", "CapLeft"}
    obs = []
    for o in bpy.data.objects:
        if o.type != "MESH" or o.name in skip: continue
        pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
        mn = [min(p[i] for p in pts) for i in range(3)]; mx = [max(p[i] for p in pts) for i in range(3)]
        obs.append({"name": o.name, "blender": {"min": [round(v,4) for v in mn], "max": [round(v,4) for v in mx]},
                    "three": {"min": to_gltf(mn[0], mx[1], mn[2]), "max": to_gltf(mx[0], mn[1], mx[2])}})
    meta = {"units": "metres", "room": {"x": RX, "y": RY, "height": RZ, "left_wall_at_x": 0, "back_wall_at_y": RY},
            "three_axes": "glTF Y-up: three.x = blender.x, three.y = blender.z, three.z = -blender.y",
            "seat_note": "seat = where the hips go; approach = stand here (behind the chair, or beside it when it backs onto a wall), face 'forward', walk onto 'seat' while playing the sit animation; use rotation_y_rad for the seated pose"}
    with open(os.path.join(out_dir, "seats.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "seats": seats}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "obstacles.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "obstacles": obs}, f, ensure_ascii=False, indent=1)
    # --- GLB: text -> mesh, then export everything but lights/camera ---
    bpy.ops.object.select_all(action="DESELECT")
    for o in list(bpy.data.objects):
        if o.type == "FONT":
            o.select_set(True); bpy.context.view_layer.objects.active = o
    if bpy.context.selected_objects:
        bpy.ops.object.convert(target="MESH")
    bpy.ops.object.select_all(action="DESELECT")
    glb = os.path.join(out_dir, "ube_office.glb")
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", export_apply=True, export_lights=False, export_cameras=False)
    return {"seats": len(seats), "obstacles": len(obs), "glb": glb}
