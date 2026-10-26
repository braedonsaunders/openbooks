import assert from "node:assert/strict";
import test from "node:test";
import { readSampleCompanyResponse } from "./sample-company-response";

const orgId = "8266d59c-2c23-4e6d-834e-54f463319196";
const requestId = "9cfa2170-6d06-4a49-8d8e-d73c33a4a9a9";

test("a stage refusal retains the authored remedy and safe support reference", async () => {
  const result = await readSampleCompanyResponse(
    Response.json(
      {
        error: "sample-company-clone-failed",
        stage: "clone",
        message: "Copying requires a compatible schema.",
        remedy: "Complete the native upgrade before provisioning.",
      },
      { status: 500, headers: { "x-request-id": requestId } },
    ),
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a refusal");
  assert.equal(result.refusal.code, "sample-company-clone-failed");
  assert.equal(
    result.refusal.message,
    "Copying requires a compatible schema. Complete the native upgrade before provisioning.",
  );
  assert.equal(result.refusal.requestId, requestId);
  assert.equal(result.refusal.status, 500);
});

test("code-only and unreadable responses leave the company outcome unknown", async () => {
  for (const response of [
    Response.json({ error: "sample-company-clone-failed", stage: "clone" }, { status: 500 }),
    new Response("<html>unavailable</html>", { status: 502 }),
    Response.json({ orgId, created: "yes" }),
    Response.json({ orgId: "not-a-workspace", created: true }),
  ]) {
    const result = await readSampleCompanyResponse(response);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected a refusal");
    assert.equal(result.refusal.message, undefined);
    assert.equal("orgId" in result, false);
  }
});

test("a successful response establishes the exact company identity", async () => {
  assert.deepEqual(await readSampleCompanyResponse(Response.json({ orgId, created: false })), {
    ok: true,
    orgId,
    created: false,
  });
});

test("non-UUID request references are not rendered as support identities", async () => {
  const result = await readSampleCompanyResponse(
    Response.json(
      { error: "sample-company-clone-failed", requestId: "internal SQL detail" },
      { status: 500 },
    ),
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a refusal");
  assert.equal(result.refusal.requestId, undefined);
});

test("a validation refusal preserves its specific supported remedy", async () => {
  const result = await readSampleCompanyResponse(
    Response.json(
      {
        error: "A previous company setup remains incomplete.",
        remedy: "Contact support with its provisioning reference.",
      },
      { status: 409 },
    ),
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a refusal");
  assert.equal(
    result.refusal.message,
    "A previous company setup remains incomplete. Contact support with its provisioning reference.",
  );
  assert.equal(result.refusal.code, undefined);
});
