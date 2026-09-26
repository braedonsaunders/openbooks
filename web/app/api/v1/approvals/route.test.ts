import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../lib/api/v1-request": `
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
    "../../../../lib/application/approvals": `
      export async function listApprovalWorklist() {
        return [{ gateId: "gate-1", status: "pending" }]
      }
    `,
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

test("GET /api/v1/approvals returns the actor worklist", async () => {
  const response = await GET(
    new Request("http://openbooks.test/api/v1/approvals", {
      headers: { authorization: "Bearer test-key" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { approvals: [{ gateId: "gate-1", status: "pending" }] });
});
