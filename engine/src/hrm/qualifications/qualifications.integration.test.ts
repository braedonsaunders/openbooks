import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { projectDerivedStatus } from "./shared.ts";
import {
  createQualificationType,
  declareCategory,
  listQualificationTypes,
} from "./types.ts";
import {
  attachEvidence,
  listQualificationEvents,
  listQualifications,
  recordQualification,
  renewQualification,
  revokeQualification,
  verifyQualification,
} from "./qualifications.ts";
import {
  listRequirements,
  removeRequirement,
  setRequirement,
} from "./requirements.ts";
import {
  checkAssignment,
  gateScheduleAssignment,
  noteWarnedDispatch,
  refuseBlockedDispatch,
} from "./gating.ts";
import {
  listAlerts,
  runQualificationAlertScan,
} from "./alerts.ts";
import { loadMaskingPolicies, seedDefaultMaskingPolicies } from "../../sandbox/masking.ts";

/**
 * HR-14 DB coverage (integration partition — run by the integrator at
 * gate; skips without OPENBOOKS_DB_URL): migration 0225 bootstrap plus
 * RLS, the ledger (record/verify/renew-as-new-row/revoke with every
 * refusal red-proofed through the real code path), derived-status
 * projection at read, append-only events, block-vs-warn dispatch gating
 * on the scheduling assignment path, feature-off bypass proven with a
 * throwing test double, alert idempotency across two scheduler runs,
 * identifier masking in the sandbox seed, and the second-org floor.
 * Proofs are read back from storage, never from service returns alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const FEATURES = [
  "hrm",
  "projects",
  "projectScheduling",
  "equipment",
  "hrmCertifications",
  "hrmDispatchGating",
  "hrmEquipmentQualifications",
  "hrmCertificationAlerts",
];

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of FEATURES) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
}

async function disableFeature(orgId: string, feature: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'false'::jsonb, true)
     where id = ${orgId}
  `);
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

type Harness = { org: ScratchOrg; adminId: string; outsiderId: string };

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId);
  const adminId = await createScratchUser(org.orgId, "Qualification Admin", "qual_admin");
  const outsiderId = await createScratchUser(org.orgId, "Qualification Outsider", "qual_outsider");
  await grantPermissions(org.orgId, adminId, ["hrm.certifications.read", "hrm.certifications.manage"]);
  return { org, adminId, outsiderId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedWorker(orgId: string, subsidiaryId: string, name: string): Promise<{ employmentId: string; partyId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  return { employmentId, partyId };
}

async function seedProject(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, name, status) values (${id}, ${orgId}, ${name}, 'active')
  `);
  return id;
}

async function seedResource(orgId: string, projectId: string, partyId: string | null, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into schedule_resources (id, org_id, project_id, name, kind, party_id)
    values (${id}, ${orgId}, ${projectId}, ${name}, 'crew', ${partyId})
  `);
  return id;
}

function addDays(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function seedType(
  orgId: string,
  adminId: string,
  overrides: { code?: string; validityMonths?: number | null; requiresEvidence?: boolean; renewalLeadDays?: number } = {},
): Promise<string> {
  const type = await createQualificationType(db, {
    orgId,
    actorId: adminId,
    code: overrides.code ?? `Osha-${randomUUID().slice(0, 8)}`,
    name: "OSHA 30",
    category: "certification",
    validityMonths: overrides.validityMonths === undefined ? 12 : overrides.validityMonths,
    renewalLeadDays: overrides.renewalLeadDays ?? 30,
    requiresEvidence: overrides.requiresEvidence ?? false,
  });
  return type.id;
}

test("migration 0225 bootstrap: six tables, forced RLS, events append-only", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const tables = (await db.execute<{ table: string; rls: boolean }>(sql`
      select tablename as table, rowsecurity as rls
        from pg_tables where schemaname = 'public'
         and tablename in ('hrm_qualification_types', 'hrm_worker_qualifications',
                           'hrm_qualification_events', 'hrm_qualification_requirements',
                           'hrm_qualification_alerts', 'hrm_qualification_settings')
    `)).rows;
    assert.deepEqual(
      tables.map((t) => t.table).sort(),
      [
        "hrm_qualification_alerts",
        "hrm_qualification_events",
        "hrm_qualification_requirements",
        "hrm_qualification_settings",
        "hrm_qualification_types",
        "hrm_worker_qualifications",
      ],
    );
    for (const t of tables) assert.equal(t.rls, true);
    const policies = (await db.execute<{ tablename: string }>(sql`
      select tablename from pg_policies where schemaname = 'public'
       and policyname = 'org_isolation'
       and tablename in ('hrm_qualification_types', 'hrm_worker_qualifications',
                         'hrm_qualification_events', 'hrm_qualification_requirements',
                         'hrm_qualification_alerts', 'hrm_qualification_settings')
    `)).rows;
    assert.equal(policies.length, 6);
    // Append-only events: an update is refused by storage, not by the service.
    // The driver wraps the Postgres refusal, so the proof reads the cause.
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Ledger Hand");
    const typeId = await seedType(h.org.orgId, h.adminId);
    const today = await businessToday(h.org.orgId);
    const q = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: today,
    });
    await assert.rejects(
      db.execute(sql`update hrm_qualification_events set reason = 'rewritten' where qualification_id = ${q.id}::uuid`),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause;
        assert.ok(error instanceof Error);
        assert.match(String(cause), /append-only audit evidence/);
        return true;
      },
    );
  });
});

test("record refuses by name: window, undeclared type, missing evidence, retired type", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Refusal Hand");
    const typeId = await seedType(h.org.orgId, h.adminId);
    const today = await businessToday(h.org.orgId);
    // expires_on before issued_on.
    await assert.rejects(
      recordQualification(db, {
        orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
        typeId, issuedOn: today, expiresOn: addDays(today, -1),
      }),
      /cannot expire before it is issued/,
    );
    // A type the org has not declared.
    await assert.rejects(
      recordQualification(db, {
        orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
        typeId: randomUUID(), issuedOn: today,
      }),
      /not declared in this organization/,
    );
    // Evidence required with none attached.
    const evType = await seedType(h.org.orgId, h.adminId, { code: `Twic-${randomUUID().slice(0, 8)}`, requiresEvidence: true });
    await assert.rejects(
      recordQualification(db, {
        orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
        typeId: evType, issuedOn: today,
      }),
      /requires evidence/,
    );
    // Record defaults expiry from validity_months at save (stored, readable back).
    const stored = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: today,
    });
    assert.ok(stored.expiresOn && stored.expiresOn > today);
    assert.equal(stored.storedStatus, "pending_verification");
    const reread = (await db.execute<{ expires_on: string }>(sql`
      select expires_on::text from hrm_worker_qualifications where id = ${stored.id}::uuid
    `)).rows[0]?.expires_on;
    assert.equal(reread, stored.expiresOn);
  });
});

test("verify, renew-as-new-row, revoke: hostile loops refused", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Lifecycle Hand");
    const typeId = await seedType(h.org.orgId, h.adminId);
    const today = await businessToday(h.org.orgId);
    const q = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: addDays(today, -400),
    });
    const verified = await verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: q.id });
    assert.equal(verified.storedStatus, "valid");
    // Renewal is a NEW row linked to the old one — never an overwrite.
    const renewed = await renewQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, qualificationId: q.id, issuedOn: today,
    });
    assert.notEqual(renewed.id, q.id);
    assert.equal(renewed.storedStatus, "pending_verification");
    const events = await listQualificationEvents(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: renewed.id });
    const renewedEvent = events.find((e) => e.kind === "renewed");
    assert.ok(renewedEvent);
    assert.equal(renewedEvent.relatedQualificationId, q.id);
    const oldStillThere = (await db.execute<{ id: string }>(sql`
      select id::text as id from hrm_worker_qualifications where id = ${q.id}::uuid
    `)).rows[0]?.id;
    assert.equal(oldStillThere, q.id);
    // Revoke needs a reason; then the row is frozen.
    await assert.rejects(
      revokeQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: renewed.id, reason: "   " }),
      /non-blank/,
    );
    const revoked = await revokeQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, qualificationId: renewed.id, reason: "Fraudulent certificate",
    });
    assert.equal(revoked.storedStatus, "revoked");
    await assert.rejects(
      verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: renewed.id }),
      /revoked qualification cannot be verified/,
    );
    await assert.rejects(
      renewQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: renewed.id, issuedOn: today }),
      /revoked qualification cannot be renewed/,
    );
    await assert.rejects(
      revokeQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: renewed.id, reason: "again" }),
      /already revoked/,
    );
  });
});

test("evidence: in-org file attaches, another org's file refused", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Evidence Hand");
    const typeId = await seedType(h.org.orgId, h.adminId, { requiresEvidence: false });
    const today = await businessToday(h.org.orgId);
    const q = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: today,
    });
    const folderId = randomUUID();
    await db.execute(sql`
      insert into folders (id, org_id, name) values (${folderId}, ${h.org.orgId}, 'qualifications')
    `);
    const fileId = randomUUID();
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${h.org.orgId}, ${folderId}, 'osha30.pdf', 'application/pdf', 12)
    `);
    const attached = await attachEvidence(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: q.id, fileId });
    assert.equal(attached.evidenceFileId, fileId);
    // A file from another org is refused by name, never attached.
    const other = await createScratchOrg();
    try {
      const otherFolder = randomUUID();
      await db.execute(sql`
        insert into folders (id, org_id, name) values (${otherFolder}, ${other.orgId}, 'qualifications')
      `);
      const otherFile = randomUUID();
      await db.execute(sql`
        insert into files (id, org_id, folder_id, name, content_type, size_bytes)
        values (${otherFile}, ${other.orgId}, ${otherFolder}, 'foreign.pdf', 'application/pdf', 12)
      `);
      await assert.rejects(
        attachEvidence(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: q.id, fileId: otherFile }),
        /not in this organization/,
      );
      const reread = (await db.execute<{ evidence_file_id: string }>(sql`
        select evidence_file_id::text from hrm_worker_qualifications where id = ${q.id}::uuid
      `)).rows[0]?.evidence_file_id;
      assert.equal(reread, fileId);
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});

test("derived status projects at read: expiring, expired, pending, valid", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Projection Hand");
    const typeId = await seedType(h.org.orgId, h.adminId, { validityMonths: null, renewalLeadDays: 30 });
    const today = await businessToday(h.org.orgId);
    // Expiring inside the lead window.
    const expiring = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: addDays(today, -300), expiresOn: addDays(today, 10),
    });
    await verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: expiring.id });
    // Already expired.
    const expired = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: addDays(today, -400), expiresOn: addDays(today, -1),
    });
    await verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: expired.id });
    // Pending stays pending regardless of dates (distinct issue date:
    // one row per employment × type × issued_on).
    const pending = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: addDays(today, -401), expiresOn: addDays(today, -1),
    });
    // Never expires.
    const forever = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: addDays(today, -900), expiresOn: null,
    });
    await verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: forever.id });
    const byId = new Map(
      (await listQualifications(db, { orgId: h.org.orgId, actorId: h.adminId })).map((q) => [q.id, q.status]),
    );
    assert.equal(byId.get(expiring.id), "expiring");
    assert.equal(byId.get(expired.id), "expired");
    assert.equal(byId.get(pending.id), "pending_verification");
    assert.equal(byId.get(forever.id), "valid");
    // The status filter reads the same projection.
    const expiredOnly = await listQualifications(db, { orgId: h.org.orgId, actorId: h.adminId, status: "expired" });
    assert.ok(expiredOnly.some((q) => q.id === expired.id));
    assert.ok(expiredOnly.every((q) => q.status === "expired"));
    // Storage never holds derived state.
    const stored = (await db.execute<{ status: string }>(sql`
      select distinct status from hrm_worker_qualifications where org_id = ${h.org.orgId}
    `)).rows.map((r) => r.status);
    // Anchor the loop: an empty result set would let every assertion inside
    // it pass vacuously, so the count is asserted before anything iterates.
    assert.ok(stored.length > 0, "the fixture must have stored qualification rows to check");
    for (const s of stored) assert.ok(["valid", "revoked", "pending_verification"].includes(s));
    // The pure projector agrees with the service at the boundaries.
    assert.equal(projectDerivedStatus({ stored: "valid", expiresOn: addDays(today, 30), leadDays: 30, today }), "expiring");
    assert.equal(projectDerivedStatus({ stored: "valid", expiresOn: addDays(today, 31), leadDays: 30, today }), "valid");
  });
});

test("category vocabulary: undeclared refused, Setup declaration opens it", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await assert.rejects(
      createQualificationType(db, {
        orgId: h.org.orgId, actorId: h.adminId, code: "SitePass", name: "Site pass", category: "site-pass",
      }),
      /not declared for this organization/,
    );
    const settings = await declareCategory(db, { orgId: h.org.orgId, actorId: h.adminId, category: "site-pass" });
    assert.ok(settings.extraCategories.includes("site-pass"));
    const type = await createQualificationType(db, {
      orgId: h.org.orgId, actorId: h.adminId, code: "SitePass", name: "Site pass", category: "site-pass",
    });
    assert.equal(type.category, "site-pass");
    const listed = await listQualificationTypes(db, { orgId: h.org.orgId, actorId: h.adminId });
    assert.ok(listed.some((t) => t.code === "SitePass"));
  });
});

test("requirements: unreadable subject refused, zero-row delete fails", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const typeId = await seedType(h.org.orgId, h.adminId);
    const ghost = randomUUID();
    for (const kind of ["project", "equipment", "position", "classification"] as const) {
      await assert.rejects(
        setRequirement(db, { orgId: h.org.orgId, actorId: h.adminId, subjectKind: kind, subjectId: ghost, typeId }),
        /not found in this organization or you cannot read it/,
      );
    }
    const projectId = await seedProject(h.org.orgId, "Harbor Bridge");
    const req = await setRequirement(db, {
      orgId: h.org.orgId, actorId: h.adminId, subjectKind: "project", subjectId: projectId, typeId, severity: "block",
    });
    assert.equal(req.subjectName, "Harbor Bridge");
    // Re-declaring edits the window/severity in place (upsert, not duplicate).
    const edited = await setRequirement(db, {
      orgId: h.org.orgId, actorId: h.adminId, subjectKind: "project", subjectId: projectId, typeId, severity: "warn",
    });
    assert.equal(edited.id, req.id);
    assert.equal(edited.severity, "warn");
    const listed = await listRequirements(db, { orgId: h.org.orgId, actorId: h.adminId, subjectKind: "project", subjectId: projectId });
    assert.equal(listed.length, 1);
    await assert.rejects(
      removeRequirement(db, { orgId: h.org.orgId, actorId: h.adminId, requirementId: randomUUID() }),
      /not found in this organization/,
    );
    await removeRequirement(db, { orgId: h.org.orgId, actorId: h.adminId, requirementId: req.id });
    assert.equal(
      (await listRequirements(db, { orgId: h.org.orgId, actorId: h.adminId, subjectKind: "project", subjectId: projectId })).length,
      0,
    );
  });
});

test("dispatch gate: block refuses by name, warn records a warned event", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Gated Hand");
    const typeId = await seedType(h.org.orgId, h.adminId);
    const projectId = await seedProject(h.org.orgId, "North Tower");
    const resourceId = await seedResource(h.org.orgId, projectId, worker.partyId, "Gated Hand");
    const today = await businessToday(h.org.orgId);
    await setRequirement(db, {
      orgId: h.org.orgId, actorId: h.adminId, subjectKind: "project", subjectId: projectId, typeId, severity: "block",
    });
    // No credential held: the gate blocks and names the type.
    const blocked = await gateScheduleAssignment(db, { orgId: h.org.orgId, actorId: h.adminId, resourceId, on: today });
    assert.equal(blocked.gated, true);
    assert.equal(blocked.verdict.ok, false);
    if (blocked.verdict.ok) throw new Error("expected a blocked verdict");
    assert.equal(blocked.verdict.blocking[0]?.reason, "missing");
    await assert.rejects(
      (async () => refuseBlockedDispatch(blocked.verdict, blocked.resourceName))(),
      /cannot be dispatched: missing or unqualified for OSHA 30/,
    );
    // An expired credential still blocks (reason expired).
    const q = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: addDays(today, -400), expiresOn: addDays(today, -1),
    });
    await verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: q.id });
    const expiredGate = await checkAssignment(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      subjectKind: "project", subjectId: projectId, on: today,
    });
    assert.equal(expiredGate.ok, false);
    if (expiredGate.ok) throw new Error("expected a blocked verdict");
    assert.equal(expiredGate.blocking[0]?.reason, "expired");
    // Warn severity lets the assignment through and records the warning
    // against the deficient qualification for display.
    await setRequirement(db, {
      orgId: h.org.orgId, actorId: h.adminId, subjectKind: "project", subjectId: projectId, typeId, severity: "warn",
    });
    const warned = await gateScheduleAssignment(db, { orgId: h.org.orgId, actorId: h.adminId, resourceId, on: today });
    assert.equal(warned.verdict.ok, true);
    if (!warned.verdict.ok) throw new Error("expected a passing verdict");
    assert.equal(warned.verdict.warnings.length, 1);
    await noteWarnedDispatch(db, {
      orgId: h.org.orgId, actorId: h.adminId, warnings: warned.verdict.warnings, context: "schedule assignment",
    });
    const events = await listQualificationEvents(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: q.id });
    assert.ok(events.some((e) => e.kind === "warned" && (e.reason ?? "").startsWith("schedule assignment:")));
    // A verified in-date credential passes clean.
    const fresh = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: today,
    });
    await verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: fresh.id });
    const clean = await checkAssignment(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      subjectKind: "project", subjectId: projectId, on: today,
    });
    assert.equal(clean.ok, true);
    assert.equal(clean.warnings.length, 0);
  });
});

test("dispatch gate: feature-off never calls the gate, resourceless rows pass through", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Bypass Hand");
    const typeId = await seedType(h.org.orgId, h.adminId);
    const projectId = await seedProject(h.org.orgId, "South Pier");
    const resourceId = await seedResource(h.org.orgId, projectId, worker.partyId, "Bypass Hand");
    await setRequirement(db, {
      orgId: h.org.orgId, actorId: h.adminId, subjectKind: "project", subjectId: projectId, typeId, severity: "block",
    });
    await disableFeature(h.org.orgId, "hrmDispatchGating");
    // The double throws if consulted: with the feature off the
    // assignment path must not call the gate at all.
    const result = await gateScheduleAssignment(db, {
      orgId: h.org.orgId,
      actorId: h.adminId,
      resourceId,
      gate: async () => {
        throw new Error("gate consulted while hrmDispatchGating is off");
      },
    });
    assert.equal(result.gated, false);
    assert.equal(result.verdict.ok, true);
    // Equipment-style rows with no party have no person to gate.
    await enableFeatures(h.org.orgId);
    const machineId = await seedResource(h.org.orgId, projectId, null, "Crane 7");
    const machine = await gateScheduleAssignment(db, { orgId: h.org.orgId, actorId: h.adminId, resourceId: machineId });
    assert.equal(machine.gated, false);
    assert.equal(machine.verdict.ok, true);
  });
});

test("alerts: due rows written once, second run changes nothing", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Alert Hand");
    // The holder needs a login for the notice; link the scratch admin to
    // the holder party so both holder and manager paths resolve.
    await db.execute(sql`update users set party_id = ${worker.partyId} where id = ${h.adminId}`);
    const typeId = await seedType(h.org.orgId, h.adminId, { validityMonths: null, renewalLeadDays: 30 });
    const today = await businessToday(h.org.orgId);
    const q = await recordQualification(db, {
      orgId: h.org.orgId, actorId: h.adminId, employmentId: worker.employmentId,
      typeId, issuedOn: addDays(today, -300), expiresOn: addDays(today, 30),
    });
    await verifyQualification(db, { orgId: h.org.orgId, actorId: h.adminId, qualificationId: q.id });
    const first = await runQualificationAlertScan(new Date());
    const mine = first.find((s) => s.orgId === h.org.orgId);
    assert.ok(mine);
    assert.equal(mine.alertsWritten, 1);
    assert.ok(mine.notificationsWritten >= 1);
    const alerts = await listAlerts(db, { orgId: h.org.orgId, actorId: h.adminId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.leadDays, 30);
    assert.ok(alerts[0]?.sentAt);
    const notices = (await db.execute<{ title: string }>(sql`
      select title from notifications where org_id = ${h.org.orgId} and kind = 'hrm_qualification_expiry'
    `)).rows;
    assert.ok(notices.length >= 1);
    assert.ok(notices[0]?.title.includes("OSHA 30"));
    // Second run: idempotent — no new alert rows, no new notices.
    const noticeCount = notices.length;
    const alertCount = alerts.length;
    const second = await runQualificationAlertScan(new Date());
    const mineAgain = second.find((s) => s.orgId === h.org.orgId);
    assert.ok(mineAgain);
    assert.equal(mineAgain.alertsWritten, 0);
    assert.equal(mineAgain.notificationsWritten, 0);
    assert.equal(mineAgain.expiredNoticed, 0);
    assert.equal((await listAlerts(db, { orgId: h.org.orgId, actorId: h.adminId })).length, alertCount);
    assert.equal(
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from notifications
         where org_id = ${h.org.orgId} and kind = 'hrm_qualification_expiry'
      `)).rows[0]?.n,
      String(noticeCount),
    );
  });
});

test("grants, self scope, masking seed and the second-org floor", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const worker = await seedWorker(h.org.orgId, h.org.subsidiaryId, "Scoped Hand");
    const typeId = await seedType(h.org.orgId, h.adminId);
    const today = await businessToday(h.org.orgId);
    // The outsider holds neither grant: reads and writes refuse by name.
    await assert.rejects(
      listQualifications(db, { orgId: h.org.orgId, actorId: h.outsiderId }),
      HrmAuthorizationError,
    );
    await assert.rejects(
      recordQualification(db, {
        orgId: h.org.orgId, actorId: h.outsiderId, employmentId: worker.employmentId, typeId, issuedOn: today,
      }),
      /hrm.certifications.manage/,
    );
    // Feature-off refuses the surface while preserving the rows.
    await disableFeature(h.org.orgId, "hrmCertifications");
    await assert.rejects(
      listQualifications(db, { orgId: h.org.orgId, actorId: h.adminId }),
      /while the hrmCertifications feature is off/,
    );
    await enableFeatures(h.org.orgId);
    // License numbers mask in sandbox clones like candidate PII.
    await seedDefaultMaskingPolicies(h.org.orgId);
    const policies = await loadMaskingPolicies(h.org.orgId);
    assert.equal(policies.get("hrm_worker_qualifications")?.get("identifier"), "null_out");
    // A second org's rows are invisible: zero matched rows, never a leak.
    const other = await createScratchOrg();
    try {
      await enableFeatures(other.orgId);
      const otherAdmin = await createScratchUser(other.orgId, "Other Admin", "other_admin");
      await grantPermissions(other.orgId, otherAdmin, ["hrm.certifications.read", "hrm.certifications.manage"]);
      assert.equal((await listQualifications(db, { orgId: other.orgId, actorId: otherAdmin })).length, 0);
      await assert.rejects(
        setRequirement(db, {
          orgId: other.orgId, actorId: otherAdmin, subjectKind: "project",
          subjectId: randomUUID(), typeId,
        }),
        /not found in this organization or you cannot read it/,
      );
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});
