// Small images for the mock demo, generated in code so the template ships no binary files: a PNG (stored deflate, no
// compression library) and a two-frame animated GIF (LZW with a clear code after every two pixels, so no table grows).
// Only the mock seeds these; they are ordinary bytes to the rest of the app, judged by sniffImage like any upload.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const td = concat([[...type].map((c) => c.charCodeAt(0)), data]);
  return concat([u32(data.length), td, u32(crc32(td))]);
}

/** An RGB PNG of w x h pixels, colour from `px(x, y)`. */
export function makePng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (1 + w * 3) + 1 + x * 3);
  }
  // zlib stream of stored (uncompressed) deflate blocks.
  const blocks: (Uint8Array | number[])[] = [[0x78, 0x01]];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const part = raw.subarray(at, at + 65535);
    const last = at + 65535 >= raw.length ? 1 : 0;
    blocks.push([last, part.length & 255, part.length >>> 8, ~part.length & 255, (~part.length >>> 8) & 255], part);
    if (last) break;
  }
  let a = 1, b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  blocks.push(u32(((b << 16) | a) >>> 0));
  const ihdr = concat([u32(w), u32(h), [8, 2, 0, 0, 0]]);
  return concat([[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk("IHDR", ihdr), chunk("IDAT", concat(blocks)), chunk("IEND", new Uint8Array())]);
}

/** A looping animated GIF, 4 colours, one frame per entry of `frames` (each w*h palette indices 0..3). */
export function makeGif(w: number, h: number, palette: [number, number, number][], frames: number[][], delayCs = 50): Uint8Array {
  const out: number[] = [..."GIF89a"].map((c) => c.charCodeAt(0));
  out.push(w & 255, w >> 8, h & 255, h >> 8, 0xf1, 0, 0); // global colour table, 4 entries
  for (let i = 0; i < 4; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  out.push(0x21, 0xff, 11, ..."NETSCAPE2.0".split("").map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, 0, delayCs & 255, delayCs >> 8, 0, 0);
    out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0);
    // LZW, minimum code size 2: clear = 4, end = 5, 3-bit codes. A clear before every two pixels keeps the width at 3.
    const codes: number[] = [];
    f.forEach((p, i) => { if (i % 2 === 0) codes.push(4); codes.push(p & 3); });
    codes.push(5);
    const bytes: number[] = [];
    let acc = 0, bits = 0;
    for (const c of codes) {
      acc |= c << bits; bits += 3;
      while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8; }
    }
    if (bits) bytes.push(acc & 255);
    out.push(2);
    for (let at = 0; at < bytes.length; at += 255) { const s = bytes.slice(at, at + 255); out.push(s.length, ...s); }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

/** A 48x32 gradient "site plan". */
export const demoPng = (): Uint8Array => makePng(48, 32, (x, y) => [40 + x * 4, 90 + y * 4, 200 - x * 2]);

/** A 16x16 two-frame blinking square. */
export function demoGif(): Uint8Array {
  const n = 16;
  const frame = (on: boolean) => Array.from({ length: n * n }, (_, i) => {
    const x = i % n, y = Math.floor(i / n);
    const inner = x >= 4 && x < 12 && y >= 4 && y < 12;
    return inner ? (on ? 1 : 2) : 3;
  });
  return makeGif(n, n, [[0, 0, 0], [240, 180, 30], [30, 120, 220], [245, 245, 245]], [frame(true), frame(false)]);
}

/** A 32x32 avatar in one hue. */
export const demoAvatar = (r: number, g: number, b: number): Uint8Array =>
  makePng(32, 32, (x, y) => ((x - 16) ** 2 + (y - 16) ** 2 < 150 ? [r, g, b] : [235, 238, 242]));
