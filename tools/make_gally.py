"""
Builds public/models/gally.vrm, an Alita (Gunnm) inspired fan homage, from the
CC0 VRoid sample "Darkness Shibu" (beta AvatarSample_1, pixiv Inc., CC0).

Changes: dark brown-black hair, warm brown irises, dark brown liner and brows,
gunmetal cyborg arms and legs with panel seams, cyan glow lines (emission),
a desaturated graphite combat dress, and smaller textures for the web.

Usage: python3 tools/make_gally.py   (needs Pillow and numpy)
"""
import io, json, os, struct, urllib.request
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC_URL = "https://github.com/madjin/vrm-samples/raw/master/vroid/beta/Darkness_Shibu.vrm"
SRC = os.path.join(os.path.dirname(__file__), "Darkness_Shibu.vrm")
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "models", "gally.vrm")

if not os.path.exists(SRC):
    urllib.request.urlretrieve(SRC_URL, SRC)

raw = open(SRC, "rb").read()
jlen = struct.unpack("<I", raw[12:16])[0]
gltf = json.loads(raw[20:20 + jlen])
bin_start = 20 + jlen + 8
binbuf = raw[bin_start:]
views = gltf["bufferViews"]

def view_bytes(i):
    v = views[i]
    o = v.get("byteOffset", 0)
    return binbuf[o:o + v["byteLength"]]

chunks = [bytearray(view_bytes(i)) for i in range(len(views))]

def img_index(name):
    return next(i for i, im in enumerate(gltf["images"]) if im["name"] == name)

def load(name):
    return Image.open(io.BytesIO(bytes(chunks[gltf["images"][img_index(name)]["bufferView"]]))).convert("RGBA")

def store(name, im):
    b = io.BytesIO(); im.save(b, "PNG", optimize=True)
    chunks[gltf["images"][img_index(name)]["bufferView"]] = bytearray(b.getvalue())

def add_image(name, im):
    b = io.BytesIO(); im.save(b, "PNG", optimize=True)
    chunks.append(bytearray(b.getvalue()))
    views.append({"buffer": 0, "byteOffset": 0, "byteLength": 0})
    gltf["images"].append({"name": name, "bufferView": len(views) - 1, "mimeType": "image/png"})
    sampler = gltf["textures"][0].get("sampler", 0)
    gltf["textures"].append({"sampler": sampler, "source": len(gltf["images"]) - 1})
    return len(gltf["textures"]) - 1

def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(-1); mn = a.min(-1); d = mx - mn + 1e-6
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6
    s = np.where(mx > 0, (mx - mn) / (mx + 1e-6), 0)
    return h, s, mx

def hsv_to_rgb(h, s, v):
    i = np.floor(h * 6).astype(int) % 6; f = h * 6 - np.floor(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    out = np.zeros(h.shape + (3,))
    for k, (x, y, z) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        m = i == k
        out[m] = np.stack([x[m], y[m], z[m]], -1)
    return out

# 1) Irises: warm brown with an amber glow at the bottom.
iris = load("F00_000_EyeIris_00")
a = np.asarray(iris).astype(float) / 255
h, s, v = rgb_to_hsv(a[..., :3])
warm = h < 0.12  # the orange/red lower glow
nh = np.where(warm, 0.09, 0.065)
ns = np.clip(np.where(warm, s * 0.9, s * 0.75), 0, 1)
nv = np.clip(np.where(warm, v * 1.0, v * 0.85 + 0.05), 0, 1)
a[..., :3] = hsv_to_rgb(nh, ns, nv)
store("F00_000_EyeIris_00", Image.fromarray((a * 255).astype(np.uint8), "RGBA"))

# 2) Body: cyborg arms and legs.
body = load("F00_002_Body_00").resize((1024, 1024), Image.LANCZOS)
B = np.asarray(body).astype(float) / 255
W = H = 1024
yy, xx = np.mgrid[0:H, 0:W] / 1024.0
lum = B[..., :3].mean(-1)
hb, sb, vb = rgb_to_hsv(B[..., :3])
arms = ((xx < 0.24) | (xx > 0.76))
brown = (vb < 0.6) & (sb > 0.25) & (hb < 0.12)  # tights, gloves, boots areas
metal = arms | brown
# gunmetal base with a soft vertical gradient and a bit of the original grain
base = np.stack([0.34 + 0.10 * (1 - yy), 0.38 + 0.10 * (1 - yy), 0.45 + 0.10 * (1 - yy)], -1)
grain = (lum - lum[metal].mean() if metal.any() else 0)
metal_rgb = np.clip(base + grain[..., None] * 0.25, 0, 1)
out = B.copy()
out[..., :3] = np.where(metal[..., None], metal_rgb, B[..., :3])
# arms are fully visible now that the sleeves are cut away
out[..., 3] = np.where(arms, 1.0, out[..., 3])
emis = Image.new("RGBA", (W, H), (0, 0, 0, 255))
ov = Image.fromarray((out * 255).astype(np.uint8), "RGBA")
d = ImageDraw.Draw(ov); de = ImageDraw.Draw(emis)
mask_img = Image.fromarray((metal * 255).astype(np.uint8))
# panel seams: horizontal grooves on arm and leg columns, plus a vertical line
for x0, x1 in [(0, 0.24), (0.76, 1.0)]:
    X0, X1 = int(x0 * W), int(x1 * W)
    for yv in np.arange(0.30, 1.0, 0.11):
        Y = int(yv * H)
        d.line([(X0, Y), (X1, Y)], fill=(22, 26, 34, 255), width=5)
    cx = (X0 + X1) // 2
    d.line([(cx, int(0.22 * H)), (cx, H)], fill=(40, 46, 56, 255), width=3)
    for f in (0.12, 0.37, 0.63, 0.88):
        lx = int(X0 + (X1 - X0) * f)
        de.line([(lx, int(0.05 * H)), (lx, H)], fill=(60, 230, 255, 255), width=3)
    for yv in (0.30, 0.52, 0.74):
        de.line([(X0, int(yv * H) + 6), (X1, int(yv * H) + 6)], fill=(60, 230, 255, 255), width=2)
for yv in np.arange(0.40, 1.0, 0.09):
    Y = int(yv * H)
    d.line([(int(0.24 * W), Y), (int(0.76 * W), Y)], fill=(40, 46, 56, 255), width=3)
# only keep seams where the surface is metal
seams = Image.composite(ov, Image.fromarray((out * 255).astype(np.uint8), "RGBA"), mask_img)
emis = Image.composite(emis, Image.new("RGBA", (W, H), (0, 0, 0, 255)), mask_img).filter(ImageFilter.GaussianBlur(1.2))
store("F00_002_Body_00", seams)
store("F00_002_02_Body_00_nml", load("F00_002_02_Body_00_nml").resize((1024, 1024), Image.LANCZOS))
body_emis_tex = add_image("Gally_Body_Emission", emis)

# 3) Dress: graphite combat suit with cyan trim glow.
top = load("F00_002_Onepiece_01").resize((1024, 1024), Image.LANCZOS)
T = np.asarray(top).astype(float) / 255
g = T[..., :3] @ np.array([0.3, 0.5, 0.2])
g = np.clip((g - 0.1) * 1.1 + 0.08, 0, 1)
tint = np.stack([g * 0.5, g * 0.55, g * 0.64], -1)
T[..., :3] = tint
# cut the sleeves away (alpha tested material) so the cyborg arms show
sleeves = ((xx < 0.262) | (xx > 0.738)) & (yy < 0.52)
T[..., 3] = np.where(sleeves, 0.0, T[..., 3])
store("F00_002_Onepiece_01", Image.fromarray((T * 255).astype(np.uint8), "RGBA"))
ht, st, vt = rgb_to_hsv(np.asarray(load("F00_002_Onepiece_01").convert("RGBA")).astype(float)[..., :3] / 255)
# glow on the original bright-blue trims of the dress (now grey); detect from source
src_top = Image.open(io.BytesIO(view_bytes(gltf["images"][img_index("F00_002_Onepiece_01")]["bufferView"]))).convert("RGB").resize((1024, 1024))
S = np.asarray(src_top).astype(float) / 255
hs, ss, vs = rgb_to_hsv(S)
trim = (hs > 0.6) & (hs < 0.72) & (ss > 0.6) & (vs > 0.75)
te = np.zeros((1024, 1024, 4), np.uint8); te[..., 3] = 255
te[trim] = (60, 220, 255, 255)
top_emis_tex = add_image("Gally_Top_Emission", Image.fromarray(te, "RGBA").filter(ImageFilter.GaussianBlur(1.0)))

# 4) Smaller thumbnail.
store("Thumbnail", load("Thumbnail").resize((512, 512), Image.LANCZOS))

# 5) Material colors (VRM 0.x MToon properties + glTF base color).
props = {m["name"]: m for m in gltf["extensions"]["VRM"]["materialProperties"]}
mats = {m["name"]: m for m in gltf["materials"]}
def set_color(name, color, shade):
    p = props[name]
    p["vectorProperties"]["_Color"] = color + [1]
    p["vectorProperties"]["_ShadeColor"] = shade + [1]
    mats[name].setdefault("pbrMetallicRoughness", {})["baseColorFactor"] = color + [1]
hair = [0.16, 0.11, 0.10]; hair_shade = [0.05, 0.045, 0.07]
for n in ["F00_000_HairBack_00_HAIR", "F00_000_Hair_00_HAIR_01", "F00_000_Hair_00_HAIR_02"]:
    set_color(n, hair, hair_shade)
for n in ["F00_000_00_FaceEyeline_00_FACE", "F00_000_00_FaceEyelash_00_FACE"]:
    set_color(n, [0.10, 0.06, 0.05], [0.06, 0.035, 0.03])
set_color("F00_000_00_FaceBrow_00_FACE", [0.14, 0.09, 0.07], [0.08, 0.05, 0.04])
for n, t in [("F00_002_02_Body_00_SKIN", body_emis_tex), ("F00_002_01_Tops_01_CLOTH", top_emis_tex)]:
    props[n]["textureProperties"]["_EmissionMap"] = t
    props[n]["vectorProperties"]["_EmissionColor"] = [1, 1, 1, 1]
    mats[n]["emissiveTexture"] = {"index": t, "texCoord": 0}
    mats[n]["emissiveFactor"] = [1, 1, 1]
props["F00_002_01_Tops_01_CLOTH"]["vectorProperties"]["_ShadeColor"] = [0.55, 0.6, 0.7, 1]

meta = gltf["extensions"]["VRM"]["meta"]
meta["title"] = "Gally (Alita fan homage), based on Darkness Shibu (CC0)"
meta["author"] = "pixiv Inc. (base model, CC0), recolor by luloxi/vtuber"
meta["reference"] = "VRoid beta AvatarSample_1 (Darkness Shibu)"

# Repack the binary chunk.
newbin = bytearray()
for i, c in enumerate(chunks):
    while len(newbin) % 4: newbin.append(0)
    views[i]["byteOffset"] = len(newbin)
    views[i]["byteLength"] = len(c)
    newbin += c
while len(newbin) % 4: newbin.append(0)
gltf["buffers"] = [{"byteLength": len(newbin)}]
js = json.dumps(gltf, separators=(",", ":")).encode()
js += b" " * ((4 - len(js) % 4) % 4)
total = 12 + 8 + len(js) + 8 + len(newbin)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "wb") as f:
    f.write(struct.pack("<III", 0x46546C67, 2, total))
    f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack("<II", len(newbin), 0x004E4942)); f.write(newbin)
print("wrote", OUT, total // 1024, "KB")
