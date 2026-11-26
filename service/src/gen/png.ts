// A small PNG reader (8-bit, non-interlaced: what terrain tiles are) and writer (RGB, for previews).
import { deflate, inflate } from "./inflate.ts";

export interface Image {
  width: number;
  height: number;
  /** samples per pixel in `data` (1 gray, 3 RGB, 4 RGBA) */
  channels: number;
  data: Uint8Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export async function decodePng(buf: Uint8Array): Promise<Image> {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error("not a PNG");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatSize = 0;
  while (at + 8 <= buf.length) {
    const len = dv.getUint32(at);
    const type = String.fromCharCode(buf[at + 4], buf[at + 5], buf[at + 6], buf[at + 7]);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(at + 8); height = dv.getUint32(at + 12);
      depth = buf[at + 16]; ctype = buf[at + 17]; interlace = buf[at + 20];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") { idat.push(body); idatSize += len; }
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} not supported`);
  if (interlace) throw new Error("interlaced PNG not supported");
  const spp = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : ctype === 6 ? 4 : 0;
  if (!spp) throw new Error(`PNG colour type ${ctype} not supported`);
  const z = new Uint8Array(idatSize);
  let o = 0;
  for (const p of idat) { z.set(p, o); o += p.length; }
  const raw = await inflate(z, "deflate");
  const stride = width * spp;
  if (raw.length < height * (stride + 1)) throw new Error("PNG data too short");
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride, prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= spp ? px[row + i - spp] : 0;
      const b = y > 0 ? px[prev + i] : 0;
      const c = y > 0 && i >= spp ? px[prev + i - spp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + i] = v;
    }
  }
  if (ctype === 3) {
    if (!palette) throw new Error("PNG palette missing");
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const k = px[i];
      out[4 * i] = palette[3 * k]; out[4 * i + 1] = palette[3 * k + 1]; out[4 * i + 2] = palette[3 * k + 2];
      out[4 * i + 3] = trns && k < trns.length ? trns[k] : 255;
    }
    return { width, height, channels: 4, data: out };
  }
  return { width, height, channels: spp, data: px };
}

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(b: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGB (channels 3) or gray (1) or RGBA (4), 8-bit. */
export async function encodePng(img: Image): Promise<Uint8Array> {
  const { width, height, channels, data } = img;
  const ctype = channels === 1 ? 0 : channels === 3 ? 2 : channels === 4 ? 6 : -1;
  if (ctype < 0) throw new Error("encodePng: 1, 3 or 4 channels");
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const z = await deflate(raw, "deflate");
  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = ctype;
  chunks.push(["IHDR", ihdr], ["IDAT", z], ["IEND", new Uint8Array(0)]);
  let size = 8;
  for (const [, b] of chunks) size += 12 + b.length;
  const out = new Uint8Array(size);
  const odv = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = 8;
  for (const [t, b] of chunks) {
    odv.setUint32(at, b.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = t.charCodeAt(i);
    out.set(b, at + 8);
    odv.setUint32(at + 8 + b.length, crc32(out, at + 4, at + 8 + b.length));
    at += 12 + b.length;
  }
  return out;
}
