import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

const resolverSource = readFileSync("web/app/api/insights/_lib.ts", "utf8");
const schemaSource = readFileSync("schema/src/insights.ts", "utf8");
const migrationSource = readFileSync(
  "schema/migrations/generated/0067_insights_home_uniqueness.sql",
  "utf8",
);
const databaseUrl = process.env.OPENBOOKS_DB_URL;

type HomeRow = {
  id: string;
  homeForRole: string | null;
  isHome: boolean;
  priority: 1 | 2 | 3;
};

/** The SQL resolver's final ordering, expressed as a small executable oracle. */
function pickHome(rows: HomeRow[]): HomeRow | null {
  return (
    [...rows].sort(
      (left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id),
    )[0] ?? null
  );
}

type PointerRow = {
  id: string;
  orgId: string;
  isHome: boolean;
  homeForRole: string | null;
  updatedAt?: string | null;
};

function participatesInSystemIndex(row: PointerRow): boolean {
  return row.isHome;
}

function participatesInRoleIndex(row: PointerRow): boolean {
  return row.homeForRole !== null;
}

function pointerKey(row: PointerRow): string {
  return `${row.orgId}:${row.homeForRole ?? ""}`;
}

/** Simulate the database's partial unique indexes for concurrent claims. */
function claimPointer(rows: PointerRow[], row: PointerRow): void {
  const systemConflict =
    participatesInSystemIndex(row) &&
    rows.some(
      (existing) =>
        participatesInSystemIndex(existing) && existing.orgId === row.orgId,
    );
  const roleConflict =
    participatesInRoleIndex(row) &&
    rows.some(
      (existing) =>
        participatesInRoleIndex(existing) &&
        pointerKey(existing) === pointerKey(row),
    );
  if (systemConflict || roleConflict) {
    throw new Error("unique home pointer violation");
  }
  rows.push(row);
}

function repairLegacyPointers(input: PointerRow[]): PointerRow[] {
  const rows = input.map((row) => ({ ...row }));
  const systemWinners = new Map<string, PointerRow>();
  const roleWinners = new Map<string, PointerRow>();
  const isNewer = (candidate: PointerRow, winner: PointerRow): boolean => {
    const candidateTime = candidate.updatedAt;
    const winnerTime = winner.updatedAt;
    if (candidateTime === winnerTime)
      return candidate.id.localeCompare(winner.id) > 0;
    if (candidateTime === null || candidateTime === undefined) return false;
    if (winnerTime === null || winnerTime === undefined) return true;
    return candidateTime.localeCompare(winnerTime) > 0;
  };
  for (const row of rows) {
    if (row.isHome) {
      const winner = systemWinners.get(row.orgId);
      if (!winner || isNewer(row, winner)) systemWinners.set(row.orgId, row);
    }
    if (row.homeForRole !== null) {
      const key = pointerKey(row);
      const winner = roleWinners.get(key);
      if (!winner || isNewer(row, winner)) roleWinners.set(key, row);
    }
  }
  for (const row of rows) {
    if (row.isHome && systemWinners.get(row.orgId)?.id !== row.id)
      row.isHome = false;
    if (
      row.homeForRole !== null &&
      roleWinners.get(pointerKey(row))?.id !== row.id
    ) {
      row.homeForRole = null;
    }
  }
  return rows;
}

test("home resolution uses a deterministic id tie-break after priority", () => {
  assert.match(resolverSource, /order by priority asc,\s*d\.id asc/i);

  const winner = pickHome([
    { id: "dashboard-z", homeForRole: null, isHome: true, priority: 3 },
    { id: "dashboard-a", homeForRole: null, isHome: true, priority: 3 },
  ]);
  assert.equal(winner?.id, "dashboard-a");
  assert.equal(winner?.priority, 3);
});

test("home pointers are partial unique indexes and reject concurrent duplicate claims", async () => {
  assert.match(
    schemaSource,
    /uniqueIndex\("insight_dashboards_org_home"\)[\s\S]{0,220}\.on\(t\.orgId\)[\s\S]{0,120}\.where\(sql`\$\{t\.isHome\}`\)/,
  );
  assert.match(
    schemaSource,
    /uniqueIndex\("insight_dashboards_org_role_home"\)[\s\S]{0,220}\.on\(t\.orgId, t\.homeForRole\)[\s\S]{0,160}\.where\(sql`\$\{t\.homeForRole\} IS NOT NULL`\)/,
  );
  assert.match(
    migrationSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS insight_dashboards_org_home[\s\S]*?ON public\.insight_dashboards USING btree \(org_id\)[\s\S]*?WHERE is_home;/i,
  );
  assert.match(
    migrationSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS insight_dashboards_org_role_home[\s\S]*?ON public\.insight_dashboards USING btree \(org_id, home_for_role\)[\s\S]*?WHERE home_for_role IS NOT NULL;/i,
  );

  const rows: PointerRow[] = [];
  claimPointer(rows, {
    id: "false-a",
    orgId: "org-1",
    isHome: false,
    homeForRole: null,
  });
  claimPointer(rows, {
    id: "false-b",
    orgId: "org-1",
    isHome: false,
    homeForRole: null,
  });
  claimPointer(rows, {
    id: "role-a",
    orgId: "org-1",
    isHome: false,
    homeForRole: "manager",
  });
  claimPointer(rows, {
    id: "role-b",
    orgId: "org-1",
    isHome: false,
    homeForRole: "viewer",
  });

  const attempts = await Promise.allSettled([
    Promise.resolve().then(() =>
      claimPointer(rows, {
        id: "home-a",
        orgId: "org-1",
        isHome: true,
        homeForRole: null,
      }),
    ),
    Promise.resolve().then(() =>
      claimPointer(rows, {
        id: "home-b",
        orgId: "org-1",
        isHome: true,
        homeForRole: null,
      }),
    ),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
});

test("false system pointers and null role pointers stay outside the unique indexes", () => {
  const rows: PointerRow[] = [];
  assert.doesNotThrow(() => {
    claimPointer(rows, {
      id: "false-a",
      orgId: "org-1",
      isHome: false,
      homeForRole: null,
    });
    claimPointer(rows, {
      id: "false-b",
      orgId: "org-1",
      isHome: false,
      homeForRole: null,
    });
    claimPointer(rows, {
      id: "null-role-a",
      orgId: "org-1",
      isHome: false,
      homeForRole: null,
    });
    claimPointer(rows, {
      id: "null-role-b",
      orgId: "org-1",
      isHome: false,
      homeForRole: null,
    });
  });
  assert.equal(rows.length, 4);
});

test(
  "live PostgreSQL partial indexes reject concurrent duplicate pointers",
  { skip: !databaseUrl },
  async () => {
    const clientA = new pg.Client({ connectionString: databaseUrl });
    const clientB = new pg.Client({ connectionString: databaseUrl });
    await clientA.connect();
    await clientB.connect();
    const ids: string[] = [];
    try {
      const org = (
        await clientA.query<{ id: string }>(
          "select id from orgs order by id limit 1",
        )
      ).rows[0];
      assert.ok(
        org,
        "the bootstrapped test database must contain an organization",
      );
      const insert = async (
        client: pg.Client,
        id: string,
        isHome: boolean,
        homeForRole: string | null,
      ) =>
        client.query(
          `insert into insight_dashboards
           (id, org_id, name, status, is_home, home_for_role)
         values ($1, $2, $3, 'published', $4, $5)`,
          [id, org.id, `home-pointer-${id}`, isHome, homeForRole],
        );

      const falseA = randomUUID();
      const falseB = randomUUID();
      const nullRoleA = randomUUID();
      const nullRoleB = randomUUID();
      const role = randomUUID();
      const roleDuplicate = randomUUID();
      const systemA = randomUUID();
      const systemB = randomUUID();
      ids.push(
        falseA,
        falseB,
        nullRoleA,
        nullRoleB,
        role,
        roleDuplicate,
        systemA,
        systemB,
      );

      await insert(clientA, falseA, false, null);
      await insert(clientA, falseB, false, null);
      await insert(clientA, nullRoleA, false, null);
      await insert(clientA, nullRoleB, false, null);
      await insert(clientA, role, false, "manager");
      await assert.rejects(
        insert(clientA, roleDuplicate, false, "manager"),
        (error: unknown) => (error as { code?: string }).code === "23505",
      );

      await clientA.query("begin");
      await clientB.query("begin");
      await insert(clientA, systemA, true, null);
      const blocked = insert(clientB, systemB, true, null).catch(
        (error: unknown) => error,
      );
      await clientA.query("commit");
      const duplicateError = await blocked;
      assert.equal((duplicateError as { code?: string }).code, "23505");
      await clientB.query("rollback");
    } finally {
      await clientA
        .query("delete from insight_dashboards where id = any($1::uuid[])", [
          ids,
        ])
        .catch(() => {});
      await clientA.end();
      await clientB.end();
    }
  },
);

test(
  "live PostgreSQL migration repairs duplicates and replays without changing the result",
  { skip: !databaseUrl },
  async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const idPrefix = randomUUID().slice(0, 24);
    const ids = Array.from(
      { length: 5 },
      (_, index) => `${idPrefix}${String(index + 1).padStart(12, "0")}`,
    );
    let transactionOpen = false;
    try {
      const org = (
        await client.query<{ id: string }>(
          "select id from orgs order by id limit 1",
        )
      ).rows[0];
      assert.ok(
        org,
        "the bootstrapped test database must contain an organization",
      );
      await client.query("begin");
      transactionOpen = true;
      await client.query("drop index public.insight_dashboards_org_home");
      await client.query("drop index public.insight_dashboards_org_role_home");
      await client.query(
        `insert into insight_dashboards
           (id, org_id, name, status, is_home, home_for_role, updated_at)
         values
           ($1, $6, 'legacy-system-old', 'draft', true, null, '2026-08-01T00:00:00Z'),
           ($2, $6, 'legacy-system-new', 'draft', true, null, '2026-08-02T00:00:00Z'),
           ($3, $6, 'legacy-role-old', 'draft', false, 'manager', '2026-08-03T00:00:00Z'),
           ($4, $6, 'legacy-role-new', 'draft', false, 'manager', '2026-08-03T00:00:00Z'),
           ($5, $6, 'legacy-ordinary', 'draft', false, null, '2026-08-01T00:00:00Z')`,
        [...ids, org.id],
      );

      await client.query(migrationSource);
      const once = await client.query<{
        id: string;
        is_home: boolean;
        home_for_role: string | null;
      }>(
        "select id, is_home, home_for_role from insight_dashboards where id = any($1::uuid[]) order by id",
        [ids],
      );
      assert.deepEqual(
        once.rows.map(({ id, is_home, home_for_role }) => ({
          id,
          is_home,
          home_for_role,
        })),
        [
          { id: ids[0], is_home: false, home_for_role: null },
          { id: ids[1], is_home: true, home_for_role: null },
          { id: ids[2], is_home: false, home_for_role: null },
          { id: ids[3], is_home: false, home_for_role: "manager" },
          { id: ids[4], is_home: false, home_for_role: null },
        ],
      );

      await client.query(migrationSource);
      const twice = await client.query<{
        id: string;
        is_home: boolean;
        home_for_role: string | null;
      }>(
        "select id, is_home, home_for_role from insight_dashboards where id = any($1::uuid[]) order by id",
        [ids],
      );
      assert.deepEqual(twice.rows, once.rows);
    } finally {
      if (transactionOpen) await client.query("rollback").catch(() => {});
      await client.end();
    }
  },
);

test("legacy duplicate repair keeps the deterministic highest id and preserves unclaimed rows", () => {
  assert.match(
    migrationSource,
    /row_number\(\) OVER \([\s\S]*?PARTITION BY org_id[\s\S]*?ORDER BY updated_at DESC NULLS LAST, id DESC/i,
  );
  assert.match(
    migrationSource,
    /PARTITION BY org_id, home_for_role[\s\S]*?ORDER BY updated_at DESC NULLS LAST, id DESC/i,
  );

  const repaired = repairLegacyPointers([
    {
      id: "system-a",
      orgId: "org-1",
      isHome: true,
      homeForRole: null,
      updatedAt: "2026-08-01T00:00:00Z",
    },
    {
      id: "system-z",
      orgId: "org-1",
      isHome: true,
      homeForRole: null,
      updatedAt: "2026-08-02T00:00:00Z",
    },
    {
      id: "role-a",
      orgId: "org-1",
      isHome: false,
      homeForRole: "manager",
      updatedAt: "2026-08-03T00:00:00Z",
    },
    {
      id: "role-z",
      orgId: "org-1",
      isHome: false,
      homeForRole: "manager",
      updatedAt: "2026-08-03T00:00:00Z",
    },
    {
      id: "ordinary",
      orgId: "org-1",
      isHome: false,
      homeForRole: null,
      updatedAt: null,
    },
  ]);
  assert.deepEqual(
    repaired.map(({ id, isHome, homeForRole }) => ({
      id,
      isHome,
      homeForRole,
    })),
    [
      { id: "system-a", isHome: false, homeForRole: null },
      { id: "system-z", isHome: true, homeForRole: null },
      { id: "role-a", isHome: false, homeForRole: null },
      { id: "role-z", isHome: false, homeForRole: "manager" },
      { id: "ordinary", isHome: false, homeForRole: null },
    ],
  );
});

test("migration replay is idempotent after duplicate repair", () => {
  assert.match(
    migrationSource,
    /DROP INDEX IF EXISTS public\.insight_dashboards_org_home;/i,
  );
  assert.match(
    migrationSource,
    /DROP INDEX IF EXISTS public\.insight_dashboards_org_role_home;/i,
  );
  assert.match(
    migrationSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS insight_dashboards_org_home/i,
  );
  assert.match(
    migrationSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS insight_dashboards_org_role_home/i,
  );

  const legacy = [
    {
      id: "system-a",
      orgId: "org-1",
      isHome: true,
      homeForRole: null,
      updatedAt: "2026-08-01T00:00:00Z",
    },
    {
      id: "system-z",
      orgId: "org-1",
      isHome: true,
      homeForRole: null,
      updatedAt: "2026-08-02T00:00:00Z",
    },
    {
      id: "role-a",
      orgId: "org-1",
      isHome: false,
      homeForRole: "manager",
      updatedAt: "2026-08-03T00:00:00Z",
    },
    {
      id: "role-z",
      orgId: "org-1",
      isHome: false,
      homeForRole: "manager",
      updatedAt: "2026-08-03T00:00:00Z",
    },
  ];
  const once = repairLegacyPointers(legacy);
  assert.deepEqual(repairLegacyPointers(once), once);
});
