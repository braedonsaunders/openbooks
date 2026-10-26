/**
 * Saved views store one sort model: an ordered `sorts` array. The storage
 * constraint refuses the obsolete single `sort` key, a non-array `sorts`
 * value and a non-object query, so every stored plan is one the native
 * saved-view reader accepts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { validateCustomQuery } from "@openbooks/reports";

function postgresCode(error: unknown): string | undefined {
  let current = error as { code?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current.code) return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}

test(
  "saved views accept the ordered sort model and refuse every other sort representation",
  {
    skip: !process.env.OPENBOOKS_TEST_ADMIN_DB_URL,
  },
  async () => {
    const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls','on',true)");
      const orgId = randomUUID(),
        ownerId = randomUUID();
      await client.query(
        `insert into orgs (id, name, base_currency, country, settings, env_kind)
      values ($1, 'Saved view tenant', 'CAD', 'CA', '{}'::jsonb, 'production')`,
        [orgId],
      );
      await client.query(
        `insert into users (id, org_id, email, name, password_hash, is_active)
      values ($1, $2, $3, 'View owner', 'x', true)`,
        [ownerId, orgId, `owner-${ownerId.slice(0, 8)}@saved-view.test`],
      );
      const base = {
        entity: "ledger_lines",
        mode: "rows",
        columns: ["posting_date", "amount"],
        filters: null,
        limit: 50,
      };
      const ordered = [
        { column: "amount", direction: "desc" },
        { column: "posting_date", direction: "asc" },
      ];
      const insert = (slug: string, query: unknown) =>
        client.query(
          `insert into public.saved_views (id, org_id, slug, name, query, owner_id)
      values ($1, $2, $3, $3, $4::jsonb, $5) returning id`,
          [randomUUID(), orgId, slug, JSON.stringify(query), ownerId],
        );

      for (const [slug, query] of [
        ["ordered", { ...base, sorts: ordered }],
        ["unsorted", base],
      ] as const) {
        const stored = await insert(slug, query);
        assert.equal(stored.rowCount, 1);
        const row = (
          await client.query("select query from public.saved_views where id = $1", [
            stored.rows[0].id,
          ])
        ).rows[0];
        assert.deepEqual(row.query, query);
        assert.doesNotThrow(
          () => validateCustomQuery(row.query),
          `the native saved-view reader accepts the ${slug} plan`,
        );
      }

      const refused = async (operation: () => Promise<unknown>, label: string) => {
        await client.query("savepoint refused_view");
        await assert.rejects(
          operation(),
          (error: unknown) => postgresCode(error) === "23514",
          label,
        );
        await client.query("rollback to savepoint refused_view");
      };
      await refused(
        () => insert("single-sort", { ...base, sort: ordered[0] }),
        "the obsolete single sort key is refused",
      );
      await refused(
        () => insert("both-sorts", { ...base, sort: ordered[0], sorts: ordered }),
        "a single sort beside the ordered model is refused",
      );
      await refused(
        () => insert("null-sort", { ...base, sort: null }),
        "even a null single sort key is refused",
      );
      await refused(
        () => insert("scalar-sorts", { ...base, sorts: "amount" }),
        "a non-array sorts value is refused",
      );
      await refused(() => insert("array-query", [base]), "a non-object query is refused");
      const kept = (
        await client.query(
          "select id, query from public.saved_views where org_id = $1 and slug = 'ordered'",
          [orgId],
        )
      ).rows[0];
      await refused(
        () =>
          client.query("update public.saved_views set query = $1::jsonb where id = $2", [
            JSON.stringify({ ...base, sort: ordered[0] }),
            kept.id,
          ]),
        "an update cannot reintroduce the obsolete sort key",
      );
      assert.deepEqual(
        (await client.query("select query from public.saved_views where id = $1", [kept.id]))
          .rows[0].query,
        kept.query,
      );
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  },
);
