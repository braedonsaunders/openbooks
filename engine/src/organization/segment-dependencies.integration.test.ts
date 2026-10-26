import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { errorChainMatches } from "../testing/error-chain.ts";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import { installEngineSeams } from "../composition/install.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedDraftDocument,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  assertDocumentSegmentDependencies,
  loadSegmentDependencyRules,
  openDocumentSegmentViolations,
  SegmentDependencyError,
} from "./segment-dependencies.ts";

// Segment value dependencies: class X is allowed only with department A.
// The rule is enforced at the posting boundary for every source and on
// document saves, reversals of earlier postings stay possible, and the
// open-document report lists drafts that break a newly added rule.

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Scenario {
  org: ScratchOrg;
  classX: string;
  departmentA: string;
  departmentB: string;
}

async function setFeature(orgId: string, enabled: boolean): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ segmentDependencies: enabled })}::jsonb)
     where id = ${orgId}`),
  );
}

async function builtinSegment(orgId: string, key: string, storage: string): Promise<string> {
  const existing = (
    await db.execute<{ id: string }>(
      sql`
    select id from segment_definitions where org_id = ${orgId} and key = ${key}`,
      "objects",
    )
  )[0];
  if (existing) return existing.id;
  const id = randomUUID();
  await db.execute(sql`
    insert into segment_definitions (id, org_id, key, name, plural_name, source_kind, storage_column)
    values (${id}, ${orgId}, ${key}, ${key[0]!.toUpperCase() + key.slice(1)}, ${`${key}s`}, 'builtin', ${storage})`);
  return id;
}

async function scenario(): Promise<Scenario> {
  installEngineSeams();
  const org = await createScratchOrg();
  await setFeature(org.orgId, true);
  return withBypassContext(async () => {
    const classSegment = await builtinSegment(org.orgId, "class", "class_id");
    const departmentSegment = await builtinSegment(org.orgId, "department", "department_id");
    const classX = randomUUID();
    const departmentA = randomUUID();
    const departmentB = randomUUID();
    await db.execute(
      sql`insert into classes (id, org_id, name) values (${classX}, ${org.orgId}, 'Field')`,
    );
    await db.execute(
      sql`insert into departments (id, org_id, name) values (${departmentA}, ${org.orgId}, 'Operations'), (${departmentB}, ${org.orgId}, 'Sales')`,
    );
    await db.execute(sql`
      insert into segment_value_dependencies (org_id, segment_id, value_id, controlling_segment_id, allowed_value_id)
      values (${org.orgId}, ${classSegment}, ${classX}, ${departmentSegment}, ${departmentA})`);
    return { org, classX, departmentA, departmentB };
  });
}

function post(
  org: ScratchOrg,
  departmentId: string,
  classId: string,
  extra: { reversesEntryId?: string; amount?: string } = {},
) {
  const amount = extra.amount ?? "10.0000";
  const negated = amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
  return withOrgContext(org.orgId, () =>
    postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: `SD-${randomUUID().slice(0, 8)}`,
      postingDate: org.date,
      periodId: org.periodId,
      origin: "manual",
      currency: "CAD",
      reversesEntryId: extra.reversesEntryId ?? null,
      lines: [
        { accountId: org.accounts.cogs, amount, departmentId, classId },
        { accountId: org.accounts.bank, amount: negated },
      ],
    }),
  );
}

test(
  "the posting boundary refuses a line that breaks a dependency and admits allowed combinations",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      await post(s.org, s.departmentA, s.classX);
      await assert.rejects(
        post(s.org, s.departmentB, s.classX),
        /Journal line 1: Class "Field" is allowed only with Department Operations/,
      );
      await setFeature(s.org.orgId, false);
      await post(s.org, s.departmentB, s.classX);
      assert.deepEqual(
        await withBypassContext(() => loadSegmentDependencyRules(db, s.org.orgId)),
        [],
        "rules are kept but not enforced while the feature is off",
      );
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "posted history is unaffected: a posting from before the rule can still be reversed",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      await setFeature(s.org.orgId, false);
      const earlier = await post(s.org, s.departmentB, s.classX);
      await setFeature(s.org.orgId, true);
      await post(s.org, s.departmentB, s.classX, {
        reversesEntryId: earlier.entryId,
        amount: "-10.0000",
      });
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "a document save refuses lines that break a dependency, with header defaults inherited",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const actors = await seedFlowActors(s.org.orgId);
      const documentId = await withBypassContext(() =>
        seedDraftDocument(s.org.orgId, { kind: "journal", createdBy: actors.adminId }),
      );
      await withBypassContext(async () => {
        await db.execute(
          sql`update documents set class_id = ${s.classX}, department_id = ${s.departmentB} where org_id = ${s.org.orgId} and id = ${documentId}`,
        );
        await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
        values (${s.org.orgId}, ${documentId}, 1, ${s.org.accounts.cogs}, 'Inherited', '1', '10', '10')`);
      });
      await assert.rejects(
        withBypassContext(() => assertDocumentSegmentDependencies(db, s.org.orgId, documentId)),
        (error: unknown) =>
          error instanceof SegmentDependencyError &&
          /^Line 1:/.test(error.message) &&
          error.status === 422,
      );
      const report = await withBypassContext(() =>
        openDocumentSegmentViolations(db, s.org.orgId, { limit: 50, offset: 0 }),
      );
      assert.equal(report.total, 1);
      assert.equal(report.rows[0]!.documentId, documentId);
      assert.equal(report.rows[0]!.lineNumber, 1);
      // A restricted reader sees only documents of the subsidiaries they may read.
      const scoped = await withBypassContext(() =>
        openDocumentSegmentViolations(db, s.org.orgId, {
          limit: 50,
          offset: 0,
          allowedSubsidiaryIds: new Set([randomUUID()]),
        }),
      );
      assert.equal(scoped.total, 0);
      await withBypassContext(() =>
        db.execute(
          sql`update documents set department_id = ${s.departmentA} where org_id = ${s.org.orgId} and id = ${documentId}`,
        ),
      );
      await withBypassContext(() => assertDocumentSegmentDependencies(db, s.org.orgId, documentId));
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "storage keeps each named value inside its own segment and refuses overlapping pairings",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      await withBypassContext(async () => {
        const classSegment = await builtinSegment(s.org.orgId, "class", "class_id");
        const departmentSegment = await builtinSegment(s.org.orgId, "department", "department_id");
        await assert.rejects(
          db.execute(sql`insert into segment_value_dependencies (org_id, segment_id, value_id, controlling_segment_id, allowed_value_id)
          values (${s.org.orgId}, ${classSegment}, ${s.departmentA}, ${departmentSegment}, ${s.departmentA})`),
          (error: unknown) => errorChainMatches(error, /does not belong to its segment/),
        );
        await assert.rejects(
          db.execute(sql`insert into segment_value_dependencies (org_id, segment_id, value_id, controlling_segment_id, allowed_value_id)
          values (${s.org.orgId}, ${classSegment}, ${s.classX}, ${departmentSegment}, ${s.departmentA})`),
          (error: unknown) =>
            errorChainMatches(error, /segment_value_dependencies_one_pairing|conflicting key/),
        );
      });
      const other = await createScratchOrg();
      try {
        await withBypassContext(async () => {
          const otherClass = await builtinSegment(other.orgId, "class", "class_id");
          const otherDepartment = await builtinSegment(other.orgId, "department", "department_id");
          await assert.rejects(
            db.execute(sql`insert into segment_value_dependencies (org_id, segment_id, value_id, controlling_segment_id, allowed_value_id)
            values (${other.orgId}, ${otherClass}, ${s.classX}, ${otherDepartment}, ${s.departmentA})`),
            (error: unknown) => errorChainMatches(error, /does not belong to its segment/),
            "another organization's values cannot be named",
          );
        });
      } finally {
        await dropScratchOrg(other.orgId);
      }
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);
