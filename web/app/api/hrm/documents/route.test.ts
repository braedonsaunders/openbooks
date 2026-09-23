import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// HR letters ride the upload body as base64 (bodies.ts caps fileBase64 at
// 14M chars), so the 15 MiB upload ceiling is load-bearing: a real letter
// exceeds the 1 MiB house default. The boundary itself stays REAL — mocking
// parseJsonBody here would make the 413 assertions hollow.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: "org-1", id: "user-1" } };
      }
    `,
  ],
  [
    "mock:features",
    `
      export async function isFeatureEnabled() {
        return true;
      }
    `,
  ],
  [
    "mock:hrm-documents",
    `
      export async function uploadDocument(input) {
        return { id: "doc-1", title: input.title };
      }
      export async function generateDocument() {
        throw new Error("not used");
      }
      export async function listDocuments() {
        throw new Error("not used");
      }
      export async function resolveMergeFields() {
        throw new Error("not used");
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier === "../../../../lib/features") {
      return { url: "mock:features", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/src/hrm/documents/documents.ts") {
      return { url: "mock:hrm-documents", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) {
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { POST, MAX_UPLOAD_BODY_BYTES } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

assert.equal(MAX_UPLOAD_BODY_BYTES, 15 * 1024 * 1024);

const PARTY_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

function uploadRequest(fileBase64Bytes: number): Request {
  const body = JSON.stringify({
    partyId: PARTY_ID,
    categoryKey: "offer-letter",
    title: "Offer",
    filename: "offer.pdf",
    contentType: "application/pdf",
    fileBase64: "x".repeat(fileBase64Bytes),
  });
  return new Request("http://openbooks.test/api/hrm/documents?mode=upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("a multi-megabyte letter under the upload ceiling is accepted", async () => {
  const res = await POST(uploadRequest(2 * 1024 * 1024));
  assert.notEqual(res.status, 413, "2 MiB exceeds the 1 MiB default: the override must apply");
  assert.equal(res.status, 201);
  const body = (await res.json()) as { document: { id: string } };
  assert.equal(body.document.id, "doc-1");
});

test("a letter over the upload ceiling gets the named 413", async () => {
  const res = await POST(uploadRequest(16 * 1024 * 1024));
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: string; message: string };
  assert.match(body.error, /15 MiB/);
  assert.equal(body.message, body.error);
});
