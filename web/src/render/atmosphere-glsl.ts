// The atmosphere's shader code: Earth's air as Hillaire 2020 ("A scalable and production ready sky and atmosphere
// rendering technique") describes it, with Bruneton's transmittance parameterisation. Lengths are km, positions are
// relative to the Earth's centre in a space where the WGS84 ellipsoid is a sphere (the polar axis stretched by a/b,
// see `sphericalize`), so the air's thickness follows the real surface at every latitude.

export const ATMOSPHERE_COMMON = /* glsl */ `
#define PI 3.14159265359
const float Rb = 6378.137;           // bottom (the ellipsoid, stretched to a sphere)
const float Rt = 6478.137;           // top: 100 km of air
const vec3 RAYLEIGH = vec3(5.802e-3, 13.558e-3, 33.1e-3);   // /km
const float MIE_SCAT = 3.996e-3;
const float MIE_EXT = 4.44e-3;
const vec3 OZONE = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float MIE_G = 0.8;
const vec2 T_SIZE = vec2(256.0, 64.0);
const vec2 MS_SIZE = vec2(32.0, 32.0);
const vec2 IRR_SIZE = vec2(64.0, 16.0);

struct Medium { vec3 scatR; float scatM; vec3 ext; };

Medium mediumAt(float h) {
  float dR = exp(-max(h, 0.0) / 8.0);
  float dM = exp(-max(h, 0.0) / 1.2);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  Medium m;
  m.scatR = RAYLEIGH * dR;
  m.scatM = MIE_SCAT * dM;
  m.ext = m.scatR + vec3(MIE_EXT * dM) + OZONE * dO;
  return m;
}

float distToTop(float r, float mu) {
  float d = r * r * (mu * mu - 1.0) + Rt * Rt;
  return max(0.0, -r * mu + sqrt(max(d, 0.0)));
}
float distToBottom(float r, float mu) {
  float d = r * r * (mu * mu - 1.0) + Rb * Rb;
  return max(0.0, -r * mu - sqrt(max(d, 0.0)));
}
bool hitsGround(float r, float mu) {
  return mu < 0.0 && r * r * (mu * mu - 1.0) + Rb * Rb >= 0.0;
}

float unitToUv(float x, float size) { return 0.5 / size + x * (1.0 - 1.0 / size); }
float uvToUnit(float u, float size) { return (u - 0.5 / size) / (1.0 - 1.0 / size); }

vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(Rt * Rt - Rb * Rb);
  float rho = sqrt(max(0.0, r * r - Rb * Rb));
  float d = distToTop(r, mu);
  float dmin = Rt - r, dmax = rho + H;
  float xmu = (d - dmin) / max(dmax - dmin, 1e-6);
  return vec2(unitToUv(clamp(xmu, 0.0, 1.0), T_SIZE.x), unitToUv(rho / H, T_SIZE.y));
}

float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float miePhase(float c) {
  float g = MIE_G, g2 = g * g;
  float k = 3.0 / (8.0 * PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

// (x, y, z) relative to the Earth's centre, the polar axis stretched so the ellipsoid is a sphere of radius a
uniform vec3 uPolar;          // the ECEF z axis in the frame
const float POLAR_STRETCH = 1.0033640898;   // a / b
vec3 sphericalize(vec3 v) { return v + (POLAR_STRETCH - 1.0) * dot(v, uPolar) * uPolar; }
`;

/** Lookups into the precomputed tables (needs ATMOSPHERE_COMMON). */
export const ATMOSPHERE_LOOKUP = /* glsl */ `
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform sampler2D uIrradiance;

vec3 transmittanceToTop(float r, float mu) {
  return texture(uTransmittance, transmittanceUv(clamp(r, Rb, Rt), mu)).rgb;
}
/** Sunlight reaching a point (the Earth's shadow included). */
vec3 sunTransmittance(float r, float muS) {
  r = clamp(r, Rb + 0.001, Rt);
  if (hitsGround(r, muS)) {
    // soften the terminator over the sun's angular size
    float horizon = -sqrt(max(0.0, 1.0 - (Rb * Rb) / (r * r)));
    float f = smoothstep(horizon - 0.004, horizon + 0.004, muS);
    return transmittanceToTop(r, muS) * f;
  }
  return transmittanceToTop(r, muS);
}
vec3 multiScatter(float r, float muS) {
  vec2 uv = vec2(unitToUv(muS * 0.5 + 0.5, MS_SIZE.x), unitToUv(clamp((r - Rb) / (Rt - Rb), 0.0, 1.0), MS_SIZE.y));
  return texture(uMultiScatter, uv).rgb;
}
/** Irradiance of the sky (not the sun) on a horizontal surface, per unit sun illuminance. */
vec3 skyIrradiance(float r, float muS) {
  vec2 uv = vec2(unitToUv(muS * 0.5 + 0.5, IRR_SIZE.x), unitToUv(clamp((r - Rb) / (Rt - Rb), 0.0, 1.0), IRR_SIZE.y));
  return texture(uIrradiance, uv).rgb;
}

/** Ray–sphere: the distances where p + t·v enters and leaves a sphere about the centre (t1 < 0: missed). */
vec2 sphere(vec3 p, vec3 v, float R) {
  float b = dot(p, v), c = dot(p, p) - R * R, d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}

/**
 * Light scattered toward p along -v over [0, tMax] (km), per unit sun illuminance, and the transmittance over it.
 * p, v in the stretched space; s the sun direction.
 */
void integrate(vec3 p, vec3 v, float tMax, vec3 s, int steps, float jitter, out vec3 L, out vec3 T) {
  L = vec3(0.0);
  T = vec3(1.0);
  // start where the ray enters the air
  vec2 top = sphere(p, v, Rt);
  if (top.y <= 0.0) return;
  float t0 = max(0.0, top.x);
  float t1 = min(tMax, top.y);
  if (t1 <= t0) return;
  float c = dot(v, s);
  float pR = rayleighPhase(c), pM = miePhase(c);
  float prev = t0;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    float f = (float(i) + jitter) / float(steps);
    float f1 = (float(i) + 1.0) / float(steps);
    float t = t0 + (t1 - t0) * f * f;
    float tn = t0 + (t1 - t0) * f1 * f1;
    float dt = tn - prev;
    prev = tn;
    vec3 P = p + t * v;
    float r = length(P);
    vec3 up = P / r;
    float muS = dot(up, s);
    Medium m = mediumAt(r - Rb);
    vec3 sunT = sunTransmittance(r, muS);
    vec3 ms = multiScatter(r, muS);
    vec3 scat = m.scatR + vec3(m.scatM);
    vec3 S = sunT * (m.scatR * pR + vec3(m.scatM * pM)) + ms * scat;
    vec3 stepT = exp(-m.ext * dt);
    vec3 Sint = (S - S * stepT) / max(m.ext, vec3(1e-7));
    L += T * Sint;
    T *= stepT;
  }
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Transmittance to the top of the air, for (r, mu). */
export const TRANSMITTANCE_FRAG = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
in vec2 vUv;
out vec4 outColor;
void main() {
  float xmu = uvToUnit(vUv.x, T_SIZE.x), xr = uvToUnit(vUv.y, T_SIZE.y);
  float H = sqrt(Rt * Rt - Rb * Rb);
  float rho = H * xr;
  float r = sqrt(rho * rho + Rb * Rb);
  float dmin = Rt - r, dmax = rho + H;
  float d = dmin + xmu * (dmax - dmin);
  float mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
  float len = distToTop(r, mu);
  vec3 od = vec3(0.0);
  const int N = 64;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) / float(N) * len;
    float ri = sqrt(t * t + 2.0 * r * mu * t + r * r);
    od += mediumAt(ri - Rb).ext * (len / float(N));
  }
  outColor = vec4(exp(-od), 1.0);
}
`;

/** Hillaire's multiple scattering: the second order and the geometric series of the rest, isotropic. */
export const MULTISCATTER_FRAG = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
uniform sampler2D uTransmittance;
in vec2 vUv;
out vec4 outColor;
vec3 transmittanceToTop(float r, float mu) { return texture(uTransmittance, transmittanceUv(clamp(r, Rb, Rt), mu)).rgb; }
void main() {
  float muS = uvToUnit(vUv.x, MS_SIZE.x) * 2.0 - 1.0;
  float r = Rb + uvToUnit(vUv.y, MS_SIZE.y) * (Rt - Rb);
  r = clamp(r, Rb + 0.01, Rt - 0.01);
  vec3 p = vec3(0.0, r, 0.0);
  vec3 s = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  vec3 L2 = vec3(0.0), fms = vec3(0.0);
  const int SQ = 8;
  const int STEPS = 20;
  vec3 groundAlbedo = vec3(0.3);
  for (int i = 0; i < SQ; i++) for (int j = 0; j < SQ; j++) {
    float th = PI * (float(i) + 0.5) / float(SQ);
    float ph = acos(1.0 - 2.0 * (float(j) + 0.5) / float(SQ));
    vec3 v = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
    float mu = v.y;
    bool ground = hitsGround(r, mu);
    float len = ground ? distToBottom(r, mu) : distToTop(r, mu);
    vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    float dt = len / float(STEPS);
    for (int k = 0; k < STEPS; k++) {
      float t = (float(k) + 0.5) * dt;
      vec3 P = p + t * v;
      float ri = length(P);
      Medium m = mediumAt(ri - Rb);
      vec3 sunT = transmittanceToTop(ri, dot(P / ri, s));
      if (hitsGround(ri, dot(P / ri, s))) sunT = vec3(0.0);
      vec3 scat = m.scatR + vec3(m.scatM);
      vec3 stepT = exp(-m.ext * dt);
      vec3 S = sunT * scat / (4.0 * PI);
      L += T * (S - S * stepT) / max(m.ext, vec3(1e-7));
      F += T * (scat - scat * stepT) / max(m.ext, vec3(1e-7));
      T *= stepT;
    }
    if (ground) {
      vec3 P = p + len * v;
      vec3 up = normalize(P);
      float muG = dot(up, s);
      L += T * transmittanceToTop(Rb, muG) * max(muG, 0.0) * groundAlbedo / PI;
    }
    float w = 1.0 / float(SQ * SQ);
    L2 += L * w;
    fms += F * w;
  }
  // uniform directions: ∫ X · (1/4π) dω is the mean of X
  vec3 psi = L2 / max(vec3(1.0) - fms, vec3(1e-3));
  outColor = vec4(psi, 1.0);
}
`;

/** Irradiance of the sky on a horizontal surface (single scattering + the multiple scattering term). */
export const IRRADIANCE_FRAG = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
${ATMOSPHERE_LOOKUP}
in vec2 vUv;
out vec4 outColor;
void main() {
  float muS = uvToUnit(vUv.x, IRR_SIZE.x) * 2.0 - 1.0;
  float r = Rb + max(0.005, uvToUnit(vUv.y, IRR_SIZE.y) * (Rt - Rb));
  vec3 p = vec3(0.0, r, 0.0);
  vec3 s = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  vec3 E = vec3(0.0);
  const int NA = 8, NB = 4;
  for (int i = 0; i < NA; i++) for (int j = 0; j < NB; j++) {
    float ph = 2.0 * PI * (float(i) + 0.5) / float(NA);
    float ct = sqrt((float(j) + 0.5) / float(NB));     // cosine-weighted over the hemisphere
    float st = sqrt(1.0 - ct * ct);
    vec3 v = vec3(st * cos(ph), ct, st * sin(ph));
    vec3 L, T;
    integrate(p, v, distToTop(r, ct), s, 16, 0.5, L, T);
    E += L;
  }
  // cosine-weighted samples: E = π · mean(L)
  outColor = vec4(E * PI / float(NA * NB), 1.0);
}
`;
