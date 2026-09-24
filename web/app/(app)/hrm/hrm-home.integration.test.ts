import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The HRM cockpit loader's data contract, proved against the shard database:
// cross-org invisibility of every scoped leg, the subsidiary lens, the
// grant-gated panels resolving null (never gated links), and the mixed-scope
// queue refusal rendering as data instead of throwing. Page-level gates
// (feature switch, employment read) live in loadHrmPage; the spec tree the
// loader feeds is proved in hrm-home.spec.test.ts.
process.env.SESSION_SECRET ??= "t6-lane-test-secret-must-be-32+chars!!!!";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getTranslations(){const t=(key)=>key;t.has=()=>false;return t}export async function getLocale(){return "en"}',
      };
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function redirect(){throw new Error("redirect")}export function useRouter(){return {push(){},refresh(){}}}export function usePathname(){return "/hrm"}export function useSearchParams(){return new URLSearchParams()}',
      };
    }
    if (specifier === 'next/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export class NextResponse{static json(body,init){return Response.json(body,init)}}',
      };
    }
    return next(specifier, context);
  },
});

const { sql } = await import('drizzle-orm');
const { db, withOrgContext, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { loadHrmHome } = await import('../../../lib/hrm/home.ts');
const { hrmGroupTabs } = await import('../../../components/module-home/group-tabs.ts');
const {
  hrmPeopleViewTabs,
  hrmHiringViewTabs,
  hrmTalentViewTabs,
  hrmRewardsViewTabs,
} = await import('../../../lib/hrm/workspace-tabs.ts');
import type { Authz } from '../../../lib/authz.ts';

const FULL_GRANTS = [
  'hrm.employment.read',
  'hrm.employment.manage',
  'hrm.position.read',
  'hrm.process.read',
  'hrm.leave.read',
  'hrm.recruiting.read',
  'hrm.benefits.read',
  'hrm.compensation.read',
  'parties.read',
];

function actor(userId: string, orgId: string, permissions: string[], allowedSubsidiaryIds: Set<string> | null): Authz {
  return {
    user: {
      id: userId,
      orgId,
      name: 'HRM cockpit test',
      email: `hrm-${userId.slice(0, 8)}@scratch.test`,
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: orgId,
      homeOrgId: orgId,
      homeUserId: userId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds,
  };
}

const day = 86_400_000;
const isoDay = (offsetDays: number): string => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

async function seedParty(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active)
    values (${id}, ${orgId}, 'person', ${name}, true)`);
  await db.execute(sql`insert into employee_roles (org_id, party_id, hired_on, is_active)
    values (${orgId}, ${id}, '2026-01-01', true)`);
  return id;
}

async function seedEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id)
    values (${id}, ${orgId}, ${partyId}, ${subsidiaryId})`);
  return id;
}

async function seedVersion(orgId: string, employmentId: string, status: string, from: string, to: string | null): Promise<void> {
  await db.execute(sql`insert into worker_employment_versions
    (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_until)
    values (${orgId}, ${employmentId}, 1, ${status}, ${from}::date, ${to === null ? null : to}::date, null)`);
}

async function seedChange(orgId: string, employmentId: string, kind: string, reason: string, actorId: string): Promise<void> {
  await db.execute(sql`insert into employment_changes
    (org_id, employment_id, revision, change_kind, prior_snapshot, reason, change_txid, recorded_by)
    values (${orgId}, ${employmentId}, 1, ${kind}, '{}'::jsonb, ${reason}, 1::bigint, ${actorId})`);
}

async function enableFeatures(orgId: string, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await db.execute(
      sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${'features,' + key}, ','), 'true'::jsonb, true) where id = ${orgId}`,
    );
  }
}

async function enableHrm(orgId: string): Promise<void> {
  await enableFeatures(orgId, 'hrm');
}

async function seedRequest(orgId: string, employmentId: string, actorId: string): Promise<void> {
  await db.execute(sql`insert into hrm_employment_change_requests
    (org_id, employment_id, expected_employment_revision, payload, payload_digest, payload_schema_version, created_by)
    values (${orgId}, ${employmentId}, 1, '{"kind":"status_change"}'::jsonb, ${'0'.repeat(64)}, '1', ${actorId})`);
}

async function grantRole(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb
    where org_id=${orgId} and key=${roleKey}`);
}

async function restrictRole(orgId: string, roleKey: string, subsidiaryIds: string[]): Promise<void> {
  await db.execute(
    sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds })}::jsonb where org_id=${orgId} and key=${roleKey}`,
  );
}

test('scoped legs hide another organization entirely', async (t) => {
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  t.after(() => dropScratchOrg(orgA.orgId));
  t.after(() => dropScratchOrg(orgB.orgId));
  let reader = '';
  try {
    await withBypassContext(async () => {
      await enableHrm(orgA.orgId);
      await enableHrm(orgB.orgId);
      reader = await createScratchUser(orgA.orgId, 'Reader', 't6_hrm_reader');
      await grantRole(orgA.orgId, 't6_hrm_reader', FULL_GRANTS);
      const partyA = await seedParty(orgA.orgId, 'Ava Alpha');
      const empA = await seedEmployment(orgA.orgId, partyA, orgA.subsidiaryId);
      await seedVersion(orgA.orgId, empA, 'active', isoDay(5), null);
      await seedChange(orgA.orgId, empA, 'status_changed', 'promotion to senior', reader);

      const observerB = await createScratchUser(orgB.orgId, 'Observer', 't6_hrm_observer');
      const partyB = await seedParty(orgB.orgId, 'Ben Beta');
      const empB = await seedEmployment(orgB.orgId, partyB, orgB.subsidiaryId);
      await seedVersion(orgB.orgId, empB, 'active', isoDay(5), null);
      await seedChange(orgB.orgId, empB, 'status_changed', 'other org movement', observerB);
    });
    const data = await withOrgContext(orgA.orgId, () =>
      loadHrmHome(actor(reader, orgA.orgId, FULL_GRANTS, null)),
    );
    const names = [
      ...data.starts.map((row) => row.name),
      ...data.ends.map((row) => row.name),
      ...data.recent.map((row) => row.name),
    ];
    assert.ok(names.includes('Ava Alpha'), 'the home org start must surface');
    assert.ok(!names.includes('Ben Beta'), 'no scoped leg may leak another org');
    assert.ok(
      data.recent.some((row) => row.reason === 'promotion to senior'),
      'the home org change evidence must surface',
    );
    assert.ok(
      !data.recent.some((row) => row.reason === 'other org movement'),
      'the change aggregate must stay org-predicated',
    );
  } finally {
    await dropScratchOrg(orgA.orgId).catch(() => {});
    await dropScratchOrg(orgB.orgId).catch(() => {});
  }
});

test('the subsidiary lens narrows the version window', async (t) => {
  const org = await withBypassContext(() => createScratchOrg());
  t.after(() => dropScratchOrg(org.orgId));
  let reader = '';
  try {
    await withBypassContext(async () => {
      await enableHrm(org.orgId);
      const party = await seedParty(org.orgId, 'Lenny Lens');
      const emp = await seedEmployment(org.orgId, party, org.subsidiaryId);
      await seedVersion(org.orgId, emp, 'active', isoDay(5), null);
      reader = await createScratchUser(org.orgId, 'Reader', 't6_hrm_lens');
      await grantRole(org.orgId, 't6_hrm_lens', FULL_GRANTS);
    });
    const wide = await withOrgContext(org.orgId, () =>
      loadHrmHome(actor(reader, org.orgId, FULL_GRANTS, null)),
    );
    assert.ok(wide.starts.some((row) => row.name === 'Lenny Lens'), 'an unrestricted actor sees the start');

    const elsewhere = await withOrgContext(org.orgId, () =>
      loadHrmHome(actor(reader, org.orgId, FULL_GRANTS, new Set([randomUUID()]))),
    );
    assert.ok(
      !elsewhere.starts.some((row) => row.name === 'Lenny Lens'),
      'a lens naming no visible subsidiary hides the start',
    );
    assert.ok(
      !elsewhere.ends.some((row) => row.name === 'Lenny Lens'),
      'a lens naming no visible subsidiary hides the end',
    );
  } finally {
    await dropScratchOrg(org.orgId).catch(() => {});
  }
});

test('panels resolve null without their grants, never gated links', async (t) => {
  const org = await withBypassContext(() => createScratchOrg());
  t.after(() => dropScratchOrg(org.orgId));
  let reader = '';
  try {
    await withBypassContext(async () => {
      await enableHrm(org.orgId);
      reader = await createScratchUser(org.orgId, 'Reader', 't6_hrm_min');
      await grantRole(org.orgId, 't6_hrm_min', ['hrm.employment.read']);
    });
    const data = await withOrgContext(org.orgId, () =>
      loadHrmHome(actor(reader, org.orgId, ['hrm.employment.read'], null)),
    );
    assert.equal(data.positions, null, 'vacancy resolves only for the position read grant');
    assert.equal(data.onboarding, null, 'onboarding resolves only for the process read grant');
    assert.equal(data.leavePanel, null, 'leave resolves only for the leave read grant');
    assert.equal(data.recruiting, null, 'recruiting resolves only for the recruiting read grant');
    assert.equal(data.benefitsPanel, null, 'benefits resolves only for the benefits read grant');
    assert.equal(data.onboardingHasActivity, false);
    assert.equal(data.leaveHasActivity, false);
    assert.equal(data.benefitsHasActivity, false);
    assert.equal(data.recruitingHasActivity, false);
  } finally {
    await dropScratchOrg(org.orgId).catch(() => {});
  }
});

const STRIP_GRANTS = [
  ...FULL_GRANTS,
  'hrm.construction.read',
  'hrm.documents.read',
  'hrm.certifications.read',
  'hrm.surveys.manage',
  'hrm.process.read',
  'hrm.position.read',
];

test('the strip offers the jobs with grant, rewrite, and feature exclusions', async (t) => {
  const org = await withBypassContext(() => createScratchOrg());
  t.after(() => dropScratchOrg(org.orgId));
  const user = await withBypassContext(async () => {
    // Rewards lands on /hrm/compensation only while the hrmCompensation
    // switch is on (benefits-only orgs rewrite to /hrm/benefits); the
    // full-strip assertions below need the switch, mirroring the
    // viewTabs test further down.
    await enableFeatures(org.orgId, 'hrm', 'hrmCompensation');
    return createScratchUser(org.orgId, 'Strip', 't6_hrm_strip');
  });
  const hrefs = async (permissions: string[], activeHref = '/hrm'): Promise<string[]> => {
    await withBypassContext(() => grantRole(org.orgId, 't6_hrm_strip', permissions));
    return withOrgContext(org.orgId, async () =>
      (await hrmGroupTabs(actor(user, org.orgId, permissions, null), activeHref)).map((tab) => tab.href),
    );
  };
  try {
    const full = await hrefs(STRIP_GRANTS);
    for (const href of ['/hrm', '/entities/employees', '/hrm/recruiting', '/hrm/leave', '/hrm/performance', '/hrm/compensation']) {
      assert.ok(full.includes(href), `the strip lands on ${href}`);
    }
    assert.ok(!full.includes('/hrm/compliance'), 'compliance hides while the construction switch is off');
    // Nested working surfaces are viewTabs under a job, never strip peers.
    for (const href of ['/hrm/positions', '/hrm/change-requests', '/hrm/my-leave', '/hrm/departments', '/hrm/reports']) {
      assert.ok(!full.includes(href), `${href} is not a group-strip tab`);
    }

    await withBypassContext(() =>
      enableFeatures(org.orgId, 'payroll', 'projects', 'timeTracking', 'hrmConstructionCompliance'),
    );
    const constructed = await hrefs(STRIP_GRANTS);
    assert.ok(constructed.includes('/hrm/compliance'), 'compliance is tab 7 while construction is on');

    const noLeave = await hrefs(STRIP_GRANTS.filter((grant) => grant !== 'hrm.leave.read'));
    assert.ok(!noLeave.includes('/hrm/leave'), 'Time off hides without the leave read grant');

    const noHiring = await hrefs(STRIP_GRANTS.filter((grant) => grant !== 'hrm.recruiting.read' && grant !== 'hrm.position.read'));
    assert.ok(!noHiring.includes('/hrm/recruiting'), 'Hiring hides with neither recruiting nor positions');

    // Hiring and Rewards are OR-gates: the landing rewrites instead of 404ing.
    const positionsOnly = await hrefs(STRIP_GRANTS.filter((grant) => grant !== 'hrm.recruiting.read'));
    const hiringHref = positionsOnly.find((href) => href.startsWith('/hrm/recruiting') || href.startsWith('/hrm/positions'));
    assert.ok(hiringHref?.startsWith('/hrm/positions'), 'Hiring rewrites to Positions when recruiting is unavailable');

    const noRewards = await hrefs(STRIP_GRANTS.filter((grant) => grant !== 'hrm.compensation.read' && grant !== 'hrm.benefits.read'));
    assert.ok(!noRewards.includes('/hrm/compensation'), 'Rewards hides with neither compensation nor benefits');

    const benefitsOnly = await hrefs(STRIP_GRANTS.filter((grant) => grant !== 'hrm.compensation.read'));
    const rewardsHref = benefitsOnly.find((href) => href.startsWith('/hrm/compensation') || href.startsWith('/hrm/benefits'));
    assert.ok(rewardsHref?.startsWith('/hrm/benefits'), 'Rewards rewrites to Benefits when compensation is unavailable');

    // The native employee list carries the same strip: the function the
    // entities view awaits, with the list href active.
    const onList = await hrefs(STRIP_GRANTS, '/entities/employees');
    assert.ok(onList.includes('/hrm'), 'the employee list resolves the HRM strip');
  } finally {
    await dropScratchOrg(org.orgId).catch(() => {});
  }
});

test('nested surfaces stay findable as viewTabs', async (t) => {
  const org = await withBypassContext(() => createScratchOrg());
  t.after(() => dropScratchOrg(org.orgId));
  const user = await withBypassContext(async () => {
    await enableFeatures(org.orgId, 'hrm', 'hrmDocuments', 'hrmCertifications', 'hrmCompensation');
    return createScratchUser(org.orgId, 'Views', 't6_hrm_views');
  });
  const viewActor = (permissions: string[]): Authz => actor(user, org.orgId, permissions, null);
  const grant = (permissions: string[]): Promise<void> =>
    withBypassContext(() => grantRole(org.orgId, 't6_hrm_views', permissions));
  try {
    await grant(STRIP_GRANTS);
    const people = await withOrgContext(org.orgId, () =>
      hrmPeopleViewTabs(viewActor(STRIP_GRANTS), '/entities/employees'),
    );
    const peopleHrefs = people.map((tab) => tab.href);
    for (const href of ['/entities/employees', '/hrm/processes', '/hrm/org-chart', '/hrm/documents', '/hrm/qualifications']) {
      assert.ok(peopleHrefs.includes(href), `People viewTabs include ${href}`);
    }

    const hiring = await withOrgContext(org.orgId, () =>
      hrmHiringViewTabs(viewActor(STRIP_GRANTS), '/hrm/positions', []),
    );
    assert.ok(hiring.some((tab) => tab.href === '/hrm/positions'), 'Hiring viewTabs include Positions');
    const noPositions = await withOrgContext(org.orgId, () =>
      hrmHiringViewTabs(viewActor(STRIP_GRANTS.filter((grant) => grant !== 'hrm.position.read')), '/hrm/positions', []),
    );
    assert.ok(!noPositions.some((tab) => tab.href === '/hrm/positions'), 'Positions hides without its grant');

    const talent = await withOrgContext(org.orgId, () =>
      hrmTalentViewTabs(viewActor(STRIP_GRANTS), '/hrm/performance'),
    );
    assert.ok(talent.some((tab) => tab.href === '/hrm/performance'), 'Talent always lands on the cycles tab');

    const rewards = await withOrgContext(org.orgId, () =>
      hrmRewardsViewTabs(viewActor(STRIP_GRANTS), '/hrm/benefits'),
    );
    const rewardHrefs = rewards.map((tab) => tab.href);
    assert.ok(rewardHrefs.includes('/hrm/compensation'), 'Rewards viewTabs include Compensation');
    assert.ok(rewardHrefs.includes('/hrm/benefits'), 'Rewards viewTabs include Benefits');
  } finally {
    await dropScratchOrg(org.orgId).catch(() => {});
  }
});

test('a mixed-scope queue pins the refusal instead of throwing', async (t) => {
  const org = await withBypassContext(() => createScratchOrg());
  t.after(() => dropScratchOrg(org.orgId));
  let stranger = '';
  try {
    await withBypassContext(async () => {
      await enableHrm(org.orgId);
      const party = await seedParty(org.orgId, 'Quinn Queue');
      const emp = await seedEmployment(org.orgId, party, org.subsidiaryId);
      await seedVersion(org.orgId, emp, 'active', '2026-01-01', null);
      stranger = await createScratchUser(org.orgId, 'Stranger', 't6_hrm_stranger');
      await grantRole(org.orgId, 't6_hrm_stranger', ['hrm.employment.read']);
      // Scope the stranger to a subsidiary holding nothing: the queue row in
      // the root entity is out of scope, while list-shaped reads narrow.
      await restrictRole(org.orgId, 't6_hrm_stranger', [randomUUID()]);
      await seedRequest(org.orgId, emp, stranger);
    });
    const data = await withOrgContext(org.orgId, () =>
      loadHrmHome(actor(stranger, org.orgId, ['hrm.employment.read'], null)),
    );
    assert.deepEqual(data.pending, [], 'a refused queue shows no partial subset');
    assert.ok(
      typeof data.pendingRefusal === 'string' && data.pendingRefusal.length > 0,
      'the refusal must render as data beside the hero, never a 500',
    );
  } finally {
    await dropScratchOrg(org.orgId).catch(() => {});
  }
});
