import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiResponseError,
  apiJson,
  chunkArray,
  fetchAppAction,
  readApiBulkFailures,
  readApiErrorMessage,
  readAppActionResult,
  reconcileBulkResults,
  throwApiErrorIfNotOk,
  type RefusalCopy,
} from "./api-error.ts";

// The latent client defect: every error path parsed the body BEFORE checking
// the status, so a non-JSON error body threw a SyntaxError and the operator
// saw a parse error instead of the server's message (or any status at all).
test("a JSON error body yields the server message", async () => {
  const res = new Response(JSON.stringify({ error: "No state on this AU payroll profile" }), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await readApiErrorMessage(res, "failed"), "No state on this AU payroll profile");
});

test("a non-JSON error body yields the fallback with the status, never a SyntaxError", async () => {
  const res = new Response("<html><body>Bad Gateway</body></html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });
  assert.equal(await readApiErrorMessage(res, "failed to load"), "failed to load (status 502)");
});

test("an empty error body yields the fallback with the status", async () => {
  const res = new Response(null, { status: 500 });
  assert.equal(await readApiErrorMessage(res, "failed"), "failed (status 500)");
});

test("a JSON body without an error field yields the fallback with the status", async () => {
  const res = new Response(JSON.stringify({ ok: false }), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await readApiErrorMessage(res, "failed"), "failed (status 422)");
});

test("a message-only envelope still surfaces the named refusal", async () => {
  const res = new Response(JSON.stringify({ message: "capture is not operational" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await readApiErrorMessage(res, "failed"), "capture is not operational");
});

test("a remedy is appended to the named refusal", async () => {
  const res = new Response(
    JSON.stringify({
      error: "SUI rate is not configured",
      remedy: "add a rate in Company Settings",
    }),
    { status: 422, headers: { "content-type": "application/json" } },
  );
  assert.equal(
    await readApiErrorMessage(res, "failed"),
    "SUI rate is not configured — add a rate in Company Settings",
  );
});

test("a structured details remedy is appended to the named refusal", async () => {
  const res = new Response(
    JSON.stringify({
      error: "No default warehouse is available",
      details: { remedy: "assign a warehouse to the order line" },
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
  assert.equal(
    await readApiErrorMessage(res, "failed"),
    "No default warehouse is available — assign a warehouse to the order line",
  );
});

test("clause refusals retain a dash before a capitalized remedy", async () => {
  const response = Response.json(
    { error: "The payout batch is closed", remedy: "Reopen the batch before matching it." },
    { status: 409 },
  );
  assert.equal(
    await readApiErrorMessage(response, "failed"),
    "The payout batch is closed — Reopen the batch before matching it.",
  );
});

test("complete refusal sentences and Japanese remedies keep their own punctuation", async () => {
  const english = Response.json(
    { error: "The period is closed.", remedy: "Request a controlled reopen." },
    { status: 409 },
  );
  assert.equal(
    await readApiErrorMessage(english, "failed"),
    "The period is closed. Request a controlled reopen.",
  );
  const japanese = Response.json(
    { error: "会計期間は締め済みです。", remedy: "再開を申請してください。" },
    { status: 409 },
  );
  assert.equal(
    await readApiErrorMessage(japanese, "failed"),
    "会計期間は締め済みです。再開を申請してください。",
  );
});

test("blank and non-string error fields fall through to the fallback, never an empty toast", async () => {
  for (const body of ['{"error":"   "}', '{"error":42}', '{"error":null}']) {
    const res = new Response(body, {
      status: 422,
      headers: { "content-type": "application/json" },
    });
    assert.equal(await readApiErrorMessage(res, "failed"), "failed (status 422)");
  }
});

test("a detail-only ping refusal surfaces the provider reason", async () => {
  const res = new Response(
    JSON.stringify({ ok: false, detail: "connection timed out after 10s" }),
    {
      status: 422,
      headers: { "content-type": "application/json" },
    },
  );
  assert.equal(await readApiErrorMessage(res, "failed"), "connection timed out after 10s");
});

test("an errors array surfaces the joined validation reasons", async () => {
  const res = new Response(
    JSON.stringify({ errors: ["name required (max 200 chars)", "graph: bad edge"] }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  );
  assert.equal(
    await readApiErrorMessage(res, "failed"),
    "name required (max 200 chars); graph: bad edge",
  );
});

test("apiJson returns the parsed success body without the caller touching res.json", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ id: "flow-1" })) as typeof fetch;
  try {
    assert.deepEqual(
      await apiJson<{ id: string }>("/api/admin/flows", { method: "POST" }, "failed"),
      { id: "flow-1" },
    );
  } finally {
    globalThis.fetch = prior;
  }
});

test("apiJson throws the named server refusal on error, never a SyntaxError", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      apiJson<unknown>("/api/admin/flows", { method: "POST" }, "failed to save"),
      (error) =>
        error instanceof ApiResponseError &&
        error.status === 502 &&
        error.message === "failed to save (status 502)",
    );
  } finally {
    globalThis.fetch = prior;
  }
});

test("apiJson lets a network failure propagate untouched so callers show their own fallback", async () => {
  const prior = globalThis.fetch;
  const offline = new TypeError("Failed to fetch");
  globalThis.fetch = (async () => {
    throw offline;
  }) as typeof fetch;
  try {
    await assert.rejects(
      apiJson<unknown>("/api/admin/flows", undefined, "failed"),
      (error) => error === offline,
    );
  } finally {
    globalThis.fetch = prior;
  }
});

test("a blank fallback can never produce an empty message", async () => {
  const res = new Response("<html>proxy page</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });
  assert.equal(await readApiErrorMessage(res, "   "), "request failed (status 502)");
});

test("throwApiErrorIfNotOk returns silently on success so the body parses after the ok check", async () => {
  const res = new Response(JSON.stringify({ id: "x" }), { status: 200 });
  await throwApiErrorIfNotOk(res, "failed");
  assert.equal(((await res.json()) as { id: string }).id, "x");
});

test("throwApiErrorIfNotOk throws the named server error, never Error(undefined)", async () => {
  const res = new Response(JSON.stringify({ error: "revision is stale; reopen the drawer" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(() => throwApiErrorIfNotOk(res, "failed"), /revision is stale/);
  const empty = new Response(null, { status: 500 });
  await assert.rejects(() => throwApiErrorIfNotOk(empty, "failed"), /failed \(status 500\)/);
});

test("readApiBulkFailures carries one named reason per failed item", () => {
  assert.deepEqual(
    readApiBulkFailures({
      results: [
        { id: "a", ok: true },
        { id: "b", ok: false, error: "duplicate invoice INV-9" },
        { id: "c", ok: false },
      ],
    }),
    [
      { id: "b", error: "duplicate invoice INV-9" },
      { id: "c", error: "failed" },
    ],
  );
});

test("readApiBulkFailures never throws on an unparseable body", () => {
  assert.deepEqual(readApiBulkFailures(null), []);
  assert.deepEqual(readApiBulkFailures({ results: "nope" }), []);
  assert.deepEqual(readApiBulkFailures({ results: [null, 42, { ok: true }] }), []);
});

test("chunkArray splits a 100-id selection into bounded batches", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
  const chunks = chunkArray(ids, 50);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 50));
  assert.deepEqual(chunks.flat(), ids);
  assert.deepEqual(chunkArray([], 50), []);
  assert.throws(() => chunkArray(ids, 0), /positive integer/);
});

test("reconcileBulkResults flags ids the server never answered", () => {
  assert.deepEqual(
    reconcileBulkResults(
      ["a", "b", "c"],
      [
        { id: "a", ok: true },
        { id: "b", ok: false, error: "duplicate invoice INV-9" },
      ],
      "not processed",
    ),
    [
      { id: "b", error: "duplicate invoice INV-9" },
      { id: "c", error: "not processed" },
    ],
  );
  assert.deepEqual(reconcileBulkResults(["a"], [{ id: "a", ok: true }], "not processed"), []);
  assert.deepEqual(reconcileBulkResults(["a"], undefined, "not processed"), [
    { id: "a", error: "not processed" },
  ]);
});

test("a schema refusal names the field the operator must correct", async () => {
  const body = {
    error: "must be a valid id",
    issues: [{ path: "adjustmentAccountId", message: "must be a valid id" }],
  };
  const response = new Response(JSON.stringify(body), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
  assert.equal(
    await readApiErrorMessage(response, "Save failed"),
    "Adjustment account id: must be a valid id",
  );
  const nested = {
    error: "Required",
    issues: [{ path: "lines.0.taxCodeId", message: "Required" }],
  };
  const second = new Response(JSON.stringify(nested), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await readApiErrorMessage(second, "Save failed"), "Tax code id: Required");
});

// The shared ActionResult read must render every refusal envelope the API
// produces (see web/lib/api/* response helpers): a refusal the server
// explained — under any key, with remedy and code — pins verbatim, and a
// body that names nothing still pins the fallback with its HTTP status, so
// a refusal can never render blank.
const COPY: RefusalCopy = { fallback: "Action failed" };

function refusalResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function pinnedMessage(body: unknown, status: number, copy: RefusalCopy = COPY) {
  const result = await readAppActionResult(refusalResponse(body, status), copy);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  return result.error.displayMessage(copy.fallback);
}

test("readAppActionResult renders the plain error envelope", async () => {
  assert.equal(await pinnedMessage({ error: "not_found" }, 404), "not_found");
});

test("readAppActionResult keeps the code beside the message", async () => {
  const result = await readAppActionResult(
    refusalResponse({ error: "changed after opening", code: "stale-revision" }, 409),
    COPY,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "stale-revision");
  assert.equal(result.error.displayMessage(COPY.fallback), "changed after opening");
});

test("readAppActionResult appends the remedy to the refusal", async () => {
  assert.equal(
    await pinnedMessage(
      {
        error: "AR is closed for this period",
        code: "posting_refused",
        remedy: "request a controlled reopen",
      },
      422,
    ),
    "AR is closed for this period — request a controlled reopen",
  );
});

test("readAppActionResult renders message-only and detail-only envelopes", async () => {
  assert.equal(
    await pinnedMessage({ message: "capture is not operational" }, 409),
    "capture is not operational",
  );
  assert.equal(
    await pinnedMessage({ ok: false, detail: "connection timed out" }, 422),
    "connection timed out",
  );
});

test("readAppActionResult renders a nested error body", async () => {
  assert.equal(
    await pinnedMessage({ error: { message: "filing is locked" } }, 422),
    "filing is locked",
  );
});

test("readAppActionResult joins an errors array and pins schema issues", async () => {
  assert.equal(
    await pinnedMessage({ errors: ["name required", "bad edge"] }, 400),
    "name required; bad edge",
  );
  const result = await readAppActionResult(
    refusalResponse(
      {
        error: "must be a valid id",
        issues: [{ path: "adjustmentAccountId", message: "must be a valid id" }],
      },
      400,
    ),
    COPY,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(
    result.error.displayMessage(COPY.fallback),
    "Adjustment account id: must be a valid id",
  );
  assert.deepEqual(result.error.issues, [
    { path: "adjustmentAccountId", message: "must be a valid id" },
  ]);
});

test("readAppActionResult maps a code-only body through the caller copy", async () => {
  const mapped = await pinnedMessage({ code: "number_in_use" }, 422, {
    fallback: "Action failed",
    codeMessage: (code) =>
      code === "number_in_use" ? "That number is already in use." : undefined,
  });
  assert.equal(mapped, "That number is already in use.");
});

test("readAppActionResult never renders blank: fallback carries status and code", async () => {
  assert.equal(
    await pinnedMessage({ code: "stale-revision" }, 409),
    "Action failed (HTTP 409, stale-revision)",
  );
  assert.equal(await pinnedMessage({ ok: false }, 422), "Action failed (HTTP 422)");
  assert.equal(await pinnedMessage({ error: "   " }, 422), "Action failed (HTTP 422)");
  const proxy = await readAppActionResult(
    new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
    COPY,
  );
  assert.equal(proxy.ok, false);
  if (proxy.ok) throw new Error("unreachable");
  assert.equal(proxy.error.displayMessage(COPY.fallback), "Action failed (HTTP 502)");
  const empty = await readAppActionResult(new Response(null, { status: 500 }), COPY);
  assert.equal(empty.ok, false);
  if (empty.ok) throw new Error("unreachable");
  assert.equal(empty.error.displayMessage(COPY.fallback), "Action failed (HTTP 500)");
});

test("a server failure with no named reason pins the unavailable copy, and a named reason still wins", async () => {
  const copy = { fallback: "Action failed", unavailable: "The server or connection failed." };
  const proxy = await readAppActionResult(
    new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
    copy,
  );
  assert.equal(proxy.ok, false);
  if (proxy.ok) throw new Error("unreachable");
  assert.equal(proxy.error.kind, "unexpected");
  assert.equal(proxy.error.status, 502);
  assert.equal(proxy.error.displayMessage(copy.fallback), "The server or connection failed.");
  const named = await readAppActionResult(
    refusalResponse({ error: "Revenue account is inactive" }, 500),
    copy,
  );
  assert.equal(named.ok, false);
  if (named.ok) throw new Error("unreachable");
  assert.equal(named.error.displayMessage(copy.fallback), "Revenue account is inactive");
});

test("a rejected fetch with unavailable copy carries that copy and keeps the transport detail", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    const result = await fetchAppAction(
      "/api/documents/1",
      { method: "PATCH" },
      { fallback: "Action failed", unavailable: "The server or connection failed." },
    );
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transport");
    assert.equal(result.error.displayMessage("Action failed"), "The server or connection failed.");
    assert.match(result.error.detail ?? "", /Failed to fetch/);
  } finally {
    globalThis.fetch = prior;
  }
});

test("readAppActionResult trusts the status, never the body", async () => {
  const result = await readAppActionResult<{ id: string }>(
    refusalResponse({ error: "stale" }, 200),
    COPY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal((result.data as { id: string; error?: string }).error, "stale");
});

test("fetchAppAction turns a rejected fetch into a transport refusal, never a throw", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    const result = await fetchAppAction("/api/documents/actions", { method: "POST" }, COPY);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transport");
    assert.equal(result.error.displayMessage(COPY.fallback), "Action failed");
  } finally {
    globalThis.fetch = prior;
  }
});

test("fetchAppAction renders the enriched refusal for a lived refusal body", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    refusalResponse(
      { error: "void reason is required", code: "invalid", remedy: "enter at least 5 characters" },
      422,
    )) as typeof fetch;
  try {
    const result = await fetchAppAction("/api/documents/x/void", { method: "POST" }, COPY);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(
      result.error.displayMessage(COPY.fallback),
      "void reason is required — enter at least 5 characters",
    );
  } finally {
    globalThis.fetch = prior;
  }
});
