import assert from "node:assert/strict";
import test from "node:test";
import { postAgentScan } from "./run-agent-scan";

function mockFetch(handler: (url: string) => Response) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

test("a completed run resolves its finding count", async () => {
  const restore = mockFetch(() => Response.json({ status: "completed", detected: 7 }));
  try {
    assert.deepEqual(await postAgentScan("collections"), { ok: true, detected: 7 });
  } finally {
    restore();
  }
});

test("a completed run without a count resolves zero", async () => {
  const restore = mockFetch(() => Response.json({ status: "completed" }));
  try {
    assert.deepEqual(await postAgentScan("collections"), { ok: true, detected: 0 });
  } finally {
    restore();
  }
});

test("a 409 claim loss resolves already-running", async () => {
  const seen: string[] = [];
  const restore = mockFetch((url) => {
    seen.push(url);
    return Response.json({ status: "claimed_elsewhere", agentKey: "collections" }, { status: 409 });
  });
  try {
    assert.deepEqual(await postAgentScan("collections"), { ok: false, alreadyRunning: true });
    assert.ok(seen[0]!.endsWith("/api/admin/setup/agents/collections/run"));
  } finally {
    restore();
  }
});

test("other rejections resolve generic failure", async () => {
  const restore = mockFetch(() => Response.json({ status: "skipped", detected: 0 }, { status: 409 }));
  try {
    assert.deepEqual(await postAgentScan("collections"), { ok: false, alreadyRunning: false });
  } finally {
    restore();
  }
});

test("a transport failure propagates to the caller's catch", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  try {
    await assert.rejects(() => postAgentScan("collections"), /down/);
  } finally {
    globalThis.fetch = prior;
  }
});
