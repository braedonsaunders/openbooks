import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';
import type { Authz } from '../authz';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { executeAssistantTool } = await import('./registry');

// Assistant HRM read tools against real 0184/0185 rows: the same entry the
// chat loop and the MCP server share (executeAssistantTool), under the same
// gates as the routes (hrm feature + hrm.employment.read, actor subsidiary
// scope). Runs against the reviewer's own database; never touches shared
// fixtures.

const DB = !!process.env.OPENBOOKS_DB_URL;
const KNOWN_DATE = '2026-06-15';
const NOT_VISIBLE = 'Employment is not visible in this organization and legal-entity scope.';

function authzFor(orgId: string, userId: string, permissions: string[], allowed: Set<string> | null): Authz {
  const user: SessionUser = {
    id: userId, orgId, name: 'HRM tools reader', email: 'hrm-tools@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false, envKind: 'production',
    productionOrgId: orgId, homeOrgId: orgId, homeUserId: userId,
  };
  return { user, permissions: new Set(permissions), allowedSubsidiaryIds: allowed };
}

const READER_PERMS = ['assistant.use', 'hrm.employment.read'];

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function grantRead(orgId: string, roleKey: string): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = '["hrm.employment.read"]'::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function mkParty(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name)
    values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id;
}

async function mkDepartment(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name) values (${orgId}, ${name}) returning id`)).rows[0]!.id;
}

async function mkSubsidiary(orgId: string, name: string, parentId: string): Promise<string> {
  // One root (parentless) subsidiary per org: further legal entities hang off it.
  return (await db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, name, parent_id, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${randomUUID()}, ${orgId}, ${name}, ${parentId}, 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)
    returning id`)).rows[0]!.id;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkVersion(orgId: string, employmentId: string, versionNo: number, status: string, from: string): Promise<void> {
  await db.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date, null, '2026-01-01T00:00:00.000001Z'::timestamptz)`);
}

async function mkAssignment(orgId: string, employmentId: string, key: string, departmentId: string | null): Promise<void> {
  const slot = (await db.execute<{ id: string }>(sql`
    insert into employment_assignments (org_id, employment_id, assignment_key)
    values (${orgId}, ${employmentId}, ${key}) returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, version_no, job_title, department_id, fte, is_primary,
       effective_from, recorded_at)
    values (${orgId}, ${slot}, ${employmentId}, 1, 'Cashier', ${departmentId}, '1.0000', true,
      '2026-01-01'::date, '2026-01-01T00:00:00.000001Z'::timestamptz)`);
}

async function mkDraftRequest(orgId: string, employmentId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_employment_change_requests
      (org_id, employment_id, expected_employment_revision, payload, payload_digest,
       payload_schema_version, created_by)
    values (${orgId}, ${employmentId}, 1, '{"title":"Cashier"}'::jsonb, ${'0'.repeat(64)}, 'v1', null)
    returning id`)).rows[0]!.id;
}

function okData(result: unknown): Record<string, unknown> {
  assert.equal((result as { ok: boolean }).ok, true, JSON.stringify(result));
  return (result as { ok: true; data: Record<string, unknown> }).data;
}

function refusal(result: unknown): string {
  assert.equal((result as { ok: boolean }).ok, false, JSON.stringify(result));
  return (result as { ok: false; error: string }).error;
}

test('hrm_headcount resolves through versions by subsidiary and department', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM reader', 'hrm_reader'));
    await withBypassContext(async () => { await grantRead(org.orgId, 'hrm_reader'); await enableHrm(org.orgId); });
    await withBypassContext(async () => {
      const dept = await mkDepartment(org.orgId, 'Front');
      const party = await mkParty(org.orgId, 'Counted worker');
      const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
      await mkVersion(org.orgId, employmentId, 1, 'active', '2026-01-01');
      await mkAssignment(org.orgId, employmentId, 'primary', dept);
    });
    const reader = authzFor(org.orgId, actor, READER_PERMS, null);
    await withOrgContext(org.orgId, async () => {
      const headcount = okData(await executeAssistantTool(reader, 'hrm_headcount', { asOf: KNOWN_DATE }));
      assert.equal(headcount.asOf, KNOWN_DATE);
      assert.equal(headcount.total, 1);
      const groups = headcount.groups as { employerSubsidiaryId: string; departmentName: string; headcount: number }[];
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.employerSubsidiaryId, org.subsidiaryId);
      assert.equal(groups[0]?.departmentName, 'Front');
      assert.equal(groups[0]?.headcount, 1);

      // A fiscal preset resolves server-side to its end date and counts the same row.
      const preset = okData(await executeAssistantTool(reader, 'hrm_headcount', { period: 'this_fiscal_year_to_date' }));
      assert.equal(preset.total, 1);
      assert.ok(typeof preset.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(preset.asOf));
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('hrm_employment_as_of resolves by id and by party with recorded stamps', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM reader', 'hrm_reader'));
    await withBypassContext(async () => { await grantRead(org.orgId, 'hrm_reader'); await enableHrm(org.orgId); });
    const seeded = await withBypassContext(async () => {
      const party = await mkParty(org.orgId, 'Stamped worker');
      const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
      await mkVersion(org.orgId, employmentId, 1, 'active', '2026-01-01');
      await mkAssignment(org.orgId, employmentId, 'primary', null);
      return { party, employmentId };
    });
    const reader = authzFor(org.orgId, actor, READER_PERMS, null);
    await withOrgContext(org.orgId, async () => {
      const byId = okData(await executeAssistantTool(reader, 'hrm_employment_as_of', {
        employmentId: seeded.employmentId, asOf: KNOWN_DATE,
      }));
      assert.equal(byId.employmentId, seeded.employmentId);
      assert.equal(byId.workerPartyId, seeded.party);
      const version = byId.version as { status: string; recordedAt: string; recordedUntil: string | null };
      assert.equal(version.status, 'active');
      assert.ok(version.recordedAt.length > 0, 'recorded stamp must travel with the version');
      const assignments = byId.assignments as { jobTitle: string; fte: string; effectiveFrom: string }[];
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0]?.fte, '1.0000');

      const byParty = okData(await executeAssistantTool(reader, 'hrm_employment_as_of', {
        partyId: seeded.party, asOf: KNOWN_DATE,
      }));
      assert.equal(byParty.employmentId, seeded.employmentId);
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('hrm_employment_as_of refuses missing and ambiguous identity with the message intact', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM reader', 'hrm_reader'));
    await withBypassContext(async () => { await grantRead(org.orgId, 'hrm_reader'); await enableHrm(org.orgId); });
    const party = await withBypassContext(() => mkParty(org.orgId, 'Lonely worker'));
    const reader = authzFor(org.orgId, actor, READER_PERMS, null);
    await withOrgContext(org.orgId, async () => {
      // Unknown employment: the read service refuses uniformly, never an empty result.
      assert.equal(
        refusal(await executeAssistantTool(reader, 'hrm_employment_as_of', {
          employmentId: randomUUID(), asOf: KNOWN_DATE,
        })),
        NOT_VISIBLE,
      );
      // A party with no employment refuses as missing, naming the remedy.
      assert.match(
        refusal(await executeAssistantTool(reader, 'hrm_employment_as_of', { partyId: party, asOf: KNOWN_DATE })),
        /employment not found/,
      );
      // Two employments for one party refuse as ambiguous.
      await withBypassContext(async () => {
        const first = await mkEmployment(org.orgId, party, org.subsidiaryId);
        await mkVersion(org.orgId, first, 1, 'active', '2026-01-01');
        const second = await mkEmployment(org.orgId, party, org.subsidiaryId);
        await mkVersion(org.orgId, second, 1, 'active', '2026-01-01');
      });
      assert.match(
        refusal(await executeAssistantTool(reader, 'hrm_employment_as_of', { partyId: party, asOf: KNOWN_DATE })),
        /ambiguous/,
      );
      // No identity at all is a stable addressing code, not a schema throw.
      assert.equal(
        refusal(await executeAssistantTool(reader, 'hrm_employment_as_of', { asOf: KNOWN_DATE })),
        'employment_or_party_required',
      );
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('hrm_change_requests lists status, revision binding, and flow run', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM reader', 'hrm_reader'));
    await withBypassContext(async () => { await grantRead(org.orgId, 'hrm_reader'); await enableHrm(org.orgId); });
    const seeded = await withBypassContext(async () => {
      const party = await mkParty(org.orgId, 'Request worker');
      const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
      await mkVersion(org.orgId, employmentId, 1, 'active', '2026-01-01');
      const first = await mkDraftRequest(org.orgId, employmentId);
      const second = await mkDraftRequest(org.orgId, employmentId);
      return { employmentId, first, second };
    });
    const reader = authzFor(org.orgId, actor, READER_PERMS, null);
    await withOrgContext(org.orgId, async () => {
      const listed = okData(await executeAssistantTool(reader, 'hrm_change_requests', {
        employmentId: seeded.employmentId,
      }));
      assert.equal(listed.returned, 2);
      const requests = listed.requests as {
        id: string; status: string; requestRevision: number; expectedEmploymentRevision: number;
        payloadSchemaVersion: string; flowRunId: string | null;
      }[];
      // Newest first.
      assert.deepEqual(requests.map((r) => r.id), [seeded.second, seeded.first]);
      for (const request of requests) {
        assert.equal(request.status, 'draft');
        assert.equal(request.requestRevision, 1);
        assert.equal(request.expectedEmploymentRevision, 1);
        assert.equal(request.payloadSchemaVersion, 'v1');
        assert.equal(request.flowRunId, null);
      }
      const drafts = okData(await executeAssistantTool(reader, 'hrm_change_requests', {
        employmentId: seeded.employmentId, status: 'draft',
      }));
      assert.equal(drafts.returned, 2);
      // A status with no rows is a truthful empty, not a refusal.
      const approved = okData(await executeAssistantTool(reader, 'hrm_change_requests', {
        employmentId: seeded.employmentId, status: 'approved',
      }));
      assert.equal(approved.returned, 0);
      // The org-wide list reaches the same rows through the scoped enumeration.
      const orgWide = okData(await executeAssistantTool(reader, 'hrm_change_requests', {}));
      assert.ok((orgWide.total as number) >= 2);
      // Unknown employment refuses with the message intact, never an empty list.
      assert.equal(
        refusal(await executeAssistantTool(reader, 'hrm_change_requests', { employmentId: randomUUID() })),
        NOT_VISIBLE,
      );
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('feature-off refuses all three tools with the stable code', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM reader', 'hrm_reader'));
    await withBypassContext(() => grantRead(org.orgId, 'hrm_reader'));
    // hrm stays off: the registry gate passes on permissions, the feature check refuses.
    const reader = authzFor(org.orgId, actor, READER_PERMS, null);
    await withOrgContext(org.orgId, async () => {
      assert.equal(refusal(await executeAssistantTool(reader, 'hrm_headcount', {})), 'hrm_feature_disabled');
      assert.equal(refusal(await executeAssistantTool(reader, 'hrm_employment_as_of', {})), 'hrm_feature_disabled');
      assert.equal(refusal(await executeAssistantTool(reader, 'hrm_change_requests', {})), 'hrm_feature_disabled');
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('no-permission refuses at the registry gate and at the engine gate', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM reader', 'hrm_reader'));
    const denied = await withBypassContext(() => createScratchUser(org.orgId, 'Ungranted reader', 'no_grant'));
    await withBypassContext(async () => { await grantRead(org.orgId, 'hrm_reader'); await enableHrm(org.orgId); });
    await withOrgContext(org.orgId, async () => {
      // Without the permission the tools are not even exposed: forbidden.
      const unpermitted = authzFor(org.orgId, actor, ['assistant.use'], null);
      assert.equal(refusal(await executeAssistantTool(unpermitted, 'hrm_headcount', {})), 'forbidden');
      assert.equal(refusal(await executeAssistantTool(unpermitted, 'hrm_employment_as_of', {})), 'forbidden');
      assert.equal(refusal(await executeAssistantTool(unpermitted, 'hrm_change_requests', {})), 'forbidden');
      // With the registry permission claimed but no DB grant, the engine
      // gate refuses with the remedy intact.
      const ungranted = authzFor(org.orgId, denied, READER_PERMS, null);
      assert.match(
        refusal(await executeAssistantTool(ungranted, 'hrm_headcount', {})),
        /hrm\.employment\.read/,
      );
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('restricted subsidiary scope filters headcount and refuses foreign employment', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM reader', 'hrm_restricted'));
    const seeded = await withBypassContext(async () => {
      const other = await mkSubsidiary(org.orgId, 'Second Co', org.subsidiaryId);
      // The engine recomputes subsidiary scope from the actor's DB role, so
      // the restriction lives there (mirroring the session allowlist below).
      await grantRead(org.orgId, 'hrm_restricted');
      await db.execute(sql`
        update app_roles
           set subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [other] })}::jsonb
         where org_id = ${org.orgId} and key = 'hrm_restricted'`);
      await enableHrm(org.orgId);
      const homeParty = await mkParty(org.orgId, 'Home worker');
      const homeEmployment = await mkEmployment(org.orgId, homeParty, org.subsidiaryId);
      await mkVersion(org.orgId, homeEmployment, 1, 'active', '2026-01-01');
      const awayParty = await mkParty(org.orgId, 'Away worker');
      const awayEmployment = await mkEmployment(org.orgId, awayParty, other);
      await mkVersion(org.orgId, awayEmployment, 1, 'active', '2026-01-01');
      await mkDraftRequest(org.orgId, awayEmployment);
      return { other, homeEmployment, awayEmployment };
    });
    await withOrgContext(org.orgId, async () => {
      const restricted = authzFor(org.orgId, actor, READER_PERMS, new Set([seeded.other]));
      // Only the in-scope employment counts.
      const headcount = okData(await executeAssistantTool(restricted, 'hrm_headcount', { asOf: KNOWN_DATE }));
      assert.equal(headcount.total, 1);
      // The foreign employment refuses uniformly — indistinguishable from missing.
      assert.equal(
        refusal(await executeAssistantTool(restricted, 'hrm_employment_as_of', {
          employmentId: seeded.homeEmployment, asOf: KNOWN_DATE,
        })),
        NOT_VISIBLE,
      );
      // The org-wide request list reaches only the in-scope employment.
      const orgWide = okData(await executeAssistantTool(restricted, 'hrm_change_requests', {}));
      const requests = orgWide.requests as { employmentId: string }[];
      assert.ok(requests.length >= 1);
      for (const request of requests) assert.equal(request.employmentId, seeded.awayEmployment);
      // But the in-scope employment itself resolves.
      const away = okData(await executeAssistantTool(restricted, 'hrm_employment_as_of', {
        employmentId: seeded.awayEmployment, asOf: KNOWN_DATE,
      }));
      assert.equal(away.employmentId, seeded.awayEmployment);
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
