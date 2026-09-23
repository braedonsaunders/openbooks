import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// An extension bundle rides this body as JSON (up to the 10 MB server-side
// bundle cap), so the 11 MiB route ceiling is load-bearing: a real package
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
    "mock:feature-gates",
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: "org-1", id: "user-1" } };
      }
    `,
  ],
  [
    "mock:extensions",
    `
      export async function draftExtension(context, input) {
        return { id: "draft-1", reason: input.reason };
      }
      export async function getExtensionDraft() {
        throw new Error("not used");
      }
      export async function previewExtensionPage() {
        throw new Error("not used");
      }
      export async function discardExtensionDraft() {
        throw new Error("not used");
      }
      export async function activateExtensionDraft() {
        throw new Error("not used");
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/feature-gates") {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    if (specifier === "@/lib/application/extensions") {
      return { url: "mock:extensions", shortCircuit: true };
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

const { POST, MAX_DRAFT_BODY_BYTES } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

assert.equal(MAX_DRAFT_BODY_BYTES, 11 * 1024 * 1024);

function draftRequest(bundleBytes: number): Request {
  const body = JSON.stringify({
    action: "draft",
    reason: "load test",
    bundle: {
      manifest: { name: "test-app" },
      files: [{ path: "index.ts", content: "x".repeat(bundleBytes) }],
    },
  });
  return new Request("http://openbooks.test/api/apps/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("a multi-megabyte bundle under the route ceiling files a draft", async () => {
  const res = await POST(draftRequest(2 * 1024 * 1024));
  assert.notEqual(res.status, 413, "2 MiB exceeds the 1 MiB default: the override must apply");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string };
  assert.equal(body.id, "draft-1");
});

test("a bundle over the route ceiling gets the named 413", async () => {
  const res = await POST(draftRequest(12 * 1024 * 1024));
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: string; message: string };
  assert.match(body.error, /11 MiB/);
  assert.equal(body.message, body.error);
});
