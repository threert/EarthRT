// The atmosphere's tables (computed once on the GPU at start, a few ms) and the composite pass that puts the sky
// behind everything and the air in front of everything (aerial perspective from the depth buffer), then tone maps.
import * as THREE from "three";
import { ATMOSPHERE_COMMON, ATMOSPHERE_LOOKUP, FULLSCREEN_VERT, IRRADIANCE_FRAG, MULTISCATTER_FRAG, TRANSMITTANCE_FRAG } from "./atmosphere-glsl.ts";

const tri = new THREE.BufferGeometry();
tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const orth = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export class Fullscreen {
  readonly mesh: THREE.Mesh;
  readonly scene = new THREE.Scene();
  constructor(readonly material: THREE.RawShaderMaterial) {
    this.mesh = new THREE.Mesh(tri, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  render(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
    r.setRenderTarget(target);
    r.render(this.scene, orth);
  }
}

const lutTarget = (w: number, h: number) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  depthBuffer: false, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
});

const raw = (frag: string, uniforms: Record<string, THREE.IUniform> = {}) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
});

export interface AtmosphereUniforms {
  uTransmittance: THREE.IUniform<THREE.Texture>;
  uMultiScatter: THREE.IUniform<THREE.Texture>;
  uIrradiance: THREE.IUniform<THREE.Texture>;
  uPolar: THREE.IUniform<THREE.Vector3>;
  uSun: THREE.IUniform<THREE.Vector3>;
  uSunE: THREE.IUniform<THREE.Color>;
  uPlanet: THREE.IUniform<THREE.Vector3>;
}

export class Atmosphere {
  readonly transmittance = lutTarget(256, 64);
  readonly multiScatter = lutTarget(32, 32);
  readonly irradiance = lutTarget(64, 16);
  /** Shared by every material that lights itself with the sky (terrain, buildings, the composite). */
  readonly uniforms: AtmosphereUniforms = {
    uTransmittance: { value: this.transmittance.texture },
    uMultiScatter: { value: this.multiScatter.texture },
    uIrradiance: { value: this.irradiance.texture },
    uPolar: { value: new THREE.Vector3(0, 1, 0) },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uSunE: { value: new THREE.Color(1, 1, 1) },
    /** The Earth's centre in the frame, m. */
    uPlanet: { value: new THREE.Vector3(0, -6378137, 0) },
  };
  precomputeMs = 0;

  precompute(r: THREE.WebGLRenderer) {
    const t0 = performance.now();
    const t = new Fullscreen(raw(TRANSMITTANCE_FRAG));
    t.render(r, this.transmittance);
    const ms = new Fullscreen(raw(MULTISCATTER_FRAG, { uTransmittance: this.uniforms.uTransmittance, uPolar: this.uniforms.uPolar }));
    ms.render(r, this.multiScatter);
    const irr = new Fullscreen(raw(IRRADIANCE_FRAG, { ...this.uniforms }));
    irr.render(r, this.irradiance);
    r.setRenderTarget(null);
    for (const f of [t, ms, irr]) f.material.dispose();
    this.precomputeMs = performance.now() - t0;
  }
}

/** The composite: scene colour + depth → sky, aerial perspective, sun, tone mapping, sRGB. */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
${ATMOSPHERE_LOOKUP}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat3 uCamRot;       // camera axes in the frame
uniform vec2 uTan;          // tan(fov/2)·aspect, tan(fov/2)
uniform float uLogFar;      // log2(far + 1)
uniform vec3 uCamP;         // camera relative to the Earth's centre, km (frame axes)
uniform vec3 uSun;
uniform vec3 uSunE;
uniform float uExposure;
uniform float uTime;
in vec2 vUv;
out vec4 outColor;

vec3 aces(vec3 x) {
  // Stephen Hill's fit of the ACES RRT + ODT
  const mat3 I = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 O = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  x = I * x;
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(O * (a / b), 0.0, 1.0);
}
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }

vec3 stars(vec3 d) {
  vec3 q = d * 400.0;
  vec3 c = floor(q);
  float h = hash13(c);
  if (h < 0.9975) return vec3(0.0);
  vec3 f = fract(q) - 0.5;
  float k = exp(-dot(f, f) * 40.0);
  float b = (h - 0.9975) / 0.0025;
  return vec3(0.8 + 0.2 * b, 0.85, 1.0 - 0.15 * b) * k * b * b * 0.02;
}

void main() {
  vec4 c = texture(tColor, vUv);
  float depth = texture(tDepth, vUv).r;
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 vd = vec3(ndc.x * uTan.x, ndc.y * uTan.y, -1.0);
  float vlen = length(vd);
  vec3 dir = uCamRot * (vd / vlen);
  vec3 p = sphericalize(uCamP);
  vec3 v = sphericalize(dir);
  float vs = length(v);
  v /= vs;
  vec3 L, T, col;
  float jitter = 0.5;
  if (depth < 1.0) {
    float w = exp2(depth * uLogFar) - 1.0;
    float dist = w * vlen * 0.001 * vs;
    int steps = dist < 2.0 ? 6 : 14;
    integrate(p, v, dist, uSun, steps, jitter, L, T);
    vec3 surf = c.rgb;
    // (a NaN from a surface's shading would print black: drop it, the air's light stays)
    if (any(isnan(surf)) || any(isinf(surf))) surf = vec3(0.0);
    col = surf * T + L * uSunE;
  } else {
    vec2 g = sphere(p, v, Rb);
    bool ground = g.x > 0.0;
    integrate(p, v, ground ? g.x : 1e9, uSun, 32, jitter, L, T);
    col = L * uSunE;
    if (ground) {
      // nothing drawn here yet (a tile on its way): the sea's colour, lit, so the gap does not show as space
      vec3 P = p + g.x * v;
      vec3 up = normalize(P);
      float muS = dot(up, uSun);
      vec3 E = uSunE * (sunTransmittance(Rb, muS) * max(muS, 0.0) + skyIrradiance(Rb, muS));
      col += T * vec3(0.012, 0.03, 0.05) / PI * E;
    } else {
      float cs = dot(dir, uSun);
      float sunCos = 0.99998917;     // the sun's angular radius, 0.2666°
      float disk = smoothstep(sunCos - 0.0000025, sunCos + 0.0000025, cs);
      col += T * uSunE * disk * 2.0e4;
      col += T * stars(dir) * (1.0 - smoothstep(0.0, 0.2, max(max(L.r, L.g), L.b) * 10.0));
    }
  }
  col *= uExposure;
  col = aces(col);
  col = toSrgb(col);
  col += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;

export function compositeMaterial(atmo: Atmosphere) {
  return raw(COMPOSITE_FRAG, {
    ...atmo.uniforms,
    tColor: { value: null },
    tDepth: { value: null },
    uCamRot: { value: new THREE.Matrix3() },
    uTan: { value: new THREE.Vector2(1, 1) },
    uLogFar: { value: 1 },
    uCamP: { value: new THREE.Vector3() },
    uExposure: { value: 10 },
    uTime: { value: 0 },
  });
}
