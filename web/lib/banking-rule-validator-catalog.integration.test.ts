import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

const enabled = !!process.env.OPENBOOKS_DB_URL;

// Native deployment restores use an empty search path. The owning validator
// must resolve nested groups without depending on a caller's catalog context.
test(
  "bank-rule criteria retain validation under an empty catalog search path",
  { skip: !enabled },
  async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local search_path = ''`);
      const group = {
        combinator: "and",
        rules: [
          { field: "description", op: "contains", value: "SUPPLIES" },
          {
            combinator: "or",
            rules: [
              { field: "amount", op: "between", value: [10, 100] },
              { field: "date", op: "on", value: "2026-10-01" },
            ],
          },
        ],
      };
      const accountId = "00000000-0000-4000-8000-000000000001";
      const valid = { version: 2, match: group, accountScope: [accountId] };
      const cases: [unknown, boolean][] = [
        [valid, true],
        [{ ...valid, accountScope: [accountId, accountId] }, false],
        [{ ...valid, accountScope: ["not-an-account-id"] }, false],
        [{ ...valid, version: 1 }, false],
        [{ version: 2, match: { combinator: "and", rules: [] } }, false],
        [
          {
            version: 2,
            match: { combinator: "and", rules: [{ field: "unknown", op: "equals", value: "x" }] },
          },
          false,
        ],
        [
          {
            version: 2,
            match: { combinator: "and", rules: [{ field: "date", op: "on", value: "2026-02-30" }] },
          },
          false,
        ],
        [
          {
            version: 2,
            match: {
              combinator: "and",
              rules: [{ field: "amount", op: "between", value: [100, 10] }],
            },
          },
          false,
        ],
      ];
      let nested: unknown = group;
      for (let depth = 0; depth < 6; depth++) nested = { combinator: "and", rules: [nested] };
      cases.push([{ version: 2, match: nested }, false]);
      for (const [criteria, expected] of cases) {
        const row = (
          await tx.execute<{ admitted: boolean }>(
            sql`
        select public.openbooks_bank_rule_criteria_is_valid(${JSON.stringify(criteria)}::jsonb) as admitted
      `,
            "objects",
          )
        )[0];
        assert.equal(row?.admitted, expected, `expected admission ${expected}`);
      }
    });
  },
);
