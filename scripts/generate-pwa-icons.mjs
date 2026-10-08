import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const source = await readFile(new URL('../web/app/icon.svg', import.meta.url), 'utf8');
const artwork = source.replace(/<svg[^>]*>/, '').replace('</svg>', '');
const directory = new URL('../web/public/pwa/', import.meta.url);
await mkdir(directory, { recursive: true });

function tile(scale) {
  const inset = 24 * (1 - scale);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 48 48"><rect width="48" height="48" fill="#fff"/><g transform="translate(${inset} ${inset}) scale(${scale})">${artwork}</g></svg>`);
}

for (const [name, size, scale] of [
  ['icon-192.png', 192, 0.82],
  ['icon-512.png', 512, 0.82],
  // The entire mark fits inside the centered circle with radius 40% of the tile.
  ['maskable-512.png', 512, 0.65],
  ['apple-touch-icon.png', 180, 0.82],
]) {
  await sharp(tile(scale)).resize(size, size).removeAlpha().png().toFile(new URL(name, directory).pathname);
}

// PNG-backed ICO entries retain the same artwork in browsers requesting /favicon.ico.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((size) => sharp(tile(0.9)).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [index, png] of images.entries()) {
  const entry = 6 + index * 16;
  header[entry] = sizes[index];
  header[entry + 1] = sizes[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(new URL('../web/app/favicon.ico', import.meta.url), Buffer.concat([header, ...images]));
