import assert from "node:assert/strict";
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

const { MAX_UPLOAD_BYTES, isUploadContentType, listApplicationFiles, validateCabinetUpload } = await import("./files.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context").ApplicationContext;

function context(permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: { orgId: "file-read-unit-test" } as ApplicationContext["authz"]["user"],
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: "file-read-unit-request",
    apiKeyId: null,
  };
}

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

test("file list rejects a malformed folder id before reading the cabinet", async () => {
  await assert.rejects(
    listApplicationFiles(context(["documents.read"]), { folderId: "not-a-uuid" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "invalid_input"
      && error.status === 422
      && error.message === "folderId must be a UUID",
  );
});

test("file list refuses callers without document read permission", async () => {
  await assert.rejects(
    listApplicationFiles(context([]), {}),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "forbidden"
      && error.status === 403
      && error.details?.permission === "documents.read",
  );
});
