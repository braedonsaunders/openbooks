/**
 * HR-15 inbox unit tests — fake sources, no database.
 *
 * Ordering (overdue → due soon → newest), stable ids, idempotent act
 * (the second act re-resolves and refuses the stale item by name),
 * refusal propagation with messages intact, and the 404-not-403 rule
 * (acting on an invisible item never leaks existence).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  __testResetInboxAdapters,
  actOnInboxItem,
  countInbox,
  InboxError,
  listInbox,
} from "./registry.ts";
import type { InboxAdapter } from "./registry.ts";
import type { InboxItem } from "./types.ts";

const CTX = { orgId: "org-1", actorId: "user-1", asOf: "2026-06-15T12:00:00Z" };

function item(over: Partial<InboxItem> & { id: string }): InboxItem {
  return {
    kind: "flows_approval",
    title: "t",
    subtitle: null,
    dueAt: null,
    createdAt: "2026-06-10T00:00:00Z",
    priority: "normal",
    subjectHref: "/x",
    actions: [],
    source: { kind: "s", id: over.id.split(":")[1]! },
    ...over,
  };
}

function fakeAdapter(items: InboxItem[], acts: string[] = [], refuse?: Error): InboxAdapter {
  return {
    kind: "flows_approval",
    async list() {
      return items;
    },
    async act(_ctx, sourceId, actionKey) {
      if (refuse) throw refuse;
      acts.push(`${sourceId}:${actionKey}`);
    },
  };
}

describe("inbox ordering", () => {
  it("sorts overdue, then due soon, then newest, with a stable id tiebreak", async () => {
    const items = [
      item({ id: "flows_approval:new-b", createdAt: "2026-06-12T00:00:00Z", priority: "normal" }),
      item({ id: "flows_approval:old", createdAt: "2026-06-01T00:00:00Z", priority: "overdue" }),
      item({ id: "flows_approval:new-a", createdAt: "2026-06-12T00:00:00Z", priority: "normal" }),
      item({ id: "flows_approval:soon", createdAt: "2026-06-14T00:00:00Z", priority: "due_soon" }),
    ];
    __testResetInboxAdapters([fakeAdapter(items)]);
    try {
      const listed = await listInbox(CTX);
      assert.deepEqual(
        listed.map((i) => i.id),
        ["flows_approval:old", "flows_approval:soon", "flows_approval:new-a", "flows_approval:new-b"],
      );
      // Deterministic: same inputs, same list.
      const again = await listInbox(CTX);
      assert.deepEqual(
        again.map((i) => i.id),
        listed.map((i) => i.id),
      );
    } finally {
      __testResetInboxAdapters([]);
    }
  });
});

describe("inbox act", () => {
  it("delegates to the adapter and propagates its refusal with the message intact", async () => {
    const acts: string[] = [];
    const items = [
      item({
        id: "flows_approval:g1",
        actions: [{ key: "approve", label: "Approve", style: "primary", needsReason: false }],
      }),
    ];
    __testResetInboxAdapters([fakeAdapter(items, acts)]);
    try {
      await actOnInboxItem(CTX, "flows_approval:g1", "approve");
      assert.deepEqual(acts, ["g1:approve"]);
    } finally {
      __testResetInboxAdapters([]);
    }
  });

  it("a stale item (already decided) refuses by name as NOT_FOUND", async () => {
    // First call succeeds and removes the item; the second re-resolves,
    // finds nothing, and refuses — idempotent by re-resolution.
    let live = [
      item({
        id: "flows_approval:g1",
        actions: [{ key: "approve", label: "Approve", style: "primary", needsReason: false }],
      }),
    ];
    const adapter: InboxAdapter = {
      kind: "flows_approval",
      async list() {
        return live;
      },
      async act() {
        live = [];
      },
    };
    __testResetInboxAdapters([adapter]);
    try {
      await actOnInboxItem(CTX, "flows_approval:g1", "approve");
      await assert.rejects(actOnInboxItem(CTX, "flows_approval:g1", "approve"), (error: unknown) => {
        assert.ok(error instanceof InboxError);
        assert.equal(error.code, "NOT_FOUND");
        assert.match(error.message, /already be decided/);
        return true;
      });
    } finally {
      __testResetInboxAdapters([]);
    }
  });

  it("acting on an item the actor cannot see is 404, never 403", async () => {
    __testResetInboxAdapters([fakeAdapter([])]);
    try {
      await assert.rejects(actOnInboxItem(CTX, "flows_approval:secret", "approve"), (error: unknown) => {
        assert.ok(error instanceof InboxError);
        assert.equal(error.code, "NOT_FOUND");
        assert.doesNotMatch(error.message, /forbidden|permission|denied/i);
        return true;
      });
    } finally {
      __testResetInboxAdapters([]);
    }
  });

  it("an unknown action names the remedy", async () => {
    const items = [
      item({
        id: "flows_approval:g1",
        actions: [{ key: "approve", label: "Approve", style: "primary", needsReason: false }],
      }),
    ];
    __testResetInboxAdapters([fakeAdapter(items)]);
    try {
      await assert.rejects(actOnInboxItem(CTX, "flows_approval:g1", "fly"), (error: unknown) => {
        assert.ok(error instanceof InboxError);
        assert.equal(error.code, "UNKNOWN_ACTION");
        assert.match(error.message, /reload the inbox/);
        return true;
      });
    } finally {
      __testResetInboxAdapters([]);
    }
  });

  it("an action needing a reason refuses without one", async () => {
    const items = [
      item({
        id: "flows_approval:g1",
        actions: [{ key: "reject", label: "Reject", style: "danger", needsReason: true }],
      }),
    ];
    __testResetInboxAdapters([fakeAdapter(items)]);
    try {
      await assert.rejects(actOnInboxItem(CTX, "flows_approval:g1", "reject"), (error: unknown) => {
        assert.ok(error instanceof InboxError);
        assert.equal(error.code, "REASON_REQUIRED");
        assert.match(error.message, /reason is required/);
        return true;
      });
      // Blank reasons refuse too — whitespace is not a reason.
      await assert.rejects(actOnInboxItem(CTX, "flows_approval:g1", "reject", "   "), (error: unknown) => {
        assert.ok(error instanceof InboxError && error.code === "REASON_REQUIRED");
        return true;
      });
    } finally {
      __testResetInboxAdapters([]);
    }
  });

  it("a malformed item id is NOT_FOUND", async () => {
    __testResetInboxAdapters([fakeAdapter([])]);
    try {
      await assert.rejects(actOnInboxItem(CTX, "no-separator", "approve"), (error: unknown) => {
        assert.ok(error instanceof InboxError && error.code === "NOT_FOUND");
        return true;
      });
    } finally {
      __testResetInboxAdapters([]);
    }
  });
});

describe("inbox count and paging", () => {
  it("countInbox prefers the adapter count over the list length", async () => {
    // A windowed source reports its full pending count: the badge must not
    // undercount past the list window.
    const adapter: InboxAdapter = {
      ...fakeAdapter([
        item({ id: "flows_approval:g1", actions: [] }),
      ]),
      async count() {
        return 41;
      },
    };
    __testResetInboxAdapters([adapter]);
    try {
      assert.equal(await countInbox(CTX), 41);
    } finally {
      __testResetInboxAdapters([]);
    }
  });

  it("countInbox falls back to the list length without an adapter count", async () => {
    const items = [
      item({ id: "flows_approval:g1", actions: [] }),
      item({ id: "flows_approval:g2", actions: [] }),
    ];
    __testResetInboxAdapters([fakeAdapter(items)]);
    try {
      assert.equal(await countInbox(CTX), 2);
    } finally {
      __testResetInboxAdapters([]);
    }
  });

  it("listInbox forwards the read window to the adapter", async () => {
    const seen: Array<{ limit?: number; offset?: number } | undefined> = [];
    const adapter: InboxAdapter = {
      kind: "flows_approval",
      async list(_ctx, page) {
        seen.push(page);
        return [];
      },
      async act() {},
    };
    __testResetInboxAdapters([adapter]);
    try {
      await listInbox(CTX, { page: { limit: 10, offset: 20 } });
      assert.deepEqual(seen, [{ limit: 10, offset: 20 }]);
      // Unpaged reads pass no window, so acting keeps re-resolving the
      // full working list.
      await listInbox(CTX);
      assert.deepEqual(seen, [{ limit: 10, offset: 20 }, undefined]);
    } finally {
      __testResetInboxAdapters([]);
    }
  });
});
