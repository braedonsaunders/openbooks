import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  assertPeriodModulesOpen,
  CloseError,
  PeriodClosedError,
  type CloseModule,
} from "../periods/period-policy.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { readExactPeriodLocks, type ExactPeriodLockRead } from "./period-lock-read.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  await grantScratchPermissions(org.orgId, actors.adminId, ["close.read"]);
  return { org, actors, actorId: actors.adminId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function read(f: Fixture, overrides: Partial<Parameters<typeof readExactPeriodLocks>[0]> = {}) {
  return readExactPeriodLocks({
    orgId: f.org.orgId,
    actorId: f.actorId,
    periodId: f.org.periodId,
    bookId: f.org.bookId,
    subsidiaryId: f.org.subsidiaryId,
    ...overrides,
  });
}

function moduleState(result: ExactPeriodLockRead, module: CloseModule) {
  const state = result.modules.find((entry) => entry.module === module);
  assert.ok(state, `expected a ${module} entry`);
  return state;
}

async function insertLock(
  org: ScratchOrg,
  actorId: string,
  args: {
    periodId?: string;
    bookId?: string;
    subsidiaryId?: string | null;
    module: CloseModule;
    state: "open" | "soft_closed" | "closed";
    reason?: string;
    reopenExpiresAt?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into period_locks
      (id, org_id, period_id, book_id, subsidiary_id, module, state, reason,
       reopen_expires_at, created_by, updated_by)
    values (${id}, ${org.orgId}, ${args.periodId ?? org.periodId}, ${args.bookId ?? org.bookId},
            ${args.subsidiaryId === undefined ? org.subsidiaryId : args.subsidiaryId}, ${args.module},
            ${args.state}, ${args.reason ?? "period-lock read fixture"},
            ${args.reopenExpiresAt ? sql`${args.reopenExpiresAt}::timestamptz` : sql`null`},
            ${actorId}, ${actorId})`);
  return id;
}

async function insertEntity(org: ScratchOrg, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${name}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function insertBook(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${id}, ${org.orgId}, 'SEC', 'Secondary', false, true, true)`);
  return id;
}

async function insertPeriod(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${id}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
      from accounting_periods where id = ${org.periodId}`);
  return id;
}

/** A close.read actor whose live role restriction is exactly the given list. */
async function scopedReader(orgId: string, subsidiaryIds: string[]): Promise<string> {
  const roleKey = `period_lock_reader_${randomUUID().slice(0, 8)}`;
  const userId = await createScratchUser(orgId, "Scoped Reader", roleKey);
  await db.execute(sql`
    update app_roles
       set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
  await grantScratchPermissions(orgId, userId, ["close.read"]);
  return userId;
}

test(
  "an entity-specific close governs its entity while an unlocked module derives open with no provenance",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const lockId = await insertLock(f.org, f.actorId, { module: "gl", state: "closed" });
      await insertLock(f.org, f.actorId, { module: "tax", state: "soft_closed" });

      const result = await read(f);
      assert.deepEqual(
        result.modules.map((entry) => entry.module),
        ["ar", "ap", "banking", "assets", "tax", "gl"],
      );
      const gl = moduleState(result, "gl");
      assert.equal(gl.state, "closed");
      assert.equal(gl.blocksPosting, true);
      assert.equal(gl.provenance, "entity_lock");
      assert.equal(gl.lock?.id, lockId);
      assert.equal(gl.lock?.scope, "entity");
      assert.equal(gl.lock?.subsidiaryId, f.org.subsidiaryId);
      assert.equal(gl.lock?.version, 1);

      const tax = moduleState(result, "tax");
      assert.equal(tax.state, "soft_closed");
      assert.equal(tax.blocksPosting, true);

      // No organization-wide or entity row governs AR: open is derived, and
      // the response says so instead of inventing a stored record.
      const ar = moduleState(result, "ar");
      assert.equal(ar.state, "open");
      assert.equal(ar.blocksPosting, false);
      assert.equal(ar.lock, null);
      assert.equal(ar.provenance, "no_lock_record");
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "an organization-wide lock is the fallback provenance for an entity with no row of its own",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const lockId = await insertLock(f.org, f.actorId, {
        subsidiaryId: null,
        module: "ap",
        state: "closed",
      });

      const ap = moduleState(await read(f), "ap");
      assert.equal(ap.state, "closed");
      assert.equal(ap.blocksPosting, true);
      assert.equal(ap.provenance, "organization_lock");
      assert.equal(ap.lock?.id, lockId);
      assert.equal(ap.lock?.scope, "organization");
      assert.equal(ap.lock?.subsidiaryId, null);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "an entity row with an active approved reopen window takes precedence over an organization-wide close",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await insertLock(f.org, f.actorId, { subsidiaryId: null, module: "gl", state: "closed" });
      const lockId = await insertLock(f.org, f.actorId, {
        module: "gl",
        state: "open",
        reopenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      const gl = moduleState(await read(f), "gl");
      assert.equal(gl.state, "open");
      assert.equal(gl.blocksPosting, false);
      assert.equal(gl.provenance, "entity_lock");
      assert.equal(gl.lock?.id, lockId);
      assert.ok(gl.lock?.reopenExpiresAt);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "an expired reopen window blocks posting even though its stored state is open",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await insertLock(f.org, f.actorId, {
        module: "gl",
        state: "open",
        reopenExpiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });

      const gl = moduleState(await read(f), "gl");
      assert.equal(gl.state, "open");
      assert.equal(gl.blocksPosting, true);
      assert.equal(gl.provenance, "entity_lock");
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "locks for another entity, book or period never enter the requested scope",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const otherEntity = await insertEntity(f.org, "Other Entity");
      const otherBook = await insertBook(f.org);
      const otherPeriod = await insertPeriod(f.org);
      await insertLock(f.org, f.actorId, {
        subsidiaryId: otherEntity,
        module: "gl",
        state: "closed",
      });
      await insertLock(f.org, f.actorId, { bookId: otherBook, module: "ar", state: "closed" });
      await insertLock(f.org, f.actorId, {
        periodId: otherPeriod,
        module: "banking",
        state: "closed",
      });

      const result = await read(f);
      for (const module of ["gl", "ar", "banking"] as const) {
        const state = moduleState(result, module);
        assert.equal(state.state, "open", module);
        assert.equal(state.blocksPosting, false, module);
        assert.equal(state.lock, null, module);
        assert.equal(state.provenance, "no_lock_record", module);
      }
      // The other entity's own exact read does see its governing row.
      const other = await read(f, { subsidiaryId: otherEntity });
      assert.equal(moduleState(other, "gl").state, "closed");
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "empty and foreign actor scopes are refused, and a scoped reader may read only its own entity",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const emptyScope = await scopedReader(f.org.orgId, []);
      await assert.rejects(read(f, { actorId: emptyScope }), ScopeNotFoundError);

      const otherEntity = await insertEntity(f.org, "Foreign Scope Entity");
      const foreignScope = await scopedReader(f.org.orgId, [otherEntity]);
      await assert.rejects(read(f, { actorId: foreignScope }), ScopeNotFoundError);

      const ownScope = await scopedReader(f.org.orgId, [f.org.subsidiaryId]);
      const result = await read(f, { actorId: ownScope });
      assert.equal(result.subsidiaryId, f.org.subsidiaryId);

      // Holding no close.read at all is the same uniform refusal.
      await assert.rejects(read(f, { actorId: f.actors.outsiderId }), ScopeNotFoundError);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "identities from another tenant are refused as subjects and as actors",
  { skip: !DB },
  async () => {
    const f = await fixture();
    const other = await fixture();
    try {
      await assert.rejects(
        read(f, {
          periodId: other.org.periodId,
          bookId: other.org.bookId,
          subsidiaryId: other.org.subsidiaryId,
        }),
        (error: unknown) => error instanceof CloseError && /period not found/.test(error.message),
      );
      await assert.rejects(read(f, { actorId: other.actorId }), ScopeNotFoundError);
    } finally {
      await dropScratchOrg(f.org.orgId);
      await dropScratchOrg(other.org.orgId);
    }
  },
);

test(
  "the exact read writes nothing: lock rows, versions and audit rows are untouched",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await insertLock(f.org, f.actorId, { module: "gl", state: "closed" });
      const counts = async () =>
        (
          await db.execute<{ locks: string; audits: string; events: string }>(
            sql`
      select
        (select count(*)::text from period_locks where org_id = ${f.org.orgId}) as locks,
        (select count(*)::text from audit_log where org_id = ${f.org.orgId} and table_name = 'period_locks') as audits,
        (select count(*)::text from close_events where org_id = ${f.org.orgId}) as events`,
            "objects",
          )
        )[0]!;
      const before = await counts();
      await read(f);
      await read(f);
      assert.deepEqual(await counts(), before);
      const version = (
        await db.execute<{ version: number }>(
          sql`
      select version from period_locks where org_id = ${f.org.orgId} and module = 'gl'`,
          "objects",
        )
      )[0]!.version;
      assert.equal(version, 1);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "non-canonical identities are refused and uppercase UUIDs canonicalize",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        read(f, { periodId: "not-a-uuid" }),
        (error: unknown) =>
          error instanceof CloseError && /periodId must be a valid UUID/.test(error.message),
      );
      const result = await read(f, {
        periodId: f.org.periodId.toUpperCase(),
        bookId: f.org.bookId.toUpperCase(),
        subsidiaryId: f.org.subsidiaryId.toUpperCase(),
      });
      assert.equal(result.periodId, f.org.periodId);
      assert.equal(result.subsidiaryId, f.org.subsidiaryId);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "the posting guard and the exact read resolve the same entity close",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await insertLock(f.org, f.actorId, { module: "gl", state: "closed" });

      // The exact read reports current eligibility with no imported exemption.
      const result = await read(f);
      assert.equal(moduleState(result, "gl").blocksPosting, true);

      await assert.rejects(
        assertPeriodModulesOpen(db, {
          orgId: f.org.orgId,
          periodId: f.org.periodId,
          bookId: f.org.bookId,
          subsidiaryIds: [f.org.subsidiaryId],
          modules: ["gl"],
        }),
        (error: unknown) =>
          error instanceof PeriodClosedError &&
          error.details.module === "gl" &&
          /request a controlled reopen/.test(error.message),
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "an imported lock blocks the exact read and the default guard, but not explicit historical replay",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await insertLock(f.org, f.actorId, {
        module: "ar",
        state: "closed",
        reason: "close.importedPeriodLockReason",
      });

      // Public current eligibility carries no imported-lock exemption.
      assert.equal(moduleState(await read(f), "ar").blocksPosting, true);

      // Historical replay keeps its explicit opt-in across the imported lock;
      // without it the same resolver refuses.
      await assertPeriodModulesOpen(db, {
        orgId: f.org.orgId,
        periodId: f.org.periodId,
        bookId: f.org.bookId,
        subsidiaryIds: [f.org.subsidiaryId],
        modules: ["ar"],
        allowImportedLocks: true,
      });
      await assert.rejects(
        assertPeriodModulesOpen(db, {
          orgId: f.org.orgId,
          periodId: f.org.periodId,
          bookId: f.org.bookId,
          subsidiaryIds: [f.org.subsidiaryId],
          modules: ["ar"],
        }),
        PeriodClosedError,
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);
