import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../platform/db.ts";
import {
  accountGroupNamePatternError,
  resolveAccountGroups,
  resolveAccountGroupDimensions,
} from "./account-groups.ts";
import { PgDialect } from "drizzle-orm/pg-core";

test("multiple classifications share one fresh account population while retaining each dimension's pins and rules", async (t) => {
  const dialect = new PgDialect();
  let accountReads = 0;
  const orgIds: string[] = [];
  t.mock.method(db, "execute", async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const compiled = dialect.sqlToQuery(query);
    if (compiled.sql.includes("from accounts ")) {
      accountReads++;
      orgIds.push(String(compiled.params[0]));
      return { rows: [
        { id: "rent", number: "5100", name: "Rent", type: "expense" },
        { id: "cash", number: "1000", name: "Cash", type: "asset" },
      ] };
    }
    const dimension = compiled.params[0];
    if (compiled.sql.includes("from account_group_members ")) return { rows: dimension === "cost_pool" ? [
      { account_id: "rent", group_id: "labor", key: "direct_labor", name: "Labor", color: "#123456" },
    ] : [] };
    return { rows: [
      { id: `${dimension}-expense`, dimension, key: "expense", name: "Expense", color: null,
        sort_order: 1, match: { accountTypes: ["expense"] }, is_catch_all: false },
      { id: `${dimension}-other`, dimension, key: "other", name: "Other", color: null,
        sort_order: 2, match: {}, is_catch_all: true },
    ] };
  });
  const first = await resolveAccountGroupDimensions(["burden", "cost_pool", "burden"], "org-1");
  assert.equal(first.size, 2);
  assert.equal(accountReads, 1);
  assert.equal(first.get("burden")!.byAccount.get("rent")!.key, "expense");
  assert.equal(first.get("cost_pool")!.byAccount.get("rent")!.key, "direct_labor");
  assert.deepEqual([...first.get("burden")!.pinned], []);
  assert.deepEqual([...first.get("cost_pool")!.pinned], ["rent"]);
  assert.equal(first.get("burden")!.byAccount.get("cash")!.groupId, "burden-other");
  assert.equal(first.get("cost_pool")!.byAccount.get("cash")!.groupId, "cost_pool-other");
  await resolveAccountGroupDimensions(["burden", "cost_pool"], "org-2");
  assert.equal(accountReads, 2, "a later read must not retain a previous account population");
  assert.deepEqual(orgIds, ["org-1", "org-2"]);
});

test("an empty classification selection performs no account read", async (t) => {
  t.mock.method(db, "execute", async () => { throw new Error("unexpected database read"); });
  assert.deepEqual(await resolveAccountGroupDimensions([], "org-1"), new Map());
});

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

test("resolveAccountGroups refuses two active catch-alls instead of silently picking one", async (t) => {
  let calls = 0;
  t.mock.method(db, "execute", async () => {
    calls += 1;
    if (calls === 1) {
      // The U3 shape: the backfill-inserted `other` at sort_order 90 beside
      // the tenant's own catch-all at 100. Resolution must not guess.
      return {
        rows: [
          {
            id: "group-other",
            dimension: "cost_pool",
            key: "other",
            name: "Other",
            color: "#94a3b8",
            sort_order: 90,
            match: {},
            is_catch_all: true,
          },
          {
            id: "group-misc",
            dimension: "cost_pool",
            key: "misc",
            name: "Miscellaneous",
            color: null,
            sort_order: 100,
            match: {},
            is_catch_all: true,
          },
        ],
      };
    }
    if (calls === 2) return { rows: [] };
    return {
      rows: [
        { id: "account-1", number: "9999", name: "Zebra reserve", type: "expense" },
      ],
    };
  });

  await assert.rejects(
    resolveAccountGroups("cost_pool", "org-1"),
    (error: unknown) => {
      const message = (error as Error).message;
      // The refusal names both claimants and the remedy: it must read as a
      // decision aid, not as a cue the operator already knows which group won.
      assert.match(message, /multiple active catch-all/);
      assert.match(message, /"other"/);
      assert.match(message, /"misc"/);
      assert.match(message, /deactivate all but the authoritative group/);
      return true;
    },
    "two catch-alls must fail closed, never resolve into the first by sort order",
  );
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
