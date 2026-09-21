import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStoredZip, crc32 } from "./zip-store.ts";

test("crc32 matches the known vector", () => {
  assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
});

test("duplicate and absolute entry names are refused", () => {
  assert.throws(() => buildStoredZip([{ name: "a.json", data: new Uint8Array([1]) }, { name: "a.json", data: new Uint8Array([2]) }]), /duplicated/);
  assert.throws(() => buildStoredZip([{ name: "/etc/passwd", data: new Uint8Array([1]) }]), /portable/);
});

test("the emitted zip unzips with the platform unzipper (independent oracle)", () => {
  const payload = Buffer.from(JSON.stringify({ hello: "world", n: 42 }), "utf8");
  const pdf = Buffer.from("%PDF-1.4 fake-idempotent-bytes", "utf8");
  const zip = buildStoredZip([
    { name: "export.json", data: payload },
    { name: "documents/contract.pdf", data: pdf },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "hrm-zip-"));
  const path = join(dir, "export.zip");
  writeFileSync(path, zip);
  // The oracle is the platform unzipper, not this module: listing and
  // extraction must both succeed and round-trip every byte.
  const listing = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
  assert.match(listing, /export\.json/);
  assert.match(listing, /documents\/contract\.pdf/);
  execFileSync("unzip", ["-o", "-q", path, "-d", dir]);
  const out = execFileSync("unzip", ["-p", path, "export.json"]);
  assert.deepEqual(Buffer.from(out), payload);
  const pdfOut = execFileSync("unzip", ["-p", path, "documents/contract.pdf"]);
  assert.deepEqual(Buffer.from(pdfOut), pdf);
});
