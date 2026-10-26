import assert from "node:assert/strict";
import test from "node:test";
import {
  isSwitchingWorkspace,
  safeWorkspaceReturnTo,
  switchWorkspace,
  WORKSPACE_CHANNEL,
  WorkspaceSwitchError,
  workspaceSwitchMessageKey,
} from "./workspace-switch.ts";

const ORG = "00000000-0000-4000-8000-00000000e001";

interface Harness {
  requests: { url: string; init: RequestInit | undefined }[];
  assigned: string[];
  announced: unknown[];
}

function install(response: () => Response): Harness & { restore: () => void } {
  const harness: Harness = { requests: [], assigned: [], announced: [] };
  const prior = { fetch: globalThis.fetch, window: (globalThis as { window?: unknown }).window };
  const listener = new BroadcastChannel(WORKSPACE_CHANNEL);
  listener.onmessage = (event) => harness.announced.push(event.data);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    harness.requests.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  (globalThis as { window?: unknown }).window = {
    location: { assign: (url: string) => harness.assigned.push(url) },
  };
  return {
    ...harness,
    restore: () => {
      listener.close();
      globalThis.fetch = prior.fetch;
      (globalThis as { window?: unknown }).window = prior.window;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a refused switch keeps the tab where it is and names the refusal", async () => {
  for (const [status, error, refusal, key] of [
    [403, "workspace_unavailable", "workspace_unavailable", "switchUnavailable"],
    [400, "invalid_workspace", "invalid_workspace", "switchFailed"],
    [500, "unexpected", "failed", "switchFailed"],
  ] as const) {
    const harness = install(() => Response.json({ error }, { status }));
    try {
      const failure = await switchWorkspace(ORG).then(
        () => null,
        (caught: unknown) => caught,
      );
      assert.ok(failure instanceof WorkspaceSwitchError);
      assert.equal(failure.refusal, refusal);
      assert.equal(failure.status, status);
      assert.equal(workspaceSwitchMessageKey(failure), key);
      assert.deepEqual(harness.assigned, [], "a refused switch never navigates");
      await flush();
      assert.deepEqual(harness.announced, [], "a refused switch is not announced to other tabs");
      assert.equal(isSwitchingWorkspace(), false);
    } finally {
      harness.restore();
    }
  }
  assert.equal(workspaceSwitchMessageKey(new TypeError("Failed to fetch")), "switchFailed");
});

test("a successful switch posts to the endpoint, announces the workspace and loads a fresh document", async () => {
  const harness = install(() => Response.json({ orgId: ORG }));
  try {
    await switchWorkspace(ORG, "/reports/pnl?layoutPreview=1");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]!.url, "/api/me/workspace");
    assert.equal(harness.requests[0]!.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(harness.requests[0]!.init?.body)), { orgId: ORG });
    assert.deepEqual(harness.assigned, ["/reports/pnl?layoutPreview=1"]);
    await flush();
    assert.deepEqual(harness.announced, [{ orgId: ORG }]);
    assert.equal(isSwitchingWorkspace(), true);
  } finally {
    harness.restore();
  }
});

test("the destination after a switch stays on this origin", () => {
  assert.equal(safeWorkspaceReturnTo("/payroll/separations"), "/payroll/separations");
  for (const target of [
    "//outside.test",
    "/\\outside.test",
    "https://outside.test",
    "/\noutside",
    "",
  ]) {
    assert.equal(safeWorkspaceReturnTo(target), "/", JSON.stringify(target));
  }
});
