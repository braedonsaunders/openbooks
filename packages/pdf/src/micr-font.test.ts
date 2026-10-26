import assert from "node:assert/strict";
import test from "node:test";
import { assertMicrFont } from "./micr-font.ts";

/** Synthetic font metadata exercises admission, without asserting bank print certification. */
function metadataFont(
  name = "E13B Test",
  omit = -1,
  advance = 750,
  encoding: "unicode" | "abcd" = "unicode",
) {
  const tables = new Map<string, Buffer>();
  const head = Buffer.alloc(54);
  head.writeUInt16BE(1000, 18);
  tables.set("head", head);
  const chars = [...("0123456789 " + (encoding === "unicode" ? "⑆⑈⑉" : "ACD"))]
    .map((c) => c.codePointAt(0)!)
    .filter((c) => c !== omit)
    .sort((a, b) => a - b);
  const maxp = Buffer.alloc(6);
  maxp.writeUInt16BE(chars.length + 1, 4);
  tables.set("maxp", maxp);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt16BE(chars.length + 1, 34);
  tables.set("hhea", hhea);
  const hmtx = Buffer.alloc((chars.length + 1) * 4);
  for (let i = 0; i <= chars.length; i++) hmtx.writeUInt16BE(advance, i * 4);
  tables.set("hmtx", hmtx);
  const cmap = Buffer.alloc(12 + 16 + chars.length * 12);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(10, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(12, 12);
  cmap.writeUInt32BE(16 + chars.length * 12, 16);
  cmap.writeUInt32BE(chars.length, 24);
  chars.forEach((cp, i) => {
    cmap.writeUInt32BE(cp, 28 + i * 12);
    cmap.writeUInt32BE(cp, 32 + i * 12);
    cmap.writeUInt32BE(i + 1, 36 + i * 12);
  });
  tables.set("cmap", cmap);
  const text = Buffer.from(name, "utf16le");
  text.swap16();
  const names = Buffer.alloc(18 + text.length);
  names.writeUInt16BE(1, 2);
  names.writeUInt16BE(18, 4);
  names.writeUInt16BE(3, 6);
  names.writeUInt16BE(1, 8);
  names.writeUInt16BE(4, 12);
  names.writeUInt16BE(text.length, 14);
  text.copy(names, 18);
  tables.set("name", names);
  let offset = 12 + tables.size * 16;
  const font = Buffer.alloc(offset + [...tables.values()].reduce((s, b) => s + b.length, 0));
  font.writeUInt32BE(0x10000, 0);
  font.writeUInt16BE(tables.size, 4);
  let index = 0;
  for (const [tag, bytes] of tables) {
    const at = 12 + index++ * 16;
    font.write(tag, at);
    font.writeUInt32BE(offset, at + 8);
    font.writeUInt32BE(bytes.length, at + 12);
    bytes.copy(font, offset);
    offset += bytes.length;
  }
  return font;
}

test("MICR font admission refuses ordinary fonts, missing symbols and nonstandard pitch", () => {
  assert.doesNotThrow(() => assertMicrFont(metadataFont()));
  assert.throws(() => assertMicrFont(metadataFont("Ordinary Sans")), /E-13B/);
  assert.throws(() => assertMicrFont(metadataFont("E13B Test", 0x2448)), /E-13B/);
  assert.throws(() => assertMicrFont(metadataFont("E13B Test", -1, 600)), /E-13B/);
  assert.throws(() => assertMicrFont(Buffer.from("not a font")), /E-13B/);
});

test("MICR admission requires the declared control-symbol encoding", () => {
  const encoded = metadataFont("E13B Test", -1, 750, "abcd");
  assert.doesNotThrow(() => assertMicrFont(encoded, "abcd"));
  assert.throws(() => assertMicrFont(encoded, "unicode"), /selected encoding/);
  assert.throws(
    () => assertMicrFont(metadataFont("E13B Test", 67, 750, "abcd"), "abcd"),
    /selected encoding/,
  );
});
