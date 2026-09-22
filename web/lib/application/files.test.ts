import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { MAX_UPLOAD_BYTES, isUploadContentType, validateCabinetUpload } = await import("./files.ts");
const SOURCE = readFileSync(new URL("./files.ts", import.meta.url), "utf8");

test("cabinet upload accepts the route's allowlisted types and rejects the rest", () => {
  assert.equal(isUploadContentType("application/pdf"), true);
  assert.equal(isUploadContentType("text/csv"), true);
  assert.equal(isUploadContentType("application/pdf; charset=binary"), true);
  assert.equal(isUploadContentType("application/x-sh"), false);
  assert.equal(isUploadContentType(""), false);
});

test("cabinet upload validation refuses blank names, bad payloads, and oversize files", () => {
  const good = { filename: "note.txt", contentType: "text/plain", contentBase64: Buffer.from("hi").toString("base64") };
  assert.deepEqual(validateCabinetUpload(good), {
    filename: "note.txt",
    contentType: "text/plain",
    bytes: Buffer.from("hi"),
  });
  assert.throws(() => validateCabinetUpload({ ...good, filename: "  " }), /filename is required/);
  assert.throws(() => validateCabinetUpload({ ...good, contentType: "application/x-sh" }), /unsupported file type/);
  assert.throws(() => validateCabinetUpload({ ...good, contentBase64: "!!!not-base64!!!" }), /not valid base64/);
  assert.throws(() => validateCabinetUpload({ ...good, contentBase64: "" }), /file is empty/);
  const over = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 7).toString("base64");
  assert.throws(
    () => validateCabinetUpload({ ...good, contentBase64: over }),
    /exceeds the 1 MB tool upload limit/,
  );
});

test("file list reuses the cabinet reader and refuses a non-UUID folder", () => {
  assert.match(SOURCE, /listFiles\(/);
  assert.match(SOURCE, /assertApplicationPermission\(context, "documents\.read"\)/);
  assert.match(SOURCE, /folderId must be a UUID/);
});
