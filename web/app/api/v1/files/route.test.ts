import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-files-route-test");
interface RouteState {
  uploads: Array<{ authz: unknown; input: Record<string, unknown> }>;
  listed: Array<{ context: unknown; input: Record<string, unknown> }>;
  claims: Array<{ operation: string; idempotencyKey: string }>;
}

const routeState: RouteState = { uploads: [], listed: [], claims: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        try {
          const result = await operation(
            { user: { orgId: "org-1" }, keyId: "key-1" },
            { authz: { user: { orgId: "org-1", id: "user-1" } } },
          )
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          return Response.json(
            { error: error.code ?? "internal_error", message: error.message },
            { status: error.status ?? 500 },
          )
        }
      }
      export async function readV1JsonObject(request) {
        return await request.json()
      }
      export function requireV1IdempotencyKey(request) {
        const key = request.headers.get("idempotency-key")
        if (!key) {
          const error = new Error("Idempotency-Key header is required")
          error.code = "invalid_input"
          error.status = 400
          throw error
        }
        return key
      }
    `,
  ],
  [
    "mock:files",
    `
      const state = globalThis[Symbol.for('openbooks.v1-files-route-test')]
      // The route's GET reads through this same module. A double that omits an
      // export the route imports does not fail loudly at that call — the ES
      // module never instantiates, so the whole file fails to load and every
      // test in it reports as one opaque failure.
      export async function listApplicationFiles(context, input) {
        state.listed.push({ context, input })
        return { total: 0, offset: input.offset ?? 0, files: [] }
      }
      export async function uploadCabinetFile(authz, input) {
        state.uploads.push({ authz, input })
        return { id: "file-1", name: input.filename, folderId: input.folderId, folderName: null, contentType: input.contentType, sizeBytes: 4 }
      }
    `,
  ],
  [
    "mock:idempotency",
    `
      const state = globalThis[Symbol.for('openbooks.v1-files-route-test')]
      export async function executeIdempotent(args) {
        state.claims.push({ operation: args.operation, idempotencyKey: args.idempotencyKey })
        const value = await args.execute()
        return { replayed: false, value }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/files", "mock:files"],
  ["../../../../lib/application/idempotency", "mock:idempotency"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

test("POST /api/v1/files uploads with the upload_file tool fields through a file.upload claim", async () => {
  routeState.uploads.length = 0;
  routeState.claims.length = 0;
  const response = await POST(
    new Request("http://openbooks.test/api/v1/files", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "idempotency-key": "file-key-1",
      },
      body: JSON.stringify({
        folderId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        filename: "statement-jan.pdf",
        contentType: "application/pdf",
        contentBase64: "aGVsbG8=",
      }),
    }),
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { id: string; name: string };
  assert.equal(body.id, "file-1");
  assert.equal(body.name, "statement-jan.pdf");
  assert.deepEqual(routeState.claims[0], { operation: "file.upload", idempotencyKey: "file-key-1" });
  assert.deepEqual(routeState.uploads[0]?.input, {
    folderId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    filename: "statement-jan.pdf",
    contentType: "application/pdf",
    contentBase64: "aGVsbG8=",
  });
});

test("POST /api/v1/files refuses a missing Idempotency-Key", async () => {
  const response = await POST(
    new Request("http://openbooks.test/api/v1/files", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ folderId: "x", filename: "a.pdf", contentType: "application/pdf", contentBase64: "aGVsbG8=" }),
    }),
  );
  assert.equal(response.status, 400);
});
