import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { z } from "zod";

// json.ts is server-only (it returns NextResponse objects for route handlers),
// so the runner cannot import it as-is. The marker package gates only RSC
// bundling; shimming it to an empty module lets this test exercise the parser
// directly. node's test runner isolates each file in its own process, so the
// hook cannot leak elsewhere.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const {
  DEFAULT_MAX_JSON_BODY_BYTES,
  exactMoney: exactMoneySchema,
  isoDate,
  nullableUuidId,
  parseJsonBody,
  uuidId,
} = await import("./json");

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

test("parseJsonBody returns typed data for a valid object", async () => {
  const schema = z.object({ documentId: uuidId, amount: exactMoneySchema() });
  const parsed = await parseJsonBody(
    jsonRequest({ documentId: "01890a5d-ac96-774b-bcce-b302099a8057", amount: "1250.25" }),
    schema,
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.data.amount, "1250.2500");
  }
});

test("parseJsonBody rejects malformed JSON with 400", async () => {
  const parsed = await parseJsonBody(jsonRequest("{not json"), z.object({}));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.response.status, 400);
  }
});

test("parseJsonBody rejects non-object and array payloads with 400", async () => {
  for (const bad of ["null", "[1,2]", '"text"', "42"]) {
    const parsed = await parseJsonBody(new Request("http://localhost", {
      method: "POST",
      body: bad,
      headers: { "content-type": "application/json" },
    }), z.object({}));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.response.status, 400);
      const body = (await parsed.response.json()) as { error: string };
      assert.equal(body.error, "invalid request body");
    }
  }
});

test("parseJsonBody surfaces the first issue message and all issues", async () => {
  const schema = z.object({
    decision: z.string({ error: "decision required" }).min(1, "invalid decision"),
    reason: z.string().max(3, "reason too long"),
  });
  const parsed = await parseJsonBody(jsonRequest({ reason: "way too long" }), schema);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.response.status, 400);
    const body = (await parsed.response.json()) as { error: string; issues: { path: string; message: string }[] };
    assert.equal(body.error, "decision required");
    assert.deepEqual(
      body.issues.map((i) => ({ path: i.path, message: i.message })),
      [
        { path: "decision", message: "decision required" },
        { path: "reason", message: "reason too long" },
      ],
    );
  }
});

/**
 * The stream cap is the whole point: Content-Length is sender-declared and
 * absent on chunked uploads, so only the streamed bytes can justify a 413.
 * Streamed bodies carry no Content-Length (asserted below), which is exactly
 * the shape that used to bypass the old header-only check.
 */
function streamRequest(bodyText: string, headers: Record<string, string> = {}): Request {
  const bytes = new TextEncoder().encode(bodyText);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Request("http://localhost/api/test", {
    method: "POST",
    body: stream,
    headers: { "content-type": "application/json", ...headers },
    duplex: "half",
  } as RequestInit);
}

test("parseJsonBody refuses a chunked body with no Content-Length over the limit", async () => {
  const over = JSON.stringify({ text: "x".repeat(40 * 1024) });
  const req = streamRequest(over);
  assert.equal(req.headers.get("content-length"), null, "premise: streamed bodies carry no length");
  const parsed = await parseJsonBody(req, z.object({}), { maxBodyBytes: 32 * 1024 });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.response.status, 413);
    const body = (await parsed.response.json()) as { error: string; message: string };
    assert.match(body.error, /32 KiB/);
    assert.equal(body.message, body.error, "dialogs surface `message` on non-ok responses");
  }
});

test("parseJsonBody refuses a lying Content-Length (small header, big body)", async () => {
  const over = JSON.stringify({ text: "x".repeat(40 * 1024) });
  const req = streamRequest(over, { "content-length": "10" });
  assert.equal(req.headers.get("content-length"), "10");
  const parsed = await parseJsonBody(req, z.object({}), { maxBodyBytes: 32 * 1024 });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.response.status, 413);
  }
});

test("parseJsonBody refuses an oversized declared length before reading", async () => {
  const req = streamRequest(JSON.stringify({}), { "content-length": String(64 * 1024) });
  const parsed = await parseJsonBody(req, z.object({}), { maxBodyBytes: 32 * 1024 });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.response.status, 413);
  }
});

test("parseJsonBody accepts a normal body under a per-route override", async () => {
  const req = jsonRequest({ text: "something broke" });
  const parsed = await parseJsonBody(req, z.object({ text: z.string() }), {
    maxBodyBytes: 32 * 1024,
  });
  assert.equal(parsed.ok, true);
});

test("parseJsonBody default ceiling applies without an explicit override", async () => {
  assert.equal(DEFAULT_MAX_JSON_BODY_BYTES, 1024 * 1024);
  const big = jsonRequest({ text: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES) });
  const refused = await parseJsonBody(big, z.object({ text: z.string() }));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.response.status, 413);
    const body = (await refused.response.json()) as { error: string };
    assert.match(body.error, /1 MiB/);
  }
  const small = jsonRequest({ text: "fine" });
  assert.equal((await parseJsonBody(small, z.object({ text: z.string() }))).ok, true);
});

test("exactMoney accepts decimal strings and refuses JSON numbers to preserve precision", () => {
  assert.equal(exactMoneySchema().parse("1234.5"), "1234.5000");
  assert.equal(exactMoneySchema().parse("-0"), "0.0000");
  assert.equal(exactMoneySchema().parse("10"), "10.0000");
  assert.equal(exactMoneySchema().parse("0.0001"), "0.0001");
  assert.equal(exactMoneySchema().parse("-12.34"), "-12.3400");
  assert.throws(
    () => exactMoneySchema().parse(100),
    (e: unknown) => e instanceof z.ZodError && /decimal string/.test(e.issues[0]?.message ?? ""),
  );
  assert.throws(() => exactMoneySchema().parse(100.5));
  assert.throws(() => exactMoneySchema().parse(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => exactMoneySchema().parse("1.00001"));
  assert.throws(() => exactMoneySchema().parse("1e5"));
  assert.throws(() => exactMoneySchema().parse("abc"));
  assert.throws(() => exactMoneySchema().parse(""));
  assert.throws(() => exactMoneySchema().parse(null));
  assert.throws(() => exactMoneySchema().parse(true));
  assert.throws(
    () => exactMoneySchema("a decimal string or minor-unit integer is required").parse(100.5),
    (e: unknown) => e instanceof z.ZodError && e.issues[0]?.message === "a decimal string or minor-unit integer is required",
  );
});

test("uuidId accepts only canonical uuids", () => {
  assert.equal(uuidId.parse("01890a5d-ac96-774b-bcce-b302099a8057"), "01890a5d-ac96-774b-bcce-b302099a8057");
  assert.throws(() => uuidId.parse("not-a-uuid"));
  assert.throws(() => uuidId.parse(""));
  assert.throws(() => uuidId.parse(123));
});

test("nullableUuidId allows null but rejects junk strings", () => {
  assert.equal(nullableUuidId.parse(null), null);
  assert.equal(
    nullableUuidId.parse("01890a5d-ac96-774b-bcce-b302099a8057"),
    "01890a5d-ac96-774b-bcce-b302099a8057",
  );
  assert.throws(() => nullableUuidId.parse("garbage"));
  // absent keys stay optional via .optional() at the call site
  const schema = z.object({ partyId: nullableUuidId.optional() });
  assert.deepEqual(schema.parse({}), {});
});

test("isoDate accepts only real YYYY-MM-DD calendar dates", () => {
  assert.equal(isoDate().parse("2026-02-28"), "2026-02-28");
  assert.equal(isoDate().parse("2024-02-29"), "2024-02-29");
  assert.equal(isoDate().parse("0001-01-01"), "0001-01-01");
  assert.equal(isoDate().parse("9999-12-31"), "9999-12-31");

  for (const invalid of [
    "2026-02-29",
    "0000-01-01",
    "2100-02-29",
    "2026-04-31",
    "2026-01-32",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-2-28",
    "28/02/2026",
  ]) {
    assert.throws(
      () => isoDate().parse(invalid),
      `${invalid} must be rejected`,
    );
  }

  assert.throws(
    () => isoDate("A valid effective date is required").parse("2026-02-29"),
    (e: unknown) =>
      e instanceof z.ZodError &&
      e.issues[0]?.message === "A valid effective date is required",
  );
});
