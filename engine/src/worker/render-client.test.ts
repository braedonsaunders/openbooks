import assert from "node:assert/strict";
import test from "node:test";
import { authorizeReportRun } from "./render-client.ts";

function stubFetch(status: number, body: string | null) {
  const before = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status })) as typeof fetch;
  return () => {
    globalThis.fetch = before;
  };
}

test("a revoked schedule carries the server's re-authorization remedy", async () => {
  const restore = stubFetch(
    403,
    JSON.stringify({ error: "report schedule requires reauthorization" }),
  );
  try {
    await assert.rejects(
      authorizeReportRun("org", "definition", "run"),
      /HTTP 403.*requires reauthorization/,
    );
  } finally {
    restore();
  }
});

test("an empty refusal body still names the status", async () => {
  const restore = stubFetch(403, "");
  try {
    await assert.rejects(
      authorizeReportRun("org", "definition", "run"),
      /authorization failed: HTTP 403/,
    );
  } finally {
    restore();
  }
});

test("a non-JSON error body is carried without becoming a parse error", async () => {
  const restore = stubFetch(502, "<html>proxy unavailable</html>");
  try {
    await assert.rejects(
      authorizeReportRun("org", "definition", "run"),
      /HTTP 502.*proxy unavailable/,
    );
  } finally {
    restore();
  }
});

test("an authorized run resolves", async () => {
  const restore = stubFetch(204, null);
  try {
    await authorizeReportRun("org", "definition", "run");
  } finally {
    restore();
  }
});
