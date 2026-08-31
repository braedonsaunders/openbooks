import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.ts";
import {
  accountGroupNamePatternError,
  resolveAccountGroups,
} from "./account-groups.ts";

test("resolveAccountGroups chooses a stable pin when legacy duplicate rows are present", async (t) => {
  const calls: unknown[] = [];
  t.mock.method(db, "execute", async (query: unknown) => {
    calls.push(query);
    if (calls.length === 1) {
      return {
        rows: [
          {
            id: "group-a",
            dimension: "cost_pool",
            key: "a",
            name: "A",
            color: null,
            sort_order: 1,
            match: {},
            is_catch_all: false,
          },
        ],
      };
    }
    if (calls.length === 2) {
      // The old resolver's final Map.set would select the second row and make
      // the result depend on physical row order. Migration 0081 prevents new
      // duplicates; this fixture proves the legacy fallback is still stable.
      return {
        rows: [
          { account_id: "account-1", group_id: "group-z", key: "z", name: "Z", color: null },
          { account_id: "account-1", group_id: "group-a", key: "a", name: "A", color: null },
        ],
      };
    }
    return { rows: [{ id: "account-1", number: "5000", name: "Supplies", type: "expense" }] };
  });

  const resolved = await resolveAccountGroups("cost_pool", "org-1");
  assert.equal(resolved.byAccount.get("account-1")?.groupId, "group-a");
  assert.deepEqual([...resolved.pinned], ["account-1"]);
});

test("resolveAccountGroups still applies rules and catch-all groups without pins", async (t) => {
  let calls = 0;
  t.mock.method(db, "execute", async () => {
    calls += 1;
    if (calls === 1) {
      return {
        rows: [
          {
            id: "group-expense",
            dimension: "cost_pool",
            key: "expense",
            name: "Expense",
            color: "#123456",
            sort_order: 1,
            match: { numberPrefixes: ["5"] },
            is_catch_all: false,
          },
          {
            id: "group-other",
            dimension: "cost_pool",
            key: "other",
            name: "Other",
            color: null,
            sort_order: 2,
            match: {},
            is_catch_all: true,
          },
        ],
      };
    }
    if (calls === 2) return { rows: [] };
    return {
      rows: [
        { id: "account-1", number: "5000", name: "Supplies", type: "expense" },
        { id: "account-2", number: "1000", name: "Cash", type: "asset" },
      ],
    };
  });

  const resolved = await resolveAccountGroups("cost_pool", "org-1");
  assert.equal(resolved.byAccount.get("account-1")?.key, "expense");
  assert.equal(resolved.byAccount.get("account-2")?.key, "other");
  assert.equal(resolved.pinned.size, 0);
});

test("legacy unsafe account-group patterns fail closed before classification", async (t) => {
  assert.match(
    accountGroupNamePatternError("(a+)+$") ?? "",
    /catastrophic backtracking/,
  );
  assert.match(
    accountGroupNamePatternError("(a|aa)+") ?? "",
    /catastrophic backtracking/,
  );
  assert.match(
    accountGroupNamePatternError("[") ?? "",
    /valid regular expression/,
  );
  // These forms are used by seeded groups and must remain executable.
  assert.equal(accountGroupNamePatternError("rent|lease"), null);
  assert.equal(accountGroupNamePatternError("stat(utory)? holiday.*admin"), null);

  let calls = 0;
  t.mock.method(db, "execute", async () => {
    calls += 1;
    if (calls === 1) {
      return {
        rows: [
          {
            id: "group-unsafe",
            dimension: "cost_pool",
            key: "unsafe",
            name: "Unsafe legacy rule",
            color: null,
            sort_order: 1,
            match: { namePattern: "(a+)+$" },
            is_catch_all: false,
          },
          {
            id: "group-catch-all",
            dimension: "cost_pool",
            key: "other",
            name: "Other",
            color: null,
            sort_order: 2,
            match: {},
            is_catch_all: true,
          },
        ],
      };
    }
    if (calls === 2) return { rows: [] };
    return {
      rows: [
        { id: "account-1", number: "5000", name: "Cash", type: "asset" },
      ],
    };
  });

  const resolved = await resolveAccountGroups("cost_pool", "org-1");
  assert.equal(resolved.byAccount.get("account-1")?.key, "other");
});

test("safe account-group name patterns continue to classify accounts", async (t) => {
  assert.equal(accountGroupNamePatternError("rent|lease"), null);

  let calls = 0;
  t.mock.method(db, "execute", async () => {
    calls += 1;
    if (calls === 1) {
      return {
        rows: [
          {
            id: "group-facilities",
            dimension: "cost_pool",
            key: "facilities",
            name: "Facilities",
            color: null,
            sort_order: 1,
            match: { namePattern: "rent|lease" },
            is_catch_all: false,
          },
          {
            id: "group-catch-all",
            dimension: "cost_pool",
            key: "other",
            name: "Other",
            color: null,
            sort_order: 2,
            match: {},
            is_catch_all: true,
          },
        ],
      };
    }
    if (calls === 2) return { rows: [] };
    return {
      rows: [
        {
          id: "account-1",
          number: "5000",
          name: "Equipment lease",
          type: "expense",
        },
      ],
    };
  });

  const resolved = await resolveAccountGroups("cost_pool", "org-1");
  assert.equal(resolved.byAccount.get("account-1")?.key, "facilities");
});
