import assert from "node:assert/strict";
import test from "node:test";

const { jsonObject, parseJsonBody } = await import("./json");
const { readV1JsonObject } = await import("./v1-request");

function rawRequest(body: string): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

test("the shared object parser rejects non-object JSON payloads", async () => {
  for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
    const parsed = await parseJsonBody(rawRequest(body), jsonObject);
    assert.equal(parsed.ok, false, `boundary accepted non-object payload: ${body}`);
    if (!parsed.ok) {
      assert.equal(parsed.response.status, 400);
      const payload = (await parsed.response.json()) as { error: string };
      assert.equal(payload.error, "invalid request body");
    }
  }

  await assert.rejects(readV1JsonObject(rawRequest("[1,2]")), {
    code: "invalid_input",
    status: 400,
  });

  const accepted = await parseJsonBody(
    rawRequest(JSON.stringify({ anything: [1, "x"] })),
    jsonObject,
  );
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.data, { anything: [1, "x"] });
});
