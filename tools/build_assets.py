"""
Builds the customizer assets from CC0 VRoid sample models (pixiv Inc.):

  public/models/woman.vrm   <- Sendagaya Shibu (beta AvatarSample_1), smaller textures
  public/models/man.vrm     <- HairSample_Male, smaller textures
  public/hair/<style>.glb   <- hair mesh + hair bones only, textures turned grey so the
                               app can tint them to any hair colour

Source files come from https://github.com/madjin/vrm-samples (vroid/beta). Every source
model carries licenseName "CC0" in its VRM metadata. Usage: python3 tools/build_assets.py
"""
import io, json, os, struct, urllib.request
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
CACHE = os.path.join(HERE, "cache")
BASE_URL = "https://github.com/madjin/vrm-samples/raw/master/vroid/beta/"

def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name + ".vrm")
    if not os.path.exists(path):
        urllib.request.urlretrieve(BASE_URL + name + ".vrm", path)
    return path

def read_glb(path):
    raw = open(path, "rb").read()
    jlen = struct.unpack("<I", raw[12:16])[0]
    gltf = json.loads(raw[20:20 + jlen])
    binbuf = raw[20 + jlen + 8:]
    return gltf, binbuf

def view_bytes(gltf, binbuf, i):
    v = gltf["bufferViews"][i]
    o = v.get("byteOffset", 0)
    return bytes(binbuf[o:o + v["byteLength"]])

def write_glb(path, gltf, chunks):
    """chunks[i] is the payload of bufferViews[i]."""
    newbin = bytearray()
    for i, c in enumerate(chunks):
        while len(newbin) % 4: newbin.append(0)
        gltf["bufferViews"][i]["byteOffset"] = len(newbin)
        gltf["bufferViews"][i]["byteLength"] = len(c)
        gltf["bufferViews"][i]["buffer"] = 0
        newbin += c
    while len(newbin) % 4: newbin.append(0)
    gltf["buffers"] = [{"byteLength": len(newbin)}]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(newbin)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(newbin), 0x004E4942)); f.write(newbin)
    print("wrote", os.path.relpath(path, ROOT), (12 + len(js) + len(newbin)) // 1024, "KB")

def png(im):
    b = io.BytesIO(); im.save(b, "PNG", optimize=True); return b.getvalue()

def shrink_image(data, max_size):
    im = Image.open(io.BytesIO(data))
    if max(im.size) <= max_size:
        return data
    s = max_size / max(im.size)
    im = im.convert("RGBA").resize((max(1, int(im.size[0] * s)), max(1, int(im.size[1] * s))), Image.LANCZOS)
    return png(im)

def shrink_vrm(src, out, max_tex=1024, meta_title=None):
    gltf, binbuf = read_glb(src)
    chunks = [view_bytes(gltf, binbuf, i) for i in range(len(gltf["bufferViews"]))]
    for im in gltf["images"]:
        lim = 256 if im.get("name") == "Thumbnail" else max_tex
        chunks[im["bufferView"]] = shrink_image(chunks[im["bufferView"]], lim)
    if meta_title:
        gltf["extensions"]["VRM"]["meta"]["title"] = meta_title
    write_glb(out, gltf, chunks)

def grey_hair(data, max_size=1024):
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    if max(im.size) > max_size:
        s = max_size / max(im.size)
        im = im.resize((int(im.size[0] * s), int(im.size[1] * s)), Image.LANCZOS)
    a = np.asarray(im).astype(float) / 255
    g = a[..., :3] @ np.array([0.3, 0.55, 0.15])
    vis = a[..., 3] > 0.1
    if vis.any():
        lo, hi = np.percentile(g[vis], 2), np.percentile(g[vis], 98)
        g = np.clip((g - lo) / max(hi - lo, 1e-3), 0, 1)
    g = 0.55 + 0.45 * g  # keep it light so the tint colour reads true
    a[..., 0] = a[..., 1] = a[..., 2] = g
    return png(Image.fromarray((a * 255).astype(np.uint8), "RGBA"))

def extract_hair(src, out):
    """Writes a glTF with every node (so bone names and bind pose survive) but only the hair
    mesh, its skin, its materials and textures."""
    g, binbuf = read_glb(src)
    hair_node = next(i for i, n in enumerate(g["nodes"])
                     if n.get("mesh") is not None and g["meshes"][n["mesh"]]["name"].startswith("Hair"))
    mesh = g["meshes"][g["nodes"][hair_node]["mesh"]]
    skin = g["skins"][g["nodes"][hair_node]["skin"]]

    new = {"asset": {"version": "2.0", "generator": "luloxi/vtuber build_assets.py"},
           "scene": 0, "scenes": [{"nodes": g["scenes"][g.get("scene", 0)]["nodes"]}],
           "nodes": [], "meshes": [], "skins": [], "accessors": [], "bufferViews": [],
           "materials": [], "textures": [], "images": [], "samplers": g.get("samplers", [{}])}
    chunks = []
    acc_map, mat_map, tex_map, img_map = {}, {}, {}, {}

    def add_view(data, extra=None):
        v = {"buffer": 0, "byteOffset": 0, "byteLength": len(data)}
        if extra: v.update(extra)
        new["bufferViews"].append(v); chunks.append(data)
        return len(new["bufferViews"]) - 1

    def acc(i):
        if i in acc_map: return acc_map[i]
        a = dict(g["accessors"][i])
        bv = g["bufferViews"][a["bufferView"]]
        data = view_bytes(g, binbuf, a["bufferView"])
        extra = {k: bv[k] for k in ("byteStride", "target") if k in bv}
        a["bufferView"] = add_view(data, extra)
        new["accessors"].append(a)
        acc_map[i] = len(new["accessors"]) - 1
        return acc_map[i]

    def img(i):
        if i in img_map: return img_map[i]
        im = g["images"][i]
        data = grey_hair(view_bytes(g, binbuf, im["bufferView"]))
        new["images"].append({"name": im.get("name", ""), "mimeType": "image/png", "bufferView": add_view(data)})
        img_map[i] = len(new["images"]) - 1
        return img_map[i]

    def tex(i):
        if i in tex_map: return tex_map[i]
        t = dict(g["textures"][i]); t["source"] = img(t["source"])
        new["textures"].append(t); tex_map[i] = len(new["textures"]) - 1
        return tex_map[i]

    def mat(i):
        if i in mat_map: return mat_map[i]
        m = g["materials"][i]
        nm = {"name": m["name"], "doubleSided": True,
              "alphaMode": m.get("alphaMode", "OPAQUE"),
              "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1}}
        if "alphaCutoff" in m: nm["alphaCutoff"] = m["alphaCutoff"]
        bct = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if bct: nm["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex(bct["index"])}
        new["materials"].append(nm); mat_map[i] = len(new["materials"]) - 1
        return mat_map[i]

    prims = []
    for p in mesh["primitives"]:
        q = {"attributes": {k: acc(v) for k, v in p["attributes"].items()}, "mode": p.get("mode", 4)}
        if "indices" in p: q["indices"] = acc(p["indices"])
        if "material" in p: q["material"] = mat(p["material"])
        prims.append(q)
    new["meshes"].append({"name": "Hair", "primitives": prims})
    s = {"joints": skin["joints"]}
    if "inverseBindMatrices" in skin: s["inverseBindMatrices"] = acc(skin["inverseBindMatrices"])
    if "skeleton" in skin: s["skeleton"] = skin["skeleton"]
    new["skins"].append(s)
    for i, n in enumerate(g["nodes"]):
        nn = {k: n[k] for k in ("name", "children", "translation", "rotation", "scale", "matrix") if k in n}
        if i == hair_node:
            nn["mesh"] = 0; nn["skin"] = 0
        new["nodes"].append(nn)
    write_glb(out, new, chunks)

if __name__ == "__main__":
    shrink_vrm(fetch("Sendagaya_Shibu"), os.path.join(ROOT, "public/models/woman.vrm"))
    shrink_vrm(fetch("HairSample_Male"), os.path.join(ROOT, "public/models/man.vrm"))
    for style, donor in [("bob", "Sendagaya_Shibu"), ("long", "Sendagaya_Shino"), ("short", "HairSample_Male"),
                         ("swept", "Sakurada_Fumiriya"), ("fluffy", "Victoria_Rubin")]:
        extract_hair(fetch(donor), os.path.join(ROOT, f"public/hair/{style}.glb"))
