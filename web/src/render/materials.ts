// The trunk's materials: land (the tile's albedo with detail by land class), the sea (waves, the sun's glint, the
// sky's reflection) and buildings. All lit by the atmosphere's tables (sunlight through the air, the sky's
// irradiance); the composite adds the air between the camera and them. Raw GLSL 3 with logarithmic depth.
import * as THREE from "three";
import { ATMOSPHERE_COMMON, ATMOSPHERE_LOOKUP } from "./atmosphere-glsl.ts";
import type { Atmosphere } from "./atmosphere.ts";
import { DETAIL_PERIOD } from "../tiles/gpu-format.ts";

const SHADING = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uSunE;
uniform vec3 uPlanet;
uniform highp sampler3D uNoise;
uniform float uTime;
uniform float logDepthBufFC;
const float PERIOD = ${DETAIL_PERIOD.toFixed(1)};

vec4 noiseAt(vec3 p, float k) { return texture(uNoise, p * (k / PERIOD)); }
/** 1 where texels of a scale are larger than a pixel, fading to 0 where they are smaller. */
float detailFade(float texel, float fw) { return 1.0 - smoothstep(texel * 0.6, texel * 4.0, fw); }

vec3 bumped(vec3 N, vec3 pos, float h) {
  vec3 dpx = dFdx(pos), dpy = dFdy(pos);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g);
}

struct Light { vec3 sun; vec3 sky; vec3 up; float r; float muS; };

Light lightAt(vec3 world) {
  vec3 P = sphericalize(world - uPlanet) * 0.001;
  Light l;
  l.r = length(P);
  l.up = P / l.r;
  l.muS = dot(l.up, uSun);
  l.sun = uSunE * sunTransmittance(l.r, l.muS);
  l.sky = uSunE * skyIrradiance(l.r, l.muS);
  return l;
}

vec3 diffuse(vec3 albedo, vec3 N, Light l, float ao) {
  float ndl = max(dot(N, uSun), 0.0);
  vec3 E = l.sun * ndl + l.sky * (0.6 + 0.4 * dot(N, l.up)) * ao;
  // a little light on the night side (the moon, the sky's glow) so the land is not a hole
  return albedo / PI * E + albedo * vec3(0.8, 0.9, 1.2) * 4e-5;
}
`;

const TERRAIN_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec4 aNormal;
in vec4 aColor;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out float vWater;
out vec3 vDetail;
out vec4 vW1;   // forest, low vegetation, cropland, built-up
out vec2 vW2;   // bare / rock, snow
out float vFragDepth;
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(modelMatrix) * aNormal.xyz;
  vColor = srgbToLinear(aColor.rgb);
  vWater = clamp(aNormal.w * 2.0, 0.0, 1.0);
  vDetail = position;
  int c = int(aColor.a * 255.0 + 0.5);
  vW1 = vec4(c == 1 || c == 10 ? 1.0 : 0.0, c == 2 || c == 3 || c == 9 || c == 11 ? 1.0 : 0.0, c == 4 ? 1.0 : 0.0, c == 5 ? 1.0 : 0.0);
  vW2 = vec2(c == 6 ? 1.0 : 0.0, c == 7 ? 1.0 : 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vFragDepth = 1.0 + gl_Position.w;
}
`;

const TERRAIN_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
${ATMOSPHERE_COMMON}
${ATMOSPHERE_LOOKUP}
${SHADING}
uniform vec3 cameraPosition;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in float vWater;
in vec3 vDetail;
in vec4 vW1;
in vec2 vW2;
in float vFragDepth;
out vec4 outColor;

vec3 land(vec3 N, float fw, Light l, out vec3 Nout) {
  vec3 albedo = vColor;
  // detail scales: texel 64 m (k=1), 8 m (k=8), 1 m (k=64)
  float f1 = detailFade(64.0, fw), f8 = detailFade(8.0, fw), f64 = detailFade(1.0, fw);
  vec4 n1 = noiseAt(vDetail, 1.0), n8 = noiseAt(vDetail, 8.0), n64 = noiseAt(vDetail, 64.0);
  float forest = vW1.x, low = vW1.y, crop = vW1.z, urban = vW1.w, bare = vW2.x, snow = vW2.y;
  float m = 1.0;
  // forest: crowns and clearings
  m *= mix(1.0, mix(0.62, 1.3, n8.r) * mix(0.85, 1.15, n1.b), forest * f8);
  m *= mix(1.0, mix(0.7, 1.25, n64.r), forest * f64);
  // grass, shrubs: soft patches
  m *= mix(1.0, mix(0.82, 1.18, n1.r) * mix(0.9, 1.1, n8.b), low * f1);
  // fields: patches with their own crop colour
  float field = textureLod(uNoise, (floor(vDetail * (64.0 / PERIOD) + 0.5 * n1.b) + 0.5) / 64.0, 0.0).g;
  vec3 tint = mix(vec3(0.85, 1.05, 0.75), vec3(1.25, 1.1, 0.75), field);
  albedo = mix(albedo, albedo * tint * mix(0.85, 1.15, n8.b), crop * f1);
  // built-up: a patchwork of roofs and yards (smooth noise at ~500 m and ~60 m), no lines: the trunk has no streets
  albedo = mix(albedo, albedo * mix(0.8, 1.2, n1.b) * mix(1.0, mix(0.82, 1.18, n8.r), f8), urban * f1);
  // rock: ridged streaks; snow: drifts
  m *= mix(1.0, mix(0.7, 1.25, n8.a) * mix(0.85, 1.15, n64.a), bare * f8);
  m *= mix(1.0, mix(0.9, 1.04, n8.r), snow * f8);
  albedo *= m;
  // relief at the scales the mesh does not have
  float h = (n8.a - 0.5) * 6.0 * f8 * (bare + snow + 0.5 * forest) + (n64.r - 0.5) * 0.8 * f64 * (forest + bare + low);
  Nout = bumped(N, vWorld, h);
  return diffuse(albedo, Nout, l, 1.0);
}

vec3 sea(vec3 N, float fw, Light l) {
  vec3 V = normalize(cameraPosition - vWorld);
  // waves: two moving octaves where they are larger than a pixel
  float t = uTime;
  float f32 = detailFade(2.0, fw), f256 = detailFade(0.25, fw);
  float h = (noiseAt(vDetail + vec3(1.1, 0.0, 0.7) * t, 32.0).r - 0.5) * 0.9 * f32
          + (noiseAt(vDetail - vec3(0.4, 0.3, 0.9) * t, 256.0).b - 0.5) * 0.12 * f256;
  vec3 Nw = bumped(N, vWorld, h);
  // the waves too small to see become roughness (larger as the view widens)
  float rough = clamp(0.07 + 0.25 * smoothstep(1.0, 600.0, fw), 0.07, 0.32);
  float a2 = rough * rough;
  vec3 H = normalize(V + uSun);
  float ndl = max(dot(Nw, uSun), 0.0), ndv = max(dot(Nw, V), 1e-3), ndh = max(dot(Nw, H), 0.0);
  float D = a2 / (PI * pow(ndh * ndh * (a2 - 1.0) + 1.0, 2.0));
  float Vis = 0.5 / (ndl * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndl * ndl * (1.0 - a2) + a2) + 1e-5);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  vec3 spec = l.sun * D * Vis * Fs * ndl;
  // the sky in the water: brighter toward the horizon
  vec3 R = reflect(-V, Nw);
  float ru = max(dot(R, l.up), 0.0);
  vec3 skyR = l.sky / PI * mix(2.2, 0.9, sqrt(ru));
  vec3 body = diffuse(vColor * 0.55, N, l, 1.0);
  return body * (1.0 - F) + skyR * F + spec;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 fw3 = fwidth(vDetail);
  float fw = max(max(fw3.x, fw3.y), fw3.z);
  Light l = lightAt(vWorld);
  vec3 Nl;
  vec3 c = land(N, fw, l, Nl);
  if (vWater > 0.01) c = mix(c, sea(l.up, fw, l), smoothstep(0.2, 0.8, vWater));
  outColor = vec4(c, 1.0);
  gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
}
`;

const BUILDINGS_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec4 aNormal;
in vec4 aColor;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out float vWall;
out vec3 vDetail;
out float vFragDepth;
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(modelMatrix) * aNormal.xyz;
  vColor = srgbToLinear(aColor.rgb);
  vWall = aColor.a;
  vDetail = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vFragDepth = 1.0 + gl_Position.w;
}
`;

const BUILDINGS_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
${ATMOSPHERE_COMMON}
${ATMOSPHERE_LOOKUP}
${SHADING}
uniform vec4 uHoles[8];      // places that replace the trunk's buildings: centre in the frame, radius (m)
uniform int uHoleCount;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in float vWall;
in vec3 vDetail;
in float vFragDepth;
out vec4 outColor;
void main() {
  for (int i = 0; i < 8; i++) {
    if (i >= uHoleCount) break;
    if (distance(vWorld, uHoles[i].xyz) < uHoles[i].w) discard;
  }
  vec3 N = normalize(vNormal);
  vec3 fw3 = fwidth(vDetail);
  float fw = max(max(fw3.x, fw3.y), fw3.z);
  Light l = lightAt(vWorld);
  vec3 albedo = vColor * mix(0.92, 1.08, noiseAt(vDetail, 8.0).b);
  // walls: floors of windows where a pixel is smaller than a floor
  if (vWall > 0.5) {
    float floors = fract(dot(vWorld - uPlanet, l.up) / 3.2);
    float win = smoothstep(0.25, 0.3, floors) * (1.0 - smoothstep(0.75, 0.8, floors));
    albedo *= mix(1.0, mix(1.0, 0.55, win), detailFade(1.5, fw));
  }
  vec3 c = diffuse(albedo, N, l, vWall > 0.5 ? 0.8 : 1.0);
  outColor = vec4(c, 1.0);
  gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
}
`;

export function terrainMaterial(atmo: Atmosphere, noise: THREE.IUniform<THREE.Texture>, time: THREE.IUniform<number>) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG,
    uniforms: { ...atmo.uniforms, uNoise: noise, uTime: time, logDepthBufFC: { value: 1 } },
  });
}

export function buildingsMaterial(atmo: Atmosphere, noise: THREE.IUniform<THREE.Texture>, time: THREE.IUniform<number>) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: BUILDINGS_VERT, fragmentShader: BUILDINGS_FRAG,
    uniforms: {
      ...atmo.uniforms, uNoise: noise, uTime: time, logDepthBufFC: { value: 1 },
      uHoles: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uHoleCount: { value: 0 },
    },
  });
}
