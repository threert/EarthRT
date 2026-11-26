// The web renderer: tiles as three.js meshes placed in core's floating frame (transforms in doubles on the CPU, f32
// relative to the frame on the GPU), drawn into an HDR multisampled target with logarithmic depth, then the composite
// (sky, aerial perspective, tone mapping) to the screen.
import * as THREE from "three";
import { FloatingOrigin, terrainIndex, type V3 } from "@earthrt/core";
import type { PackedBuildings, PackedTerrain } from "../tiles/gpu-format.ts";
import type { Entry, Renderer } from "../tiles/manager.ts";
import { Atmosphere, compositeMaterial, Fullscreen } from "./atmosphere.ts";
import { buildingsMaterial, terrainMaterial } from "./materials.ts";
import { flatNoise, makeDetailNoise } from "./noise.ts";
import type { Basis } from "../camera/math.ts";

export interface TileObject {
  mesh: THREE.Mesh;
  center: V3;
  gen: number;
}

export class Globe implements Renderer<TileObject> {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e8);
  readonly origin = new FloatingOrigin(0, 0);
  readonly atmo = new Atmosphere();
  readonly terrainGroup = new THREE.Group();
  readonly buildingsGroup = new THREE.Group();
  /** Places' content (glTF scenes), placed by their owners. */
  readonly placesGroup = new THREE.Group();
  private readonly time = { value: 0 };
  private readonly noise: THREE.IUniform<THREE.Texture> = { value: flatNoise() };
  readonly terrainMat: THREE.RawShaderMaterial;
  readonly buildingsMat: THREE.RawShaderMaterial;
  readonly capMat: THREE.RawShaderMaterial;
  private readonly composite: Fullscreen;
  private target: THREE.WebGLRenderTarget;
  private readonly terrainIndex: THREE.BufferAttribute;
  private readonly logDepth = { value: 1 };
  readonly sunLight = new THREE.DirectionalLight(0xffffff, 3);
  readonly ambient = new THREE.HemisphereLight(0xbfd8ff, 0x404040, 0.6);
  /** Camera in ECEF (doubles). */
  camPos: V3 = [0, 0, 0];
  exposure = 10;
  baseExposure = 10;

  constructor(readonly canvas: HTMLCanvasElement, readonly samples = 4) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, logarithmicDepthBuffer: true, powerPreference: "high-performance", stencil: false });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    this.terrainMat = terrainMaterial(this.atmo, this.noise, this.time);
    this.buildingsMat = buildingsMaterial(this.atmo, this.noise, this.time);
    this.terrainMat.uniforms.logDepthBufFC = this.logDepth;
    this.capMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: this.terrainMat.vertexShader, fragmentShader: this.terrainMat.fragmentShader,
      uniforms: this.terrainMat.uniforms, side: THREE.DoubleSide,
    });
    this.buildingsMat.uniforms.logDepthBufFC = this.logDepth;
    this.composite = new Fullscreen(compositeMaterial(this.atmo));
    this.target = this.makeTarget(1, 1);
    const idx = terrainIndex(65);
    this.terrainIndex = new THREE.BufferAttribute(Uint16Array.from(idx), 1);
    this.scene.add(this.terrainGroup, this.buildingsGroup, this.placesGroup, this.sunLight, this.sunLight.target, this.ambient);
    this.camera.matrixAutoUpdate = false;
  }

  private makeTarget(w: number, h: number) {
    const depth = new THREE.DepthTexture(w, h, THREE.FloatType);
    depth.format = THREE.DepthFormat;
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples: this.samples, depthTexture: depth,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true, stencilBuffer: false,
    });
  }

  precompute() {
    this.atmo.precompute(this.renderer);
  }

  /** The detail noise (a few tens of ms on the CPU): after the first picture. */
  makeNoise() {
    this.noise.value = makeDetailNoise();
  }

  resize(w: number, h: number, dpr: number) {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.target.width !== W || this.target.height !== H) {
      this.target.dispose();
      this.target = this.makeTarget(W, H);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------------------------------------- tiles (Renderer)

  createTerrain(t: PackedTerrain): TileObject {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(t.position, 3));
    g.setAttribute("aNormal", new THREE.BufferAttribute(t.normal, 4, true));
    g.setAttribute("aColor", new THREE.BufferAttribute(t.color, 4, true));
    g.setIndex(t.n === 65 ? this.terrainIndex : new THREE.BufferAttribute(terrainIndex(t.n), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.radius);
    // (the caps: drawn from both sides; cap/n's rows run toward the pole, which winds core's index inward)
    const mesh = new THREE.Mesh(g, t.key.startsWith("cap") ? this.capMat : this.terrainMat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.name = t.key;
    return { mesh, center: t.center, gen: -1 };
  }

  createBuildings(t: PackedBuildings): TileObject {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(t.position, 3));
    g.setAttribute("aNormal", new THREE.BufferAttribute(t.normal, 4, true));
    g.setAttribute("aColor", new THREE.BufferAttribute(t.color, 4, true));
    g.setIndex(new THREE.BufferAttribute(t.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.radius);
    const mesh = new THREE.Mesh(g, this.buildingsMat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.name = `b:${t.key}`;
    return { mesh, center: t.center, gen: -1 };
  }

  dispose(o: TileObject) {
    o.mesh.removeFromParent();
    const idx = o.mesh.geometry.index;
    if (idx === this.terrainIndex) o.mesh.geometry.setIndex(null);
    o.mesh.geometry.dispose();
  }

  private place(o: TileObject) {
    if (o.gen === this.origin.generation) return;
    const t = this.origin.placeEcef(o.center);
    o.mesh.position.set(t.position[0], t.position[1], t.position[2]);
    o.mesh.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
    o.mesh.updateMatrix();
    o.mesh.matrixWorld.copy(o.mesh.matrix);
    o.gen = this.origin.generation;
  }

  // ------------------------------------------------------------------------------------------------------- the frame

  /** Moves the frame under the camera (SPEC § 1) and sets the camera. Returns true when the frame moved. */
  setCamera(pos: V3, b: Basis, fovDeg: number): boolean {
    this.camPos = pos;
    const rebased = this.origin.update(pos);
    const f = this.origin.frame;
    const p = f.point(pos), fw = f.dir(b.forward), up = f.dir(b.up), r = f.dir(b.right);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...r), new THREE.Vector3(...up), new THREE.Vector3(-fw[0], -fw[1], -fw[2]));
    m.setPosition(p[0], p[1], p[2]);
    this.camera.matrix.copy(m);
    this.camera.matrixWorld.copy(m);
    this.camera.matrixWorldInverse.copy(m).invert();
    this.camera.position.set(p[0], p[1], p[2]);
    this.camera.quaternion.setFromRotationMatrix(m);
    const alt = Math.hypot(...pos) - 6371000;
    this.camera.fov = fovDeg;
    this.camera.near = Math.min(50, Math.max(0.05, Math.abs(alt) * 0.0005));
    this.camera.far = 1e8;
    this.camera.updateProjectionMatrix();
    this.logDepth.value = 2.0 / (Math.log(this.camera.far + 1.0) / Math.LN2);
    return rebased;
  }

  setSun(sunEcef: V3) {
    const f = this.origin.frame;
    const s = f.dir(sunEcef);
    const u = this.atmo.uniforms;
    u.uSun.value.set(s[0], s[1], s[2]).normalize();
    const pol = f.dir([0, 0, 1]);
    u.uPolar.value.set(pol[0], pol[1], pol[2]);
    const c = f.point([0, 0, 0]);
    u.uPlanet.value.set(c[0], c[1], c[2]);
    // glTF places are lit by three's lights in the terrain's units: the sun's irradiance 1 through the air, the sky's
    // irradiance as a hemisphere (approximations of the atmosphere's tables, by the sun's height at the camera)
    this.sunLight.position.copy(u.uSun.value).multiplyScalar(1000).add(this.camera.position);
    this.sunLight.target.position.copy(this.camera.position);
    this.sunLight.target.updateMatrixWorld();
    const up = new THREE.Vector3(...f.dir(norm3(this.camPos)));
    const mu = u.uSun.value.dot(up);
    const t = sunThroughAir(mu);
    this.sunLight.color.setRGB(t[0], t[1], t[2]);
    this.sunLight.intensity = 1;
    const day = Math.max(0, Math.min(1, (mu + 0.1) * 4));
    this.ambient.color.setRGB(0.035 * day + 2e-4, 0.07 * day + 3e-4, 0.15 * day + 5e-4);
    this.ambient.groundColor.setRGB(0.02 * day, 0.02 * day, 0.018 * day);
    this.ambient.intensity = 1;
    // exposure: the day's at noon, opened up at night (eyes adapt) unless the camera is out in space
    const alt = Math.hypot(...this.camPos) - 6371000;
    const night = (1 - Math.max(0, Math.min(1, (mu + 0.12) * 6))) * (1 - Math.max(0, Math.min(1, (alt - 50_000) / 400_000)));
    this.exposure = this.baseExposure * Math.pow(30, night);
  }

  render(terrain: Entry<TileObject>[], buildings: Entry<TileObject>[], seconds: number) {
    this.time.value = seconds;
    const tg = this.terrainGroup, bg = this.buildingsGroup;
    tg.children.length = 0;
    bg.children.length = 0;
    for (const e of terrain) {
      this.place(e.object!);
      tg.children.push(e.object!.mesh);
    }
    for (const e of buildings) {
      this.place(e.object!);
      bg.children.push(e.object!.mesh);
    }
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.clear(true, true, false);
    // (matrixWorld of tiles is set by place(); the scene's own update is for places' glTF hierarchies)
    tg.matrixWorldAutoUpdate = false;
    bg.matrixWorldAutoUpdate = false;
    r.render(this.scene, this.camera);
    // composite
    const cm = this.composite.material.uniforms;
    cm.tColor.value = this.target.texture;
    cm.tDepth.value = this.target.depthTexture;
    (cm.uCamRot.value as THREE.Matrix3).setFromMatrix4(this.camera.matrixWorld);
    const ty = Math.tan((this.camera.fov * Math.PI) / 360);
    (cm.uTan.value as THREE.Vector2).set(ty * this.camera.aspect, ty);
    cm.uLogFar.value = Math.log2(this.camera.far + 1);
    const cp = this.origin.frame.dir(this.camPos);
    (cm.uCamP.value as THREE.Vector3).set(cp[0] / 1000, cp[1] / 1000, cp[2] / 1000);
    cm.uExposure.value = this.exposure;
    cm.uTime.value = seconds;
    this.composite.render(r, null);
  }

  /** A unit ray (ECEF) through a pixel (CSS px). */
  ray(x: number, y: number, b: Basis, w: number, h: number): V3 {
    const ty = Math.tan((this.camera.fov * Math.PI) / 360), tx = ty * (w / h);
    const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
    const d: V3 = [
      b.forward[0] + b.right[0] * nx * tx + b.up[0] * ny * ty,
      b.forward[1] + b.right[1] * nx * tx + b.up[1] * ny * ty,
      b.forward[2] + b.right[2] * nx * tx + b.up[2] * ny * ty,
    ];
    const l = Math.hypot(...d);
    return [d[0] / l, d[1] / l, d[2] / l];
  }

  /** Where an ECEF point is on screen (CSS px), and whether it is in front of the camera. */
  project(p: V3, w: number, h: number): { x: number; y: number; front: boolean; dist: number } {
    const l = this.origin.frame.point(p);
    const v = new THREE.Vector3(l[0], l[1], l[2]).applyMatrix4(this.camera.matrixWorldInverse);
    const dist = v.length();
    const front = v.z < 0;
    v.applyMatrix4(this.camera.projectionMatrix);
    return { x: (v.x * 0.5 + 0.5) * w, y: (0.5 - v.y * 0.5) * h, front, dist };
  }

  gpuInfo() {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "webgl2";
  }
}

const norm3 = (p: V3): V3 => {
  const l = Math.hypot(...p) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
};

/** Sunlight's transmittance through the air for a sun at cos(zenith) mu (Kasten–Young air mass; optical depths of
 *  Rayleigh, Mie and ozone at sea level for the atmosphere-glsl constants). */
export function sunThroughAir(mu: number): [number, number, number] {
  if (mu < -0.05) return [0, 0, 0];
  const z = Math.acos(Math.max(-1, Math.min(1, mu))) * 180 / Math.PI;
  const m = 1 / (Math.max(0, mu) + 0.50572 * Math.pow(Math.max(0.1, 96.07995 - z), -1.6364));
  const tau = [0.062, 0.142, 0.27];
  const fade = Math.max(0, Math.min(1, (mu + 0.05) / 0.07));
  return [Math.exp(-tau[0] * m) * fade, Math.exp(-tau[1] * m) * fade, Math.exp(-tau[2] * m) * fade];
}
