import assert from "node:assert/strict";
import test from "node:test";
import { importWithMocks } from "@openbooks/engine/src/testing/module-mocks.ts";

const { GET } = await importWithMocks<typeof import("./route.ts")>(
  "./route.ts",
  [
    [
      "../../../../lib/api/v1-request",
      `
      export async function withV1Request(request, label, operation) {
        try {
          const result = await operation(
            { user: { orgId: "org-1" }, keyId: "key-1" },
            { authz: { user: { orgId: "org-1" } } },
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
      "../../../../lib/application/vitals",
      `
      export async function orgVitals() {
        return { cash: "100.00", approvalsPending: 2 }
      }
    `,
    ],
  ],
  import.meta.url,
);

test("GET /api/v1/vitals returns the org snapshot", async () => {
  const response = await GET(
    new Request("http://openbooks.test/api/v1/vitals", {
      headers: { authorization: "Bearer test-key" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cash: "100.00", approvalsPending: 2 });
});
