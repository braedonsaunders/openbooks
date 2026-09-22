import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import {
  attachStatementPdf,
  generateStatement,
  listStatements,
  renderStatementPdf,
} from "./index.ts";

/**
 * F13: total-rewards statements honor the employer-subsidiary lens.
 *
 * A restricted HR grant must not expose another subsidiary through list
 * (fenced to no rows), render, generate, or attach (uniform not-found —
 * the same message as an unknown id, never salary content), and a
 * refusal must create zero file/statement side effects. Own-employment
 * self-service rides hrm.self.read; cross-org ids report not-found;
 * unrestricted HR keeps full access. Proofs are read back from storage.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Person ${id.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${id} where id = ${userId} and org_id = ${orgId}`);
  return id;
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function seedEmployment(
  orgId: string,
  subsidiaryId: string,
  workerPartyId?: string,
): Promise<{ employmentId: string; workerPartyId: string }> {
  let party = workerPartyId;
  if (!party) {
    party = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${party}, ${orgId}, 'person', 'Stmt Worker', true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${party}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  return { employmentId, workerPartyId: party };
}

async function seedWage(orgId: string, actorId: string, workerPartyId: string, rate: string): Promise<void> {
  const { withOrgTransaction } = await import("../../platform/db.ts");
  const { supersedeLaborCostRate } = await import("../../projects/labor-cost-rates.ts");
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId,
      scope: { employeePartyId: workerPartyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: "2020-01-01",
      rate,
      currency: "CAD",
      basis: "year",
      annualHours: "2080",
      notes: null,
      reason: "test wage",
    });
  });
}

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function countRows(orgId: string, table: "hrm_comp_statements" | "files"): Promise<number> {
  const target = table === "files" ? sql`files` : sql`hrm_comp_statements`;
  const rows = (await db.execute<{ n: string }>(sql`select count(*)::text as n from ${target} where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.n ?? "0");
}

/** Exact refusal identity (code plus message): missing, foreign, and hidden ids must match fully. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { code: typeof code === "string" ? code : (e as Error).name, message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

type Harness = {
  org: ScratchOrg;
  subB: string;
  hrId: string;
  readerAId: string;
  readerNoneId: string;
  managerAId: string;
  mixedId: string;
  ownerBId: string;
  strangerId: string;
  empA: { employmentId: string; workerPartyId: string };
  empB: { employmentId: string; workerPartyId: string };
  statementAId: string;
  statementBId: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "Stmt HR", "stmt_hr");
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
  await linkPerson(org.orgId, hrId);
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
      from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  const empA = await seedEmployment(org.orgId, org.subsidiaryId);
  const empB = await seedEmployment(org.orgId, subB);
  await seedWage(org.orgId, hrId, empA.workerPartyId, "90000");
  await seedWage(org.orgId, hrId, empB.workerPartyId, "100000");
  const statementA = await generateStatement({
    orgId: org.orgId, actorId: hrId, employmentId: empA.employmentId,
    periodFrom: "2025-01-01", periodTo: "2025-12-31",
  });
  const statementB = await generateStatement({
    orgId: org.orgId, actorId: hrId, employmentId: empB.employmentId,
    periodFrom: "2025-01-01", periodTo: "2025-12-31",
  });
  const readerAId = await createScratchUser(org.orgId, "Stmt Reader A", "stmt_reader_a");
  await scopeRole(org.orgId, "stmt_reader_a", ["hrm.compensation.read"], [org.subsidiaryId]);
  const readerNoneId = await createScratchUser(org.orgId, "Stmt Reader None", "stmt_reader_none");
  await scopeRole(org.orgId, "stmt_reader_none", ["hrm.compensation.read"], []);
  const managerAId = await createScratchUser(org.orgId, "Stmt Manager A", "stmt_manager_a");
  await scopeRole(org.orgId, "stmt_manager_a", ["hrm.compensation.read", "hrm.compensation.manage"], [org.subsidiaryId]);
  // Self-service owner whose own employment sits in subsidiary B —
  // outside readerA's lens on purpose.
  const ownerBId = await createScratchUser(org.orgId, "Stmt Owner B", "stmt_owner_b");
  await grantPermissions(org.orgId, ownerBId, ["hrm.self.read"]);
  const ownerParty = await linkPerson(org.orgId, ownerBId);
  await seedEmployment(org.orgId, subB, ownerParty);
  // Mixed grants: restricted HR read+manage lens over A plus self.read,
  // with the actor's own employment in B. The restricted grants must not
  // remove self-service for the actor's own rows nor widen it to others.
  const mixedId = await createScratchUser(org.orgId, "Stmt Mixed", "stmt_mixed");
  await scopeRole(org.orgId, "stmt_mixed", ["hrm.compensation.read", "hrm.compensation.manage"], [org.subsidiaryId]);
  await grantPermissions(org.orgId, mixedId, ["hrm.self.read"]);
  const mixedParty = await linkPerson(org.orgId, mixedId);
  await seedEmployment(org.orgId, subB, mixedParty);
  const strangerId = await createScratchUser(org.orgId, "Stmt Stranger", "stmt_stranger");
  await linkPerson(org.orgId, strangerId);
  return {
    org, subB, hrId, readerAId, readerNoneId, managerAId, mixedId, ownerBId, strangerId,
    empA, empB, statementAId: statementA.id, statementBId: statementB.id,
  };
}

type OwnEmployment = { employmentId: string; workerPartyId: string };

async function withHarness(
  fn: (h: Harness & { ownB: OwnEmployment; mixedOwn: OwnEmployment }) => Promise<void>,
): Promise<void> {
  if (!DB) return;
  const h = await setupHarness();
  try {
    const ownOf = async (userId: string): Promise<OwnEmployment> => {
      const party = (await db.execute<{ party_id: string }>(sql`select party_id from users where id = ${userId}`))
        .rows[0]!.party_id;
      const own = (await db.execute<{ id: string }>(sql`
        select id from worker_employments where org_id = ${h.org.orgId} and worker_party_id = ${party}`)).rows[0]!;
      return { employmentId: own.id, workerPartyId: party };
    };
    await fn({ ...h, ownB: await ownOf(h.ownerBId), mixedOwn: await ownOf(h.mixedId) });
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

test("F13 restricted HR list fences statements to the subsidiary lens", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const seenA = await listStatements({ orgId: h.org.orgId, actorId: h.readerAId, employmentId: h.empA.employmentId });
    assert.equal(seenA.length, 1);
    assert.equal((seenA[0]!.payload.currentRate as { rate: string }).rate, "90000.0000");
    // Another subsidiary through the same call shape contributes no rows.
    const hiddenB = await listStatements({ orgId: h.org.orgId, actorId: h.readerAId, employmentId: h.empB.employmentId });
    assert.deepEqual(hiddenB, []);
    const noneA = await listStatements({ orgId: h.org.orgId, actorId: h.readerNoneId, employmentId: h.empA.employmentId });
    assert.deepEqual(noneA, []);
    const noneB = await listStatements({ orgId: h.org.orgId, actorId: h.readerNoneId, employmentId: h.empB.employmentId });
    assert.deepEqual(noneB, []);
  });
});

test("F13 restricted HR render/generate/attach refuse as uniform not-found", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const visible = await renderStatementPdf({
      orgId: h.org.orgId, actorId: h.readerAId, statementId: h.statementAId, orgName: "Scratch",
    });
    assert.ok(visible.length > 0);
    // Out-of-scope render refuses with the exact code and message of an
    // unknown statement id — no salary content anywhere in it.
    const unknownStatement = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.readerAId, statementId: randomUUID(), orgName: "Scratch",
    }));
    const hiddenRender = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.readerAId, statementId: h.statementBId, orgName: "Scratch",
    }));
    assert.deepEqual(hiddenRender, unknownStatement);
    assert.equal(hiddenRender.code, "NOT_FOUND");
    assert.ok(!hiddenRender.message.includes("100000"));
    assert.match(hiddenRender.message, /not visible in this organization/);
    // Out-of-scope generate refuses exactly like an unknown employment id.
    const unknownEmployment = await refusalOf(generateStatement({
      orgId: h.org.orgId, actorId: h.managerAId, employmentId: randomUUID(),
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    }));
    const hiddenGenerate = await refusalOf(generateStatement({
      orgId: h.org.orgId, actorId: h.managerAId, employmentId: h.empB.employmentId,
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    }));
    assert.deepEqual(hiddenGenerate, unknownEmployment);
    assert.equal(hiddenGenerate.code, "NOT_FOUND");
    assert.ok(!hiddenGenerate.message.includes("100000"));
    // Out-of-scope attach refuses before any file or statement row exists,
    // with the same identity as a missing statement id.
    const unknownAttach = await refusalOf(attachStatementPdf({
      orgId: h.org.orgId, actorId: h.managerAId, statementId: randomUUID(),
      filename: "statement.pdf", bytes: Buffer.from("%PDF-1.4 probe"),
    }));
    const statementsBefore = await countRows(h.org.orgId, "hrm_comp_statements");
    const filesBefore = await countRows(h.org.orgId, "files");
    const hiddenAttach = await refusalOf(attachStatementPdf({
      orgId: h.org.orgId, actorId: h.managerAId, statementId: h.statementBId,
      filename: "statement.pdf", bytes: Buffer.from("%PDF-1.4 probe"),
    }));
    assert.deepEqual(hiddenAttach, unknownAttach);
    assert.deepEqual(hiddenAttach, unknownStatement);
    assert.equal(await countRows(h.org.orgId, "hrm_comp_statements"), statementsBefore);
    assert.equal(await countRows(h.org.orgId, "files"), filesBefore);
    // The refused generate above likewise wrote no statement row.
    assert.equal(await countRows(h.org.orgId, "hrm_comp_statements"), statementsBefore);
  });
});

test("F13 own-employment self-service rides hrm.self.read", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    // The owner's employment is in subsidiary B, outside readerA's lens —
    // self-service still reaches it through hrm.self.read alone.
    const own = await listStatements({ orgId: h.org.orgId, actorId: h.ownerBId, employmentId: h.ownB.employmentId });
    assert.ok(Array.isArray(own));
    const ownStatement = await generateStatement({
      orgId: h.org.orgId, actorId: h.ownerBId, employmentId: h.ownB.employmentId,
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    });
    const pdf = await renderStatementPdf({
      orgId: h.org.orgId, actorId: h.ownerBId, statementId: ownStatement.id, orgName: "Scratch",
    });
    assert.ok(pdf.length > 0);
    // Someone else's employment stays refused: the list names the remedy
    // (uniform for every employment id through that shape), while single
    // subjects report uniform not-found exactly like a missing id — a
    // self-only actor learns nothing from the difference.
    await assert.rejects(
      listStatements({ orgId: h.org.orgId, actorId: h.ownerBId, employmentId: h.empA.employmentId }),
      /your own employment/,
    );
    const selfMissingEmployment = await refusalOf(generateStatement({
      orgId: h.org.orgId, actorId: h.ownerBId, employmentId: randomUUID(),
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    }));
    const selfForeignEmployment = await refusalOf(generateStatement({
      orgId: h.org.orgId, actorId: h.ownerBId, employmentId: h.empA.employmentId,
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    }));
    assert.deepEqual(selfForeignEmployment, selfMissingEmployment);
    assert.equal(selfForeignEmployment.code, "NOT_FOUND");
    const selfMissingStatement = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.ownerBId, statementId: randomUUID(), orgName: "Scratch",
    }));
    const selfForeignStatement = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.ownerBId, statementId: h.statementAId, orgName: "Scratch",
    }));
    assert.deepEqual(selfForeignStatement, selfMissingStatement);
    assert.equal(selfForeignStatement.code, "NOT_FOUND");
    // Identity alone is not a grant: a stranger with no permission at all
    // cannot list, even though loadOwnEmploymentIds resolves them, and
    // learns nothing from single-subject probes either.
    await assert.rejects(
      listStatements({ orgId: h.org.orgId, actorId: h.strangerId, employmentId: h.empA.employmentId }),
      /your own employment/,
    );
    const strangerMissing = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.strangerId, statementId: randomUUID(), orgName: "Scratch",
    }));
    const strangerForeign = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.strangerId, statementId: h.statementAId, orgName: "Scratch",
    }));
    assert.deepEqual(strangerForeign, strangerMissing);
    assert.equal(strangerForeign.code, "NOT_FOUND");
  });
});

test("F13 mixed grants keep own self-service without widening HR scope", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    // Restricted HR read over A plus self.read, own employment in B: the
    // lens still fences strangers, while the actor's own rows stay
    // reachable through self-service.
    const ownListed = await listStatements({
      orgId: h.org.orgId, actorId: h.mixedId, employmentId: h.mixedOwn.employmentId,
    });
    assert.ok(Array.isArray(ownListed));
    const fencedStranger = await listStatements({
      orgId: h.org.orgId, actorId: h.mixedId, employmentId: h.empB.employmentId,
    });
    assert.deepEqual(fencedStranger, []);
    const ownGenerated = await generateStatement({
      orgId: h.org.orgId, actorId: h.mixedId, employmentId: h.mixedOwn.employmentId,
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    });
    const ownPdf = await renderStatementPdf({
      orgId: h.org.orgId, actorId: h.mixedId, statementId: ownGenerated.id, orgName: "Scratch",
    });
    assert.ok(ownPdf.length > 0);
    // A stranger's statement in B refuses exactly like a missing id.
    const missing = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.mixedId, statementId: randomUUID(), orgName: "Scratch",
    }));
    const hidden = await refusalOf(renderStatementPdf({
      orgId: h.org.orgId, actorId: h.mixedId, statementId: h.statementBId, orgName: "Scratch",
    }));
    assert.deepEqual(hidden, missing);
    assert.equal(hidden.code, "NOT_FOUND");
    const missingGen = await refusalOf(generateStatement({
      orgId: h.org.orgId, actorId: h.mixedId, employmentId: randomUUID(),
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    }));
    const hiddenGen = await refusalOf(generateStatement({
      orgId: h.org.orgId, actorId: h.mixedId, employmentId: h.empB.employmentId,
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    }));
    assert.deepEqual(hiddenGen, missingGen);
    assert.equal(hiddenGen.code, "NOT_FOUND");
  });
});

test("F13 cross-org statement ids report not-found", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const other = await createScratchOrg();
    try {
      const otherReader = await createScratchUser(other.orgId, "Other Reader", "other_reader");
      await grantPermissions(other.orgId, otherReader, ["hrm.compensation.read", "hrm.compensation.manage"]);
      await assert.rejects(
        generateStatement({
          orgId: other.orgId, actorId: otherReader, employmentId: h.empA.employmentId,
          periodFrom: "2025-01-01", periodTo: "2025-12-31",
        }),
        /not visible in this organization/,
      );
      await assert.rejects(
        renderStatementPdf({ orgId: other.orgId, actorId: otherReader, statementId: h.statementAId, orgName: "Scratch" }),
        /not visible in this organization/,
      );
      await assert.rejects(
        attachStatementPdf({
          orgId: other.orgId, actorId: otherReader, statementId: h.statementAId,
          filename: "statement.pdf", bytes: Buffer.from("%PDF-1.4 probe"),
        }),
        /not visible in this organization/,
      );
      const listed = await listStatements({ orgId: other.orgId, actorId: otherReader, employmentId: h.empA.employmentId });
      assert.deepEqual(listed, []);
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});

test("F13 unrestricted HR keeps full cross-subsidiary access", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    for (const emp of [h.empA, h.empB]) {
      const seen = await listStatements({ orgId: h.org.orgId, actorId: h.hrId, employmentId: emp.employmentId });
      assert.equal(seen.length, 1);
      const created = await generateStatement({
        orgId: h.org.orgId, actorId: h.hrId, employmentId: emp.employmentId,
        periodFrom: "2025-01-01", periodTo: "2025-12-31",
      });
      assert.ok(created.id);
    }
    const pdf = await renderStatementPdf({
      orgId: h.org.orgId, actorId: h.hrId, statementId: h.statementBId, orgName: "Scratch",
    });
    assert.ok(pdf.subarray(0, 5).toString("ascii").startsWith("%PDF"));
    const attached = await attachStatementPdf({
      orgId: h.org.orgId, actorId: h.hrId, statementId: h.statementBId,
      filename: "statement.pdf", bytes: Buffer.from("%PDF-1.4 probe"),
    });
    assert.ok(attached.fileId);
    const stored = await listStatements({ orgId: h.org.orgId, actorId: h.hrId, employmentId: h.empB.employmentId });
    assert.ok(stored.some((s) => s.fileId === attached.fileId));
  });
});
