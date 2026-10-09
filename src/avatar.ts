import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VRM } from '@pixiv/three-vrm';
import type { OutfitDef, PartId } from './characters';

const plainLoader = new GLTFLoader();
const hairCache = new Map<string, Promise<ArrayBuffer>>();
const tmpV = new THREE.Vector3();

type AnyMat = THREE.Material & {
  color?: THREE.Color; map?: THREE.Texture | null; shadeColorFactor?: THREE.Color;
  shadeMultiplyTexture?: THREE.Texture | null; emissive?: THREE.Color; emissiveMap?: THREE.Texture | null;
  isOutline?: boolean; isMToonMaterial?: boolean; alphaTest: number;
};

interface Rest { head: THREE.Matrix4; hips: THREE.Matrix4; chest: THREE.Matrix4 }
interface HeadBox { min: THREE.Vector3; max: THREE.Vector3; center: THREE.Vector3; size: THREE.Vector3 }

/** Everything the customizer adds to or changes on one loaded VRM. */
export class AvatarDresser {
  vrm: VRM;
  private rest: Rest;
  private head: HeadBox;
  private hairObjects: THREE.Object3D[] = [];
  private parts: THREE.Object3D[] = [];
  private accessories: THREE.Object3D[] = [];
  private tails: { obj: THREE.Object3D; base: THREE.Euler; phase: number }[] = [];
  private mats: AnyMat[] = [];
  private originals = new Map<AnyMat, { map: THREE.Texture | null; shadeMap: THREE.Texture | null; color: THREE.Color; shade?: THREE.Color; emissive?: THREE.Color; emissiveMap: THREE.Texture | null }>();
  private hairMats: AnyMat[] = [];
  private hairProto: AnyMat | null = null;
  private hairColor = new THREE.Color('#2a2220');
  private chestFront: number | null = null;
  hairStyle: string | null = null;

  constructor(vrm: VRM) {
    this.vrm = vrm;
    vrm.scene.updateMatrixWorld(true);
    const world = (name: string) => {
      const n = vrm.humanoid.getNormalizedBoneNode(name as never);
      return n ? n.matrixWorld.clone() : new THREE.Matrix4();
    };
    this.rest = { head: world('head'), hips: world('hips'), chest: world('upperChest') };
    if (!vrm.humanoid.getNormalizedBoneNode('upperChest')) this.rest.chest = world('chest');

    // Face box (rest pose, world space). The avatar faces +Z.
    const box = new THREE.Box3();
    vrm.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && /^Face/i.test(o.name)) box.expandByObject(o, true);
    });
    if (box.isEmpty()) {
      const hp = new THREE.Vector3().setFromMatrixPosition(this.rest.head);
      box.setFromCenterAndSize(hp.add(new THREE.Vector3(0, 0.1, 0)), new THREE.Vector3(0.18, 0.24, 0.2));
    }
    this.head = { min: box.min.clone(), max: box.max.clone(), center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };

    vrm.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list as AnyMat[]) {
        if (!this.mats.includes(m)) this.mats.push(m);
        if (/^Hair/i.test(o.name) && !m.isOutline && m.isMToonMaterial && !this.hairProto && m.alphaTest > 0) this.hairProto = m;
      }
      if (/^Hair/i.test(o.name) && !this.hairProto) {
        const m = list.find((x) => (x as AnyMat).isMToonMaterial && !(x as AnyMat).isOutline) as AnyMat | undefined;
        if (m) this.hairProto = m;
      }
    });
    for (const m of this.mats) {
      this.originals.set(m, {
        map: m.map ?? null, shadeMap: m.shadeMultiplyTexture ?? null, color: m.color?.clone() ?? new THREE.Color(1, 1, 1),
        shade: m.shadeColorFactor?.clone(), emissive: m.emissive?.clone(), emissiveMap: m.emissiveMap ?? null,
      });
    }
  }

  // ---------- hair ----------
  async setHair(style: string) {
    if (style === this.hairStyle) return;
    const url = `/hair/${style}.glb`;
    if (!hairCache.has(url)) hairCache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`hair ${style}: ${r.status}`); return r.arrayBuffer(); }));
    const buf = await hairCache.get(url)!;
    const gltf = await plainLoader.parseAsync(buf.slice(0), '');
    this.clearHair();
    // hide the model's own hair
    this.vrm.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && /^Hair/i.test(o.name) && !o.userData.transplant) o.visible = false; });

    const meshes: THREE.SkinnedMesh[] = [];
    gltf.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
    if (!meshes.length) return;
    const targetByName = new Map<string, THREE.Object3D>();
    this.vrm.scene.traverse((o) => { if (!(o as THREE.Mesh).isMesh && o.name) targetByName.set(o.name, o); });

    const donor = meshes[0].skeleton;
    const mapped = new Map<THREE.Object3D, THREE.Object3D>();
    for (const b of donor.bones) { const t = targetByName.get(b.name); if (t) mapped.set(b, t); }
    // Hair bones that the target does not have: hang them under the matching target parent.
    for (const b of donor.bones) {
      if (mapped.has(b)) continue;
      const p = b.parent;
      if (p && mapped.has(p)) { const target = mapped.get(p)!; target.add(b); this.hairObjects.push(b); }
    }
    const skeleton = new THREE.Skeleton(donor.bones.map((b) => (mapped.get(b) as THREE.Bone) ?? b), donor.boneInverses);
    for (const m of meshes) {
      m.bind(skeleton, m.bindMatrix);
      m.frustumCulled = false;
      m.userData.transplant = true;
      m.material = this.makeHairMaterial(m.material as THREE.MeshStandardMaterial);
      this.vrm.scene.add(m);
      this.hairObjects.push(m);
    }
    this.hairStyle = style;
  }

  private makeHairMaterial(src: THREE.MeshStandardMaterial): THREE.Material {
    let mat: AnyMat;
    if (this.hairProto) {
      mat = this.hairProto.clone() as AnyMat;
      mat.map = src.map; mat.shadeMultiplyTexture = src.map;
    } else {
      mat = new THREE.MeshToonMaterial({ map: src.map }) as unknown as AnyMat;
    }
    mat.side = THREE.DoubleSide;
    mat.transparent = src.transparent;
    mat.alphaTest = src.transparent ? 0 : Math.max(src.alphaTest, 0.5);
    mat.depthWrite = !src.transparent;
    mat.needsUpdate = true;
    this.hairMats.push(mat);
    this.paintHair(mat);
    return mat;
  }

  private paintHair(m: AnyMat) {
    m.color?.copy(this.hairColor);
    m.shadeColorFactor?.copy(this.hairColor).multiplyScalar(0.55);
    if (m.emissive) m.emissive.setRGB(0, 0, 0);
  }

  setHairColor(hex: string) {
    this.hairColor.set(hex);
    for (const m of this.hairMats) this.paintHair(m);
    for (const p of this.parts) p.traverse((o) => { if (o.userData.hairTint) ((o as THREE.Mesh).material as THREE.MeshToonMaterial).color.set(hex); });
  }

  private clearHair() {
    for (const o of this.hairObjects) o.removeFromParent();
    for (const m of this.hairMats) m.dispose();
    this.hairObjects = []; this.hairMats = []; this.hairStyle = null;
  }

  // ---------- skin and outfit ----------
  setSkin(hex: string | null) {
    for (const m of this.mats) {
      if (!/SKIN/i.test(m.name)) continue;
      const o = this.originals.get(m)!;
      if (!hex) { this.restore(m); continue; }
      const tex = o.map ? tintTexture(o.map, hex, 0.6) : null;
      m.map = tex; m.shadeMultiplyTexture = tex;
      m.color?.set(1, 1, 1);
      m.shadeColorFactor?.setRGB(0.82, 0.8, 0.86);
      m.needsUpdate = true;
    }
  }

  setOutfit(outfit: OutfitDef) {
    for (const m of this.mats) {
      if (!/CLOTH/i.test(m.name)) continue;
      const o = this.originals.get(m)!;
      if (!outfit.tint) { this.restore(m); continue; }
      const tex = o.map ? tintTexture(o.map, outfit.tint, 0.5) : null;
      m.map = tex; m.shadeMultiplyTexture = tex;
      m.color?.set(1, 1, 1);
      m.shadeColorFactor?.setRGB(0.7, 0.72, 0.8);
      if (m.emissive) {
        if (outfit.glow && o.map) { m.emissiveMap = edgeGlowTexture(o.map, outfit.glow); m.emissive.set(1, 1, 1); }
        else { m.emissiveMap = null; m.emissive.set(0, 0, 0); }
      }
      m.needsUpdate = true;
    }
    for (const a of this.accessories) a.removeFromParent();
    this.accessories = [];
    if (outfit.accessory) this.addAccessory(outfit.accessory, outfit.tint ?? '#888888');
  }

  private restore(m: AnyMat) {
    const o = this.originals.get(m)!;
    m.map = o.map; m.shadeMultiplyTexture = o.shadeMap;
    m.color?.copy(o.color);
    if (o.shade) m.shadeColorFactor?.copy(o.shade);
    if (o.emissive) m.emissive?.copy(o.emissive);
    m.emissiveMap = o.emissiveMap;
    m.needsUpdate = true;
  }

  // ---------- procedural parts ----------
  private attach(obj: THREE.Object3D, bone: 'head' | 'hips' | 'chest') {
    const node = bone === 'chest'
      ? (this.vrm.humanoid.getNormalizedBoneNode('upperChest') ?? this.vrm.humanoid.getNormalizedBoneNode('chest'))
      : this.vrm.humanoid.getNormalizedBoneNode(bone);
    if (!node) return;
    // obj is built in rest-pose world space. Convert it into the bone's local frame.
    obj.applyMatrix4(new THREE.Matrix4().copy(this.rest[bone]).invert());
    node.add(obj);
  }

  private getChestFront(): number {
    if (this.chestFront !== null) return this.chestFront;
    const neckY = new THREE.Vector3().setFromMatrixPosition(this.rest.chest).y + 0.12;
    let best = -Infinity;
    this.vrm.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || !/^Body/i.test(o.name)) return;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 3) {
        m.getVertexPosition(i, tmpV);
        m.applyBoneTransform(i, tmpV);
        tmpV.applyMatrix4(m.matrixWorld);
        if (Math.abs(tmpV.x) < 0.035 && tmpV.y < neckY - 0.06 && tmpV.y > neckY - 0.2) best = Math.max(best, tmpV.z);
      }
    });
    this.chestFront = isFinite(best) ? best : new THREE.Vector3().setFromMatrixPosition(this.rest.chest).z + 0.1;
    return this.chestFront;
  }

  private addAccessory(kind: 'tie' | 'badge', tint: string) {
    const chest = new THREE.Vector3().setFromMatrixPosition(this.rest.chest);
    const neck = new THREE.Vector3().setFromMatrixPosition(this.rest.head);
    const front = this.getChestFront();
    const g = new THREE.Group();
    if (kind === 'tie') {
      const s = new THREE.Shape();
      s.moveTo(0, 0); s.lineTo(0.018, -0.02); s.lineTo(0.03, -0.2); s.lineTo(0, -0.24); s.lineTo(-0.03, -0.2); s.lineTo(-0.018, -0.02); s.lineTo(0, 0);
      const mat = toon(0x2b4a7a);
      const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.006, bevelEnabled: false }), mat);
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 8), mat);
      knot.scale.set(1.2, 0.9, 0.6);
      const stripe = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.002, bevelEnabled: false }), toon(0x9fb6d8));
      stripe.scale.set(0.18, 0.9, 1); stripe.position.z = 0.0065;
      g.add(blade, knot, stripe);
      g.position.set(0, neck.y - 0.075, front + 0.014);
      g.rotation.x = -0.12;
    } else {
      const s = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.022 : 0.009, a = Math.PI / 2 + (i * Math.PI) / 5;
        if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      const star = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: false }), toon(0xf2c94c, 0x3a2a00));
      g.add(star);
      g.position.set(0.07, chest.y + 0.03, front - 0.01);
    }
    g.traverse((o) => (o.frustumCulled = false));
    this.attach(g, 'chest');
    this.accessories.push(g);
  }

  setParts(parts: PartId[], color: string) {
    for (const p of this.parts) p.removeFromParent();
    this.parts = []; this.tails = [];
    const H = this.head;
    const w = H.size.x, h = H.size.y, top = H.max.y, front = H.max.z, cz = H.center.z, bottom = H.min.y;
    const hairTint = color === 'hair';
    const col = hairTint ? this.hairColor.getHex() : new THREE.Color(color).getHex();
    const furMat = () => { const m = toon(col); return m; };
    const hips = new THREE.Vector3().setFromMatrixPosition(this.rest.hips);
    const add = (o: THREE.Object3D, bone: 'head' | 'hips', tintable = true) => {
      if (tintable && hairTint) o.traverse((c) => { if ((c as THREE.Mesh).isMesh && c.userData.fur) c.userData.hairTint = true; });
      o.traverse((c) => (c.frustumCulled = false));
      this.attach(o, bone);
      this.parts.push(o);
    };
    const fur = (geo: THREE.BufferGeometry) => { const m = new THREE.Mesh(geo, furMat()); m.userData.fur = true; return m; };

    const pointyEar = (side: 1 | -1, radius: number, height: number, tip: number | null, inner: number) => {
      const g = new THREE.Group();
      const outer = fur(new THREE.ConeGeometry(radius, height, 4, 1));
      outer.rotation.y = Math.PI / 4; outer.scale.z = 0.45;
      g.add(outer);
      const inn = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.6, height * 0.7, 4, 1), toon(inner));
      inn.rotation.y = Math.PI / 4; inn.scale.z = 0.3; inn.position.set(0, -height * 0.08, radius * 0.18);
      g.add(inn);
      if (tip !== null) {
        const t = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.38, height * 0.32, 4, 1), toon(tip));
        t.rotation.y = Math.PI / 4; t.scale.z = 0.5; t.position.y = height * 0.36;
        g.add(t);
      }
      g.position.set(side * w * 0.3, top - h * 0.06 + height * 0.35, cz - 0.005);
      g.rotation.z = -side * 0.32;
      return g;
    };

    for (const part of parts) {
      switch (part) {
        case 'catEars': for (const s of [1, -1] as const) add(pointyEar(s, 0.042, 0.075, null, 0xf4b6c2), 'head'); break;
        case 'foxEars': for (const s of [1, -1] as const) add(pointyEar(s, 0.05, 0.11, 0x3a2418, 0xf6e7d0), 'head'); break;
        case 'wolfEars': for (const s of [1, -1] as const) add(pointyEar(s, 0.05, 0.1, 0x4a4038, 0xe8e0d8), 'head'); break;
        case 'bunnyEars': for (const s of [1, -1] as const) {
          const g = new THREE.Group();
          const outer = fur(new THREE.CapsuleGeometry(0.028, 0.2, 6, 12)); outer.scale.z = 0.45;
          const inn = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.16, 6, 12), toon(0xf2b8c8)); inn.scale.z = 0.3; inn.position.z = 0.008;
          g.add(outer, inn);
          g.position.set(s * w * 0.17, top + 0.1, cz);
          g.rotation.z = -s * 0.18; g.rotation.x = -0.12;
          add(g, 'head');
        } break;
        case 'elfEars': for (const s of [1, -1] as const) {
          const e = fur(new THREE.ConeGeometry(0.02, 0.1, 10));
          e.rotation.z = -s * (Math.PI / 2 - 0.55);
          e.scale.z = 0.4;
          e.position.set(s * (w * 0.5 + 0.03), bottom + h * 0.47, cz - 0.01);
          add(e, 'head');
        } break;
        case 'antennae': for (const s of [1, -1] as const) {
          const g = new THREE.Group();
          const stalk = fur(new THREE.CylinderGeometry(0.004, 0.006, 0.13, 8)); stalk.position.y = 0.065;
          const ball = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), toon(0xd8ff6a, 0x557700)); ball.position.y = 0.135;
          g.add(stalk, ball);
          g.position.set(s * w * 0.18, top - 0.02, cz);
          g.rotation.z = -s * 0.4;
          add(g, 'head', false);
        } break;
        case 'antennaGlow': {
          const g = new THREE.Group();
          const stalk = fur(new THREE.CylinderGeometry(0.003, 0.005, 0.11, 8)); stalk.position.y = 0.055;
          const ball = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12), toon(0xbff4ff, 0x46c8ff)); ball.position.y = 0.115;
          g.add(stalk, ball);
          g.position.set(0, top - 0.015, cz + 0.01);
          g.rotation.x = 0.25;
          add(g, 'head', false);
        } break;
        case 'whiskers': for (const s of [1, -1] as const) for (let i = 0; i < 3; i++) {
          const wsk = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 0.06, 4), toon(0x333333));
          wsk.rotation.z = Math.PI / 2 + s * (i - 1) * 0.18;
          wsk.position.set(s * w * 0.3, bottom + h * 0.22 + (i - 1) * 0.008, front - 0.03);
          add(wsk, 'head', false);
        } break;
        case 'foxMuzzle': case 'wolfMuzzle': case 'bunnyNose': {
          const g = new THREE.Group();
          const noseY = bottom + h * 0.27;
          if (part !== 'bunnyNose') {
            const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), toon(part === 'foxMuzzle' ? 0xf8ead6 : 0xe9e4de));
            m.scale.set(0.03, 0.018, 0.022);
            m.position.set(0, noseY, front - 0.012);
            g.add(m);
          }
          const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), toon(part === 'bunnyNose' ? 0xf29bb2 : 0x231a17));
          nose.scale.set(0.009, 0.006, 0.006);
          nose.position.set(0, noseY + 0.006, front + (part === 'bunnyNose' ? -0.002 : 0.008));
          g.add(nose);
          add(g, 'head', false);
        } break;
        case 'foxTail': case 'wolfTail': {
          const pts = [];
          for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector2(Math.sin(Math.PI * Math.pow(t, 0.8)) * 0.075 + 0.004, t * 0.42)); }
          const g = new THREE.Group();
          const body = fur(new THREE.LatheGeometry(pts, 16));
          const tip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 14, 10), toon(part === 'foxTail' ? 0xfbf3e6 : 0xe5ded6));
          tip.position.y = 0.37; tip.scale.set(1, 1.3, 1);
          g.add(body, tip);
          const holder = new THREE.Group();
          holder.add(g);
          g.rotation.set(-0.9, 0, -0.9);
          holder.position.set(hips.x, hips.y - 0.05, hips.z - 0.09);
          add(holder, 'hips');
          this.tails.push({ obj: g, base: g.rotation.clone(), phase: 0 });
        } break;
        case 'catTail': {
          const curve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, -0.1, -0.08), new THREE.Vector3(0.16, -0.05, -0.12),
            new THREE.Vector3(0.24, 0.12, -0.1), new THREE.Vector3(0.22, 0.26, -0.06),
          ]);
          const tube = fur(new THREE.TubeGeometry(curve, 40, 0.016, 8, false));
          const g = new THREE.Group(); g.add(tube);
          const holder = new THREE.Group(); holder.add(g);
          holder.position.set(hips.x, hips.y - 0.05, hips.z - 0.09);
          add(holder, 'hips');
          this.tails.push({ obj: g, base: g.rotation.clone(), phase: 1.3 });
        } break;
        case 'bunnyTail': {
          const puff = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), toon(0xf7f5fa));
          puff.position.set(hips.x, hips.y - 0.06, hips.z - 0.13);
          add(puff, 'hips', false);
        } break;
      }
    }
  }

  update(t: number) {
    for (const tail of this.tails) {
      tail.obj.rotation.y = tail.base.y + Math.sin(t * 2.2 + tail.phase) * 0.25;
      tail.obj.rotation.z = tail.base.z + Math.sin(t * 1.4 + tail.phase) * 0.08;
    }
  }

  dispose() { this.clearHair(); }
}

function toon(color: number, emissive = 0x000000) {
  return new THREE.MeshToonMaterial({ color, emissive });
}

// ---------- texture recolouring ----------
const tintCache = new Map<string, THREE.Texture>();
function imageData(tex: THREE.Texture): { canvas: HTMLCanvasElement; data: ImageData } | null {
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  if (!img || !img.width) return null;
  const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

function finish(src: THREE.Texture, canvas: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = src.flipY; t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = src.wrapS; t.wrapT = src.wrapT;
  t.needsUpdate = true;
  return t;
}

/** Greyscale the texture (keeping its shading and detail) and multiply by a colour. */
export function tintTexture(src: THREE.Texture, hex: string, detail: number): THREE.Texture {
  const key = `${src.uuid}|${hex}|${detail}`;
  const hit = tintCache.get(key);
  if (hit) return hit;
  const r = imageData(src);
  if (!r) return src;
  const { canvas, data } = r;
  const c = new THREE.Color(hex);
  const cr = c.r * 255, cg = c.g * 255, cb = c.b * 255;
  const px = data.data;
  // Normalise luminance so the result centres on the chosen colour.
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) if (px[i + 3] > 20) { sum += px[i] * 0.3 + px[i + 1] * 0.55 + px[i + 2] * 0.15; n++; }
  const avg = n ? sum / n : 128;
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] * 0.3 + px[i + 1] * 0.55 + px[i + 2] * 0.15) / (avg || 1);
    const k = 1 - detail + detail * Math.min(l, 1.6);
    px[i] = Math.min(255, cr * k); px[i + 1] = Math.min(255, cg * k); px[i + 2] = Math.min(255, cb * k);
  }
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  const t = finish(src, canvas);
  tintCache.set(key, t);
  return t;
}

/** Emission map that lights up the strongest edges of a texture (cyber trims). */
function edgeGlowTexture(src: THREE.Texture, hex: string): THREE.Texture {
  const key = `${src.uuid}|glow|${hex}`;
  const hit = tintCache.get(key);
  if (hit) return hit;
  const r = imageData(src);
  if (!r) return src;
  const { canvas, data } = r;
  const w = canvas.width, h = canvas.height, px = data.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.55 + px[i * 4 + 2] * 0.15;
  const c = new THREE.Color(hex);
  const out = new Uint8ClampedArray(px.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const g = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + w] - lum[i - w]);
    const v = g > 90 ? 1 : 0;
    out[i * 4] = c.r * 255 * v; out[i * 4 + 1] = c.g * 255 * v; out[i * 4 + 2] = c.b * 255 * v; out[i * 4 + 3] = 255;
  }
  data.data.set(out);
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  const t = finish(src, canvas);
  tintCache.set(key, t);
  return t;
}
