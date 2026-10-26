import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import {
  seedCommittedBenefitRunWithoutStubs,
  seedPayrollBenefitProgram,
  approveBenefitFixture,
} from "../../testing/benefit-fixtures.ts";
import { seedBenefitIncentivePosting } from "../../testing/benefit-incentive-posting.ts";
import { db, pinnedTransactionExecutor, withOrgTransaction } from "../../platform/db.ts";
import { seedComponent } from "../../testing/hrm-harness.ts";
import {
  setupHarness as setupBaseHarness,
  linkPerson,
  seedEmployment,
  seedProject,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { seedApprovalFlow } from "../../testing/fixtures.ts";
import { neg } from "../../money/money.ts";
import { installEngineSeams } from "../../composition/install.ts";
import {
  activateBenefitProgram,
  addProgramMembership,
  getBenefitProgram,
  type CreateBenefitProgramQuery,
} from "./programs.ts";
import { myBenefitStatement } from "./benefit-statement.ts";
import { getBenefitAward, recordSourceEvidencedFirstAward, submitBenefitAward } from "./awards.ts";
import {
  consumeSourceEvidenceAdmission,
  mintSourceEvidenceAdmission,
  type SourceEvidenceAdmissionFacts,
} from "./source-evidence-capability.ts";
import {
  confirmAwardPayrollDelivery,
  createAdjustingAward,
  previewIncentiveSettlement,
  queueAwardForPayRun,
  reconcileIncentivePeriod,
  recordSourceEvidencedFirstIncentiveAward,
  settleIncentivePeriod,
  canonicalSnapshotJson,
  sourceEvidenceNativePreviewDigest,
} from "./settlement.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const SPEC = {
  users: [
    {
      key: "authorId",
      name: "Program Author",
      handle: "source_program_author",
      permissions: [
        "hrm.benefits.read",
        "hrm.benefits.manage",
        "gl.read",
        "ar.read",
        "documents.read",
      ],
      link: true,
    },
    {
      key: "approverId",
      name: "Program Approver",
      handle: "source_program_approver",
      permissions: ["hrm.benefits.read", "hrm.benefits.manage", "gl.read", "documents.read"],
      link: true,
    },
    {
      key: "financeId",
      name: "Program Finance",
      handle: "source_program_finance",
      permissions: ["hrm.benefits.read", "payroll.manage", "gl.read"],
      link: true,
    },
    {
      key: "employeeId",
      name: "Program Employee",
      handle: "source_program_employee",
      permissions: ["hrm.self.read"],
      link: true,
    },
  ],
} as const;

type Harness = Awaited<ReturnType<typeof setupBaseHarness<typeof SPEC>>>;

async function setupHarness() {
  installEngineSeams();
  const h = await setupBaseHarness(SPEC);
  await db.execute(
    sql`update subsidiaries set base_currency='USD' where org_id=${h.org.orgId} and id=${h.org.subsidiaryId}`,
  );
  await seedApprovalFlow(h.org.orgId, {
    subjectKind: "hrm_benefit_award",
    assignees: [{ type: "user", userId: h.approverId }],
    mode: "any",
    preventSelfApproval: true,
  });
  return h;
}

function sourceTest(name: string, body: (h: Harness) => Promise<void>) {
  test(name, { skip: !DB }, () => withHarness(setupHarness, body));
}

async function seedSourceAwardCase(h: Harness, targetHours = "0") {
  const component = await seedComponent(h.org.orgId, {
    kind: "earning",
    code: `SRC_${randomUUID().slice(0, 6)}`,
  });
  const program = await seedPayrollBenefitProgram(
    {
      orgId: h.org.orgId,
      actorId: h.authorId,
      subsidiaryId: h.org.subsidiaryId,
      componentId: component,
      currency: "USD",
    },
    {
      code: `SRC_${randomUUID().slice(0, 6)}`,
      name: "Measured work incentive",
      family: "incentive",
      deliveryMethod: "payroll",
      valuation: "per_unit",
      metric: "approved_hours",
      metricScope: "company",
      allocation: "hours",
      percentRate: null,
      fixedAmount: "2.0000",
      sourceAccountIds: [],
      frequency: "manual",
      periodBasis: "calendar",
      paymentDelayDays: 0,
    },
    { activate: true },
  );
  const targetParty = await linkPerson(h.org.orgId, h.employeeId, "Source-recipient employee");
  const target = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
    workerPartyId: targetParty,
  });
  const contributor = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
    displayName: "Measured contributor",
  });
  await addProgramMembership({
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    employmentId: target.employmentId,
    effectiveFrom: "2026-01-01",
  });
  await addProgramMembership({
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    employmentId: contributor.employmentId,
    effectiveFrom: "2026-01-01",
  });
  for (const [employment, hours, day] of [
    [contributor, "8", "2026-07-13"],
    ...(targetHours === "0" ? [] : ([[target, targetHours, "2026-07-14"]] as const)),
  ] as const) {
    await db.execute(sql`insert into time_entries (id,org_id,employee_party_id,worked_on,hours,status,approved_at)
      values (${randomUUID()},${h.org.orgId},${employment.workerPartyId},${day}::date,${hours},'approved',now())`);
  }
  const native = await reconcileIncentivePeriod({
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    periodFrom: "2026-07-12",
    periodTo: "2026-07-18",
    asOf: "2026-07-31",
  });
  const nativeSnapshot = native.preview?.sourceSnapshot ?? native.nativeMeasureOnly?.sourceSnapshot;
  assert.ok(nativeSnapshot);
  const row = {
    sourceCard: "issued-card-001",
    amount: "32.00",
    currency: "USD",
    earningFrom: "2026-07-12",
    earningTo: "2026-07-18",
    issueDate: "2026-07-22",
  };
  const artifact = await retainRows(h, [row]);
  const current = await getBenefitProgram(db, h.org.orgId, h.authorId, program.id);
  const query = {
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    expectedProgramRevision: current.revision,
    requestKey: randomUUID(),
    employmentId: target.employmentId,
    periodFrom: row.earningFrom,
    periodTo: row.earningTo,
    asOf: "2026-07-31",
    value: row.amount,
    currency: row.currency,
    sourceIssueDate: row.issueDate,
    sourceRowRef: row.sourceCard,
    sourceEvidenceClass: "missing-source-identity" as const,
    sourceArtifacts: [artifact],
    expectedNativePreviewDigest: sourceEvidenceNativePreviewDigest({
      periodFrom: row.earningFrom,
      periodTo: row.earningTo,
      asOf: "2026-07-31",
      nativeSnapshot,
    }),
    mappingAttestation: {
      employmentId: target.employmentId,
      basis:
        "The reviewed retained award row has no employee identity; the authorized source-to-employment crosswalk is recorded in this attestation.",
      reason:
        "I reviewed the original award row and the independent employment crosswalk for this recipient and legal payer.",
      confirmed: true as const,
    },
    reason:
      "Record the issued source obligation because native approved-time identity is absent for this employment and period.",
  };
  return { program, target, contributor, row, artifact, query };
}

async function retainRows(
  h: Harness,
  rows: readonly Record<string, unknown>[],
  filename = "retained-award-rows.json",
  folderOptions: { privateOwnerId?: string; isPrivate?: boolean } = {},
  originalBytes?: { bytes: Buffer; contentType: string },
) {
  const bytes = originalBytes?.bytes ?? Buffer.from(JSON.stringify(rows), "utf8");
  const contentType = originalBytes?.contentType ?? "application/json";
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const row = rows[0]!;
  const fileId = randomUUID();
  const versionId = randomUUID();
  const folderId = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into folders (id,org_id,name,owner_id,is_private,created_by,updated_by)
    values (${folderId},${h.org.orgId},${`source-evidence-${folderId.slice(0, 6)}`},${folderOptions.privateOwnerId ?? null},${folderOptions.isPrivate === true},${h.authorId},${h.authorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files (id,org_id,folder_id,name,file_type,content_type,size_bytes,content_hash,created_by,updated_by)
    values (${fileId},${h.org.orgId},${folderId},${filename},'other',${contentType},${bytes.length},${contentHash},${h.authorId},${h.authorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_versions (id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values (${versionId},${fileId},1,${bytes.length},${contentType},${contentHash},${h.authorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs (version_id,bytes) values (${versionId},${bytes}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${versionId} where org_id=${h.org.orgId} and id=${fileId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return {
    fileId,
    versionId,
    folderId,
    filename,
    contentType,
    sha256: contentHash,
    sizeBytes: bytes.length,
    bytesBase64: bytes.toString("base64"),
    rowPointer: "/0",
    rowSha256: createHash("sha256").update(canonicalSnapshotJson(row), "utf8").digest("hex"),
    row,
    sourceFields: {
      sourceRowRefPointer: "/sourceCard",
      amountPointer: "/amount",
      currencyPointer: "/currency",
      periodFromPointer: "/earningFrom",
      periodToPointer: "/earningTo",
      sourceIssueDatePointer: "/issueDate",
    },
  };
}

async function replaceRetainedJsonBytes(
  h: Harness,
  artifact: Awaited<ReturnType<typeof retainRows>>,
  json: string | Uint8Array,
) {
  const bytes = typeof json === "string" ? Buffer.from(json, "utf8") : Buffer.from(json);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`update file_blobs set bytes=${bytes} where version_id=${artifact.versionId} returning version_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update file_versions set size_bytes=${bytes.length},content_hash=${contentHash}
    where file_id=${artifact.fileId} and id=${artifact.versionId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set size_bytes=${bytes.length},content_hash=${contentHash}
    where org_id=${h.org.orgId} and id=${artifact.fileId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return { ...artifact, sha256: contentHash, sizeBytes: bytes.length };
}

sourceTest(
  "source-evidenced first obligations stay separate, redact to self-service, and use normal payroll lifecycle",
  async (h) => {
    const { program, target, contributor, query } = await seedSourceAwardCase(h);
    const timeRowsBefore = await db.execute(
      sql`select id,employee_party_id,worked_on,hours,status from time_entries
    where org_id=${h.org.orgId} and employee_party_id in (${target.workerPartyId},${contributor.workerPartyId}) order by id`,
      "objects",
    );
    const projectRowsBefore = await db.execute(
      sql`select id from projects where org_id=${h.org.orgId} order by id`,
      "objects",
    );
    const ticketRowsBefore = await db.execute(
      sql`select document_id,foreman_party_id,superintendent_party_id from field_tickets where org_id=${h.org.orgId} order by document_id`,
      "objects",
    );
    const award = await recordSourceEvidencedFirstIncentiveAward(query);
    const awardDto = await getBenefitAward(db, h.org.orgId, h.authorId, award.id);
    assert.equal("sourceSnapshot" in awardDto, false);
    assert.equal(award.value, "32.0000");
    assert.equal(award.status, "draft");
    assert.equal(award.sourceKey?.startsWith("source-first:"), true);
    const retained = (
      await db.execute<{
        source_snapshot: Record<string, unknown>;
        evidence: Record<string, unknown>;
      }>(
        sql`
    select source_snapshot,evidence from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`,
        "objects",
      )
    )[0]!;
    const evidence = retained.source_snapshot.sourceEvidence as Record<string, unknown>;
    assert.equal(retained.source_snapshot.payComponentId, program.payComponentId);
    assert.equal(evidence.sourceEvidenceClass, "missing-source-identity");
    assert.deepEqual(evidence.sourcePolicyEvidence, {
      status: "not-established-by-this-source-recording",
      sourceIssueDate: query.sourceIssueDate,
    });
    assert.equal(evidence.currentProgramRevision, query.expectedProgramRevision);
    assert.equal(
      (evidence.effectivePolicy as Record<string, unknown>).policyRevisionId,
      evidence.effectivePolicyRevisionId,
    );
    assert.equal((evidence.nativeIdentity as Record<string, unknown>).ticketId, null);
    assert.equal((evidence.nativeIdentity as Record<string, unknown>).timeEntryIds, null);
    assert.equal(
      (evidence.missingAnchor as Record<string, unknown>).nativeRecipientState,
      "no-native-recipient-row",
    );
    assert.equal(retained.evidence.sourceIssueDate, "2026-07-22");
    assert.equal("sourceArtifacts" in retained.evidence, false);
    const audit = (
      await db.execute<{
        actor_id: string;
        reason: string;
        source_row_ref: string;
        source_digest: string | null;
      }>(
        sql`
    select actor_id::text as actor_id,changes->>'reason' as reason,
           changes#>>'{after,sourceContext,sourceRowRef}' as source_row_ref,
           changes#>>'{after,sourceContext,nativePreview,digest}' as source_digest
      from audit_log where org_id=${h.org.orgId} and table_name='hrm_benefit_awards' and row_id=${award.id}
       order by at desc,id desc limit 1`,
        "objects",
      )
    )[0]!;
    assert.equal(audit.actor_id, h.authorId);
    assert.equal(audit.reason, query.reason);
    assert.equal(audit.source_row_ref, query.sourceRowRef);
    assert.equal(typeof audit.source_digest, "string");
    assert.equal(
      (
        await db.execute(
          sql`select id from hrm_benefit_award_events where org_id=${h.org.orgId} and award_id=${award.id} and kind='created'`,
          "objects",
        )
      ).length,
      1,
    );
    assert.deepEqual(
      await db.execute(
        sql`select id,employee_party_id,worked_on,hours,status from time_entries
    where org_id=${h.org.orgId} and employee_party_id in (${target.workerPartyId},${contributor.workerPartyId}) order by id`,
        "objects",
      ),
      timeRowsBefore,
    );
    assert.deepEqual(
      await db.execute(
        sql`select id from projects where org_id=${h.org.orgId} order by id`,
        "objects",
      ),
      projectRowsBefore,
    );
    assert.deepEqual(
      await db.execute(
        sql`select document_id,foreman_party_id,superintendent_party_id from field_tickets where org_id=${h.org.orgId} order by document_id`,
        "objects",
      ),
      ticketRowsBefore,
    );

    const reconciliation = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: query.periodFrom,
      periodTo: query.periodTo,
    });
    assert.equal(reconciliation.nativeMeasuredHistoryTotal, "0.0000");
    assert.equal(reconciliation.sourceEvidencedFirstTotal, "32.0000");
    assert.equal(reconciliation.preview?.computation.totalAwarded, "16.0000");
    assert.equal(reconciliation.obligationHistoryMinusCurrentMeasurement, "16.0000");

    const statement = await myBenefitStatement({ orgId: h.org.orgId, actorId: h.employeeId });
    const statementJson = JSON.stringify(statement);
    assert.ok(statementJson.includes("source-evidenced-first-obligation"));
    assert.equal(statementJson.includes(query.sourceRowRef), false);
    assert.equal(statementJson.includes(query.sourceArtifacts[0]!.sha256), false);
    assert.equal(statementJson.includes(query.sourceArtifacts[0]!.bytesBase64), false);
    assert.equal(statementJson.includes(contributor.employmentId), false);

    await submitBenefitAward({ orgId: h.org.orgId, actorId: h.authorId, awardId: award.id });
    await approveBenefitFixture({ orgId: h.org.orgId, actorId: h.approverId, awardId: award.id });
    const runDocumentId = await seedRun(h, target.employmentId, target.workerPartyId);
    const queued = await queueAwardForPayRun({
      orgId: h.org.orgId,
      actorId: h.financeId,
      awardId: award.id,
      runDocumentId,
    });
    await seedCommittedBenefitRunWithoutStubs(h.org.orgId, runDocumentId);
    const stubId = randomUUID();
    await db.execute(sql`insert into pay_stubs
    (id,org_id,pay_run_document_id,employee_party_id,employment_id,province,periods_per_year,pay_date,tax_year,country,country_source,currency_code,gross,net_pay)
    values (${stubId},${h.org.orgId},${runDocumentId},${target.workerPartyId},${target.employmentId},'TX',26,'2026-08-05',2026,'US','calculation','USD',${award.value},${award.value})`);
    const adjustment = (
      await db.execute<{ component_id: string; note: string; amount: string }>(
        sql`
    select component_id::text as component_id,note,amount::text as amount from pay_run_adjustments
    where org_id=${h.org.orgId} and id=${queued.adjustmentId}`,
        "objects",
      )
    )[0]!;
    assert.equal(
      adjustment.component_id,
      program.payComponentId,
      "the native approval and queue path uses the program's configured component",
    );
    await db.execute(sql`insert into pay_stub_lines (org_id,stub_id,component_id,kind,description,amount,payment_kind,created_by,updated_by)
    values (${h.org.orgId},${stubId},${adjustment.component_id},'earning',${adjustment.note},${adjustment.amount},'cash',${h.financeId},${h.financeId})`);
    const delivered = await confirmAwardPayrollDelivery({
      orgId: h.org.orgId,
      actorId: h.financeId,
      awardId: award.id,
      runDocumentId,
      adjustmentId: queued.adjustmentId,
    });
    assert.equal(delivered.status, "delivered");
    const original = (
      await db.execute<{ source_snapshot: unknown; program_snapshot: unknown; value: string }>(
        sql`
    select source_snapshot,program_snapshot,value::text as value from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`,
        "objects",
      )
    )[0]!;
    const correction = await createAdjustingAward({
      orgId: h.org.orgId,
      actorId: h.authorId,
      awardId: award.id,
      correctionId: randomUUID(),
      value: "1.00",
      reason: "Correct the retained source amount after review",
      sourceReference: "retained-source-correction-001",
      periodFrom: query.periodFrom,
      periodTo: query.periodTo,
    });
    assert.equal(correction.adjustsAwardId, award.id);
    assert.equal(correction.status, "draft");
    assert.deepEqual(
      (
        await db.execute(
          sql`select source_snapshot,program_snapshot,value::text as value from hrm_benefit_awards
    where org_id=${h.org.orgId} and id=${award.id}`,
          "objects",
        )
      )[0],
      original,
    );
    const correctedReconciliation = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: query.periodFrom,
      periodTo: query.periodTo,
    });
    assert.equal(correctedReconciliation.sourceEvidencedFirstTotal, "32.0000");
    assert.equal(correctedReconciliation.nativeMeasuredHistoryTotal, "0.0000");
  },
);

sourceTest(
  "source first retries serialize, reject alternate evidence and overlaps, and refuse native-payable recipients",
  async (h) => {
    const { program, target, contributor, row, query } = await seedSourceAwardCase(h);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        expectedProgramRevision: query.expectedProgramRevision + 1,
      }),
      /program revision changed/,
    );
    const [first, replay] = await Promise.all([
      recordSourceEvidencedFirstIncentiveAward(query),
      recordSourceEvidencedFirstIncentiveAward(query),
    ]);
    assert.equal(first.id, replay.id);
    assert.equal(
      (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from hrm_benefit_awards
    where org_id=${h.org.orgId} and source_key like 'source-first:%'`,
          "objects",
        )
      )[0]!.n,
      1,
    );
    await db.execute(sql`insert into time_entries (id,org_id,employee_party_id,worked_on,hours,status,approved_at)
    values (${randomUUID()},${h.org.orgId},${target.workerPartyId},'2026-07-14','4','approved',now())`);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(query),
      /different first obligation/,
    );

    const alternate = await retainRows(h, [row], "alternate-retained-award-rows.json");
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourceArtifacts: [alternate] }),
      /different first obligation/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        reason: "Different source decision reason",
      }),
      /different first obligation/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, actorId: h.approverId }),
      /different first obligation/,
    );

    const overlapRow = {
      ...row,
      sourceCard: "issued-card-overlap",
      earningFrom: "2026-07-16",
      earningTo: "2026-07-20",
      issueDate: "2026-07-25",
    };
    const overlapArtifact = await retainRows(
      h,
      [overlapRow],
      "overlapping-retained-award-rows.json",
    );
    await db.execute(sql`insert into time_entries (id,org_id,employee_party_id,worked_on,hours,status,approved_at)
    values (${randomUUID()},${h.org.orgId},${contributor.workerPartyId},'2026-07-17','2','approved',now())`);
    const overlapPreview = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: overlapRow.earningFrom,
      periodTo: overlapRow.earningTo,
      asOf: query.asOf,
    });
    const overlapSnapshot =
      overlapPreview.preview?.sourceSnapshot ?? overlapPreview.nativeMeasureOnly?.sourceSnapshot;
    assert.ok(overlapSnapshot);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        requestKey: randomUUID(),
        sourceRowRef: overlapRow.sourceCard,
        sourceIssueDate: overlapRow.issueDate,
        periodFrom: overlapRow.earningFrom,
        periodTo: overlapRow.earningTo,
        sourceArtifacts: [overlapArtifact],
        expectedNativePreviewDigest: sourceEvidenceNativePreviewDigest({
          periodFrom: overlapRow.earningFrom,
          periodTo: overlapRow.earningTo,
          asOf: query.asOf,
          nativeSnapshot: overlapSnapshot,
        }),
      }),
      /overlapping the source period/,
    );

    const { query: payableQuery } = await seedSourceAwardCase(h, "4");
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(payableQuery),
      /already has a payable recipient/,
    );
    assert.equal(target.employmentId, query.employmentId);
  },
);

sourceTest(
  "source first admission rejects forged retained facts, foreign actors and cross-entity employments",
  async (h) => {
    const { query, artifact, row } = await seedSourceAwardCase(h);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, actorId: randomUUID() }),
      /permission|actor|authorized|user/i,
    );
    const forgedArtifact = { ...artifact, sha256: "0".repeat(64), bytesBase64: "forged" };
    const nativeRead = await recordSourceEvidencedFirstIncentiveAward({
      ...query,
      sourceArtifacts: [forgedArtifact],
    });
    assert.equal(nativeRead.value, "32.0000");
    const retainedHash = (
      await db.execute<{ content_hash: string }>(
        sql`select content_hash from file_versions
    where file_id=${artifact.fileId} and id=${artifact.versionId}`,
        "objects",
      )
    )[0]!.content_hash;
    assert.equal(
      (
        await db.execute(
          sql`update file_versions set content_hash=${"0".repeat(64)}
    where file_id=${artifact.fileId} and id=${artifact.versionId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(query),
      /native Cabinet bytes do not match/,
    );
    assert.equal(
      (
        await db.execute(
          sql`update file_versions set content_hash=${retainedHash}
    where file_id=${artifact.fileId} and id=${artifact.versionId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        sourceArtifacts: [{ ...artifact, rowPointer: "/1" }],
      }),
      /does not exist|selected retained source field/i,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        sourceArtifacts: [{ ...artifact, versionId: randomUUID() }],
      }),
      /retained Cabinet source file is unavailable/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, value: "31.00" }),
      /differs from the selected retained row/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourceIssueDate: "2026-07-23" }),
      /differs from the selected retained row/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        sourceArtifacts: [{ ...artifact, fileId: randomUUID() }],
      }),
      /Source file is unavailable/,
    );

    await assert.rejects(
      recordSourceEvidencedFirstAward({
        orgId: query.orgId,
        actorId: query.actorId,
        programId: query.programId,
        employmentId: query.employmentId,
        periodFrom: query.periodFrom,
        periodTo: query.periodTo,
        value: query.value,
        currency: query.currency,
        sourceKey: `source-first:${randomUUID()}`,
        sourceEvidenceSnapshot: {
          kind: "source-evidenced-first-incentive-v1",
          sourceEvidence: {
            kind: "source-evidenced-first-incentive-v1",
            sourceEvidenceClass: "missing-source-identity",
            sourceArtifacts: [artifact],
          },
        },
      }),
      /locked native retained-source service/,
    );
    const fabricatedSourceWrite = {
      orgId: query.orgId,
      actorId: query.actorId,
      programId: query.programId,
      employmentId: query.employmentId,
      periodFrom: query.periodFrom,
      periodTo: query.periodTo,
      value: query.value,
      currency: query.currency,
      sourceKey: "source-first:" + randomUUID(),
      sourceEvidenceSnapshot: {
        kind: "source-evidenced-first-incentive-v1",
        sourceEvidence: {
          kind: "source-evidenced-first-incentive-v1",
          sourceEvidenceClass: "missing-source-identity",
          sourceArtifacts: [artifact],
        },
      },
    };
    await assert.rejects(
      recordSourceEvidencedFirstAward({
        ...fabricatedSourceWrite,
        settlementMeasurement: { hours: "999.0000" },
      }),
      /cannot adjust another award or carry fabricated native measurement/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstAward({
        ...fabricatedSourceWrite,
        adjustsAwardId: randomUUID(),
      }),
      /cannot adjust another award or carry fabricated native measurement/,
    );

    const foreignSubsidiaryId = randomUUID();
    assert.equal(
      (
        await db.execute(
          sql`insert into subsidiaries
    (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
    values (${foreignSubsidiaryId},${h.org.orgId},${h.org.subsidiaryId},'Separate legal payer','USD','US','{}'::jsonb,false,true,'{}'::jsonb)
    returning id`,
          "objects",
        )
      ).length,
      1,
    );
    const foreignEmployment = await seedEmployment(h.org.orgId, foreignSubsidiaryId, {
      displayName: "Different legal payer employee",
    });
    const foreignRow = { ...row, sourceCard: "issued-card-foreign-payer" };
    const foreignArtifact = await retainRows(h, [foreignRow], "foreign-payer-retained-award.json");
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        requestKey: randomUUID(),
        employmentId: foreignEmployment.employmentId,
        sourceRowRef: foreignRow.sourceCard,
        sourceArtifacts: [foreignArtifact],
        mappingAttestation: {
          ...query.mappingAttestation,
          employmentId: foreignEmployment.employmentId,
          reason: "Reviewed the selected row and this employment's legal payer before recording.",
        },
      }),
      /different legal entity|legal payer|scope|employment/i,
    );
  },
);

sourceTest(
  "retained financial JSON preserves numeric tokens and rejects duplicate decoded keys",
  async (h) => {
    const { query, row } = await seedSourceAwardCase(h);
    const duplicate = await retainRows(h, [row], "duplicate-retained-row.json");
    const duplicateArtifact = await replaceRetainedJsonBytes(
      h,
      duplicate,
      '[{"sourceCard":"issued-card-duplicate","amount":"32.00","am\\u006funt":"32.00","currency":"USD","earningFrom":"2026-07-12","earningTo":"2026-07-18","issueDate":"2026-07-22"}]',
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourceArtifacts: [duplicateArtifact] }),
      /unique object keys/,
    );

    const numeric = await retainRows(h, [row], "numeric-retained-row.json");
    const numericArtifact = await replaceRetainedJsonBytes(
      h,
      numeric,
      '[{"sourceCard":9007199254740993,"amount":32.000000000000000001,"currency":"USD","earningFrom":"2026-07-12","earningTo":"2026-07-18","issueDate":"2026-07-22"}]',
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        sourceRowRef: "9007199254740993",
        value: "32.00",
        sourceArtifacts: [numericArtifact],
      }),
      /differs from the selected retained row/,
    );

    const invalidUtf8 = await retainRows(h, [row], "invalid-utf8-retained-row.json");
    const invalidUtf8Artifact = await replaceRetainedJsonBytes(
      h,
      invalidUtf8,
      Buffer.from([0x5b, 0xff, 0x5d]),
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        sourceArtifacts: [invalidUtf8Artifact],
      }),
      /valid UTF-8 JSON/,
    );
  },
);

sourceTest(
  "source first rechecks same-organization Cabinet access and refuses revoked grants",
  async (h) => {
    const { query, row } = await seedSourceAwardCase(h);
    const hidden = await retainRows(h, [row], "private-issued-row.json", {
      privateOwnerId: h.approverId,
      isPrivate: true,
    });
    const hiddenQuery = { ...query, sourceRowRef: row.sourceCard, sourceArtifacts: [hidden] };
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(hiddenQuery),
      /unavailable to this operator|accessible Cabinet file/i,
    );

    const revoked = await retainRows(h, [row], "revoked-issued-row.json", {
      privateOwnerId: h.approverId,
      isPrivate: true,
    });
    assert.equal(
      (
        await db.execute(
          sql`insert into resource_grants
    (id,org_id,resource_type,resource_id,principal_type,principal_id,access,created_by,updated_by)
    values (${randomUUID()},${h.org.orgId},'folder',${revoked.folderId},'user',${h.authorId},'viewer',${h.approverId},${h.approverId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`delete from resource_grants
    where org_id=${h.org.orgId} and resource_type='folder' and resource_id=${revoked.folderId}
      and principal_type='user' and principal_id=${h.authorId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourceArtifacts: [revoked] }),
      /unavailable to this operator|accessible Cabinet file/i,
    );
  },
);

sourceTest(
  "source-first admission binds one immutable award to its command transaction and consumes once",
  async (h) => {
    const facts: SourceEvidenceAdmissionFacts = {
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: randomUUID(),
      programRevision: 7,
      employmentId: randomUUID(),
      legalPayerId: h.org.subsidiaryId,
      periodFrom: "2026-07-12",
      periodTo: "2026-07-18",
      currency: "USD",
      value: "32.0000",
      sourceKey: "source-first:admission-test",
      requestKey: randomUUID(),
      sourceEvidenceClass: "source-paid-above-native-measure",
      sourcePaidDate: "2026-07-24",
    };
    const snapshot = {
      kind: "source-evidenced-first-incentive-v1",
      sourceEvidence: { requestKey: facts.requestKey },
    };
    let unconsumed: { token: object; snapshot: Record<string, unknown> } | null = null;
    await withOrgTransaction(h.org.orgId, async () => {
      const executor = pinnedTransactionExecutor();
      assert.ok(executor);
      const admission = mintSourceEvidenceAdmission({ executor, facts, snapshot });
      assert.equal(Object.isFrozen(admission.snapshot), true);
      assert.throws(() => Object.assign(admission.snapshot, { value: "33.0000" }));
      const substitutions: SourceEvidenceAdmissionFacts[] = [
        { ...facts, orgId: randomUUID() },
        { ...facts, actorId: randomUUID() },
        { ...facts, programId: randomUUID() },
        { ...facts, programRevision: facts.programRevision + 1 },
        { ...facts, employmentId: randomUUID() },
        { ...facts, legalPayerId: randomUUID() },
        { ...facts, periodFrom: "2026-07-13" },
        { ...facts, periodTo: "2026-07-19" },
        { ...facts, currency: "CAD" },
        { ...facts, value: "33.0000" },
        { ...facts, sourceKey: "source-first:substituted" },
        { ...facts, requestKey: randomUUID() },
        { ...facts, sourceEvidenceClass: "missing-source-identity" },
        { ...facts, sourcePaidDate: "2026-07-25" },
        { ...facts, sourcePaidDate: null },
      ];
      for (const substitutedFacts of substitutions) {
        await assert.rejects(
          Promise.resolve().then(() =>
            consumeSourceEvidenceAdmission({
              executor,
              token: admission.token,
              facts: substitutedFacts,
              snapshot: admission.snapshot,
            }),
          ),
          /locked native retained-source service/,
        );
      }
      await assert.rejects(
        Promise.resolve().then(() =>
          consumeSourceEvidenceAdmission({
            executor,
            token: admission.token,
            facts,
            snapshot: structuredClone(admission.snapshot),
          }),
        ),
        /locked native retained-source service/,
      );
      assert.deepEqual(
        consumeSourceEvidenceAdmission({
          executor,
          token: admission.token,
          facts,
          snapshot: admission.snapshot,
        }),
        admission.snapshot,
      );
      await assert.rejects(
        Promise.resolve().then(() =>
          consumeSourceEvidenceAdmission({
            executor,
            token: admission.token,
            facts,
            snapshot: admission.snapshot,
          }),
        ),
        /locked native retained-source service/,
      );
      unconsumed = mintSourceEvidenceAdmission({
        executor,
        facts: { ...facts, requestKey: randomUUID() },
        snapshot,
      });
    });
    assert.ok(unconsumed);
    await assert.rejects(
      Promise.resolve().then(() =>
        consumeSourceEvidenceAdmission({
          executor: pinnedTransactionExecutor() ?? db,
          token: unconsumed!.token,
          facts: {
            ...facts,
            requestKey: (unconsumed!.snapshot.sourceEvidence as { requestKey: string }).requestKey,
          },
          snapshot: unconsumed!.snapshot,
        }),
      ),
      /locked native retained-source service/,
    );
  },
);

sourceTest(
  "a native loss cannot use the missing-identity first-obligation exception",
  async (h) => {
    const component = await seedComponent(h.org.orgId, {
      kind: "earning",
      code: `LOSS_${randomUUID().slice(0, 6)}`,
    });
    const program = await seedPayrollBenefitProgram(
      {
        orgId: h.org.orgId,
        actorId: h.authorId,
        subsidiaryId: h.org.subsidiaryId,
        componentId: component,
        currency: "USD",
      },
      {
        code: `LOSS_${randomUUID().slice(0, 6)}`,
        name: "Period profit share",
        family: "incentive",
        deliveryMethod: "payroll",
        valuation: "percent",
        metric: "net_profit",
        metricScope: "company",
        allocation: "equal",
        percentRate: "10",
        fixedAmount: null,
        sourceAccountIds: [h.org.accounts.revenue, h.org.accounts.cogs],
        frequency: "manual",
        periodBasis: "calendar",
      },
      { activate: true },
    );
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
      displayName: "Profit-share recipient",
    });
    await addProgramMembership({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      employmentId: worker.employmentId,
      effectiveFrom: "2026-01-01",
    });
    const current = await getBenefitProgram(db, h.org.orgId, h.authorId, program.id);
    await seedBenefitIncentivePosting(
      h,
      [
        { account: h.org.accounts.revenue, amount: neg("10000") },
        { account: h.org.accounts.bank, amount: "10000.0000" },
      ],
      { date: "2026-07-10" },
    );
    await seedBenefitIncentivePosting(
      h,
      [
        { account: h.org.accounts.cogs, amount: "12000.0000" },
        { account: h.org.accounts.bank, amount: neg("12000") },
      ],
      { date: "2026-07-20" },
    );
    const row = {
      sourceCard: "issued-profit-card-001",
      amount: "1205.77",
      currency: "USD",
      earningFrom: "2026-07-01",
      earningTo: "2026-07-31",
      issueDate: "2026-09-16",
    };
    const artifact = await retainRows(h, [row], "retained-profit-award.json");
    const preview = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: row.earningFrom,
      periodTo: row.earningTo,
      asOf: "2026-07-31",
    });
    const nativeSnapshot =
      preview.preview?.sourceSnapshot ?? preview.nativeMeasureOnly?.sourceSnapshot;
    assert.ok(nativeSnapshot);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        orgId: h.org.orgId,
        actorId: h.authorId,
        programId: program.id,
        expectedProgramRevision: current.revision,
        requestKey: randomUUID(),
        employmentId: worker.employmentId,
        periodFrom: row.earningFrom,
        periodTo: row.earningTo,
        value: row.amount,
        currency: row.currency,
        asOf: "2026-07-31",
        sourceIssueDate: row.issueDate,
        sourceRowRef: row.sourceCard,
        sourceEvidenceClass: "missing-source-identity",
        sourceArtifacts: [artifact],
        expectedNativePreviewDigest: sourceEvidenceNativePreviewDigest({
          periodFrom: row.earningFrom,
          periodTo: row.earningTo,
          asOf: "2026-07-31",
          nativeSnapshot,
        }),
        mappingAttestation: {
          employmentId: worker.employmentId,
          basis:
            "The retained issued row and the reviewed employee employment crosswalk identify this recipient and program payer.",
          reason:
            "I reviewed both retained records and attest the source row maps to this employment and legal payer.",
          confirmed: true,
        },
        reason:
          "The current native period measure is a loss, so this historical obligation needs a separately reviewed source-evidence exception.",
      }),
      /positive native incentive pool|loss or threshold miss/i,
    );
    assert.equal(
      (
        await db.execute(
          sql`select id from hrm_benefit_awards where org_id=${h.org.orgId} and program_id=${program.id}`,
          "objects",
        )
      ).length,
      0,
    );
    const reconciliation = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: row.earningFrom,
      periodTo: row.earningTo,
      asOf: "2026-07-31",
    });
    assert.equal(reconciliation.preview, null);
    assert.ok(
      reconciliation.nativeMeasureOnly && "value" in reconciliation.nativeMeasureOnly.measured,
    );
    assert.equal(reconciliation.nativeMeasureOnly.measured.value, "-2000.0000");
    assert.equal(reconciliation.nativeMeasuredHistoryTotal, "0.0000");
    assert.equal(reconciliation.sourceEvidencedFirstTotal, "0.0000");
    assert.equal(reconciliation.obligationHistoryMinusCurrentMeasurement, "0.0000");
  },
);

sourceTest(
  "source paid above a negative project-margin measure records a draft under normal approval and queue controls",
  async (h) => {
    const { program, target, contributor, lossProjectId, query, native } =
      await seedProjectMarginLossCase(h);
    assert.equal(
      native.preview,
      null,
      "read-only reconciliation returns measure-only for an all-loss project-margin period",
    );
    const measuredSource = native.nativeMeasureOnly?.measured as
      | {
          projects?: readonly { margin: string }[];
          carryForward?: Record<string, string>;
        }
      | undefined;
    assert.equal(measuredSource?.projects?.[0]?.margin, "-2000.0000");
    assert.equal(measuredSource?.carryForward?.[target.employmentId], "-200.0000");
    await assert.rejects(
      settleIncentivePeriod({
        orgId: h.org.orgId,
        actorId: h.authorId,
        programId: program.id,
        periodFrom: query.periodFrom,
        periodTo: query.periodTo,
        asOf: "2026-07-31",
      }),
      /Every recipient nets a project-margin loss/,
      "ordinary native settlement still refuses the all-loss period",
    );

    const award = await recordSourceEvidencedFirstIncentiveAward(query);
    assert.equal(award.status, "draft");
    assert.equal(award.value, "450.2500");
    assert.equal(award.sourceKey?.startsWith("source-first:"), true);
    const retainedRow = (
      await db.execute<{
        source_snapshot: Record<string, unknown>;
        evidence: Record<string, unknown>;
      }>(
        sql`
    select source_snapshot, evidence from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`,
        "objects",
      )
    )[0]!;
    const evidence = retainedRow.source_snapshot.sourceEvidence as Record<string, unknown>;
    assert.equal(evidence.sourceEvidenceClass, "source-paid-above-native-measure");
    assert.equal(evidence.sourcePaidDate, "2026-09-18");
    assert.equal(evidence.nativePaymentClaim, "none-established-by-this-source-recording");
    assert.equal("missingAnchor" in evidence, false);
    const anchor = evidence.nativeMeasureAnchor as Record<string, unknown>;
    assert.deepEqual(anchor.affectedProjectIds, [lossProjectId]);
    assert.equal(anchor.targetCarryForward, "-200.0000");
    assert.equal(anchor.targetShareTotal, "-200.0000");
    const governing = evidence.governingDecision as Record<string, unknown>;
    assert.equal(governing.actorId, h.authorId);
    assert.equal(governing.basis, query.governingDecisionAttestation.basis);
    assert.equal(governing.reason, query.governingDecisionAttestation.reason);
    assert.equal(typeof governing.attestedAt, "string");
    const nativePreview = evidence.nativePreview as Record<string, unknown>;
    assert.equal(nativePreview.digest, query.expectedNativePreviewDigest);
    assert.deepEqual(
      retainedRow.evidence,
      {
        kind: "source-evidenced-first-obligation",
        sourceIssueDate: "2026-09-16",
        sourceEvidenceClass: "source-paid-above-native-measure",
      },
      "recipient-visible evidence stays minimal and carries no paid-date or governing facts",
    );
    const audit = (
      await db.execute<{ paid: string | null; actor: string | null }>(
        sql`
    select changes#>>'{after,sourceContext,sourcePaidDate}' as paid,
           changes#>>'{after,sourceContext,governingDecision,actorId}' as actor
      from audit_log where org_id=${h.org.orgId} and table_name='hrm_benefit_awards' and row_id=${award.id}
     order by at desc, id desc limit 1`,
        "objects",
      )
    )[0]!;
    assert.equal(audit.paid, "2026-09-18");
    assert.equal(audit.actor, h.authorId);

    const statement = await myBenefitStatement({ orgId: h.org.orgId, actorId: h.employeeId });
    const statementJson = JSON.stringify(statement);
    assert.ok(statementJson.includes("source-paid-above-native-measure"));
    assert.equal(statementJson.includes(query.governingDecisionAttestation.basis), false);
    assert.equal(statementJson.includes("2026-09-18"), false);
    assert.equal(statementJson.includes(contributor.employmentId), false);

    await submitBenefitAward({ orgId: h.org.orgId, actorId: h.authorId, awardId: award.id });
    await approveBenefitFixture({ orgId: h.org.orgId, actorId: h.approverId, awardId: award.id });
    const runDocumentId = await seedRun(h, target.employmentId, target.workerPartyId);
    const queued = await queueAwardForPayRun({
      orgId: h.org.orgId,
      actorId: h.financeId,
      awardId: award.id,
      runDocumentId,
    });
    await seedCommittedBenefitRunWithoutStubs(h.org.orgId, runDocumentId);
    const stubId = randomUUID();
    await db.execute(sql`insert into pay_stubs
    (id,org_id,pay_run_document_id,employee_party_id,employment_id,province,periods_per_year,pay_date,tax_year,country,country_source,currency_code,gross,net_pay)
    values (${stubId},${h.org.orgId},${runDocumentId},${target.workerPartyId},${target.employmentId},'TX',26,'2026-08-05',2026,'US','calculation','USD',${award.value},${award.value})`);
    const adjustment = (
      await db.execute<{ component_id: string; note: string; amount: string }>(
        sql`
    select component_id::text as component_id, note, amount::text as amount from pay_run_adjustments
     where org_id=${h.org.orgId} and id=${queued.adjustmentId}`,
        "objects",
      )
    )[0]!;
    assert.equal(adjustment.component_id, program.payComponentId);
    await db.execute(sql`insert into pay_stub_lines (org_id,stub_id,component_id,kind,description,amount,payment_kind,created_by,updated_by)
    values (${h.org.orgId},${stubId},${adjustment.component_id},'earning',${adjustment.note},${adjustment.amount},'cash',${h.financeId},${h.financeId})`);
    const delivered = await confirmAwardPayrollDelivery({
      orgId: h.org.orgId,
      actorId: h.financeId,
      awardId: award.id,
      runDocumentId,
      adjustmentId: queued.adjustmentId,
    });
    assert.equal(delivered.status, "delivered");
    const original = (
      await db.execute(
        sql`select source_snapshot, program_snapshot, value::text as value from hrm_benefit_awards
    where org_id=${h.org.orgId} and id=${award.id}`,
        "objects",
      )
    )[0];
    const correction = await createAdjustingAward({
      orgId: h.org.orgId,
      actorId: h.authorId,
      awardId: award.id,
      correctionId: randomUUID(),
      value: "1.00",
      reason: "Correct the retained source amount after review",
      sourceReference: "retained-margin-correction-001",
      periodFrom: query.periodFrom,
      periodTo: query.periodTo,
    });
    assert.equal(correction.adjustsAwardId, award.id);
    assert.deepEqual(
      (
        await db.execute(
          sql`select source_snapshot, program_snapshot, value::text as value from hrm_benefit_awards
    where org_id=${h.org.orgId} and id=${award.id}`,
          "objects",
        )
      )[0],
      original,
      "adjusting correction leaves the original immutable",
    );
  },
);

sourceTest(
  "original PDF report and paystub facts bind across Cabinet versions under reviewed native payroll currency",
  async (h) => {
    const { query, target, retained, row } = await seedProjectMarginLossCase(h);
    await seedRun(h, target.employmentId, target.workerPartyId);
    const PDFDocument = createRequire(import.meta.url)("pdfkit");
    const pdf = async (text: string): Promise<Buffer> => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];
      const result = new Promise<Buffer>((resolve, reject) => {
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
      });
      doc.text(text);
      doc.end();
      return result;
    };
    const reportBytes = await pdf(
      "Coverage: 2026-07-01 - 2026-07-31\nReport: 2026-09-16\nRecipient Alex Morgan $ 450.25",
    );
    const stubBytes = await pdf(
      "Employee Alex Morgan\nCheque Date: 09/18/2026\nAward current 450.25",
    );
    const report = await retainRows(
      h,
      [{}],
      "original-period-report.pdf",
      {},
      { bytes: reportBytes, contentType: "application/pdf" },
    );
    const stub = await retainRows(
      h,
      [{}],
      "original-paystub.pdf",
      {},
      { bytes: stubBytes, contentType: "application/pdf" },
    );
    const reportArtifact = {
      fileId: report.fileId,
      versionId: report.versionId,
      rowPointer: "",
      pdfSelection: {
        page: 1,
        anchor: "Recipient Alex Morgan $ 450.25",
        fields: {
          value: {
            quote: "Recipient Alex Morgan $ 450.25",
            value: "450.25",
            format: "decimal" as const,
          },
          periodFrom: {
            quote: "Coverage: 2026-07-01 - 2026-07-31",
            value: "2026-07-01",
            format: "iso-date" as const,
          },
          periodTo: {
            quote: "Coverage: 2026-07-01 - 2026-07-31",
            value: "2026-07-31",
            format: "iso-date" as const,
          },
          sourceIssueDate: {
            quote: "Report: 2026-09-16",
            value: "2026-09-16",
            format: "iso-date" as const,
          },
        },
      },
    };
    const stubArtifact = {
      fileId: stub.fileId,
      versionId: stub.versionId,
      rowPointer: "",
      pdfSelection: {
        page: 1,
        anchor: "Employee Alex Morgan",
        fields: {
          sourcePaidDate: {
            quote: "Cheque Date: 09/18/2026",
            value: "09/18/2026",
            format: "us-date" as const,
          },
        },
      },
    };
    const issuedArtifact = {
      fileId: retained.fileId,
      versionId: retained.versionId,
      rowPointer: "/0",
      sourceFields: { sourceRowRefPointer: "/sourceCard", amountPointer: "/amount" },
    };
    const command = {
      ...query,
      sourceArtifacts: [issuedArtifact, reportArtifact, stubArtifact],
      nativeCurrencyBasis: {
        confirmed: true as const,
        reason:
          "Reviewed the single-currency program and employment payroll against both original documents; no printed foreign currency is present.",
      },
    };
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...command, nativeCurrencyBasis: undefined }),
      /bind currency/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...command,
        sourceArtifacts: [
          issuedArtifact,
          reportArtifact,
          {
            ...stubArtifact,
            pdfSelection: { ...stubArtifact.pdfSelection, anchor: "Different employee" },
          },
        ],
      }),
      /occurs once/,
    );
    await db.execute(
      sql`update subsidiaries set base_currency='CAD' where org_id=${h.org.orgId} and id=${h.org.subsidiaryId}`,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(command),
      /matching program and legal-payer currency/,
    );
    await db.execute(
      sql`update subsidiaries set base_currency='USD' where org_id=${h.org.orgId} and id=${h.org.subsidiaryId}`,
    );
    const award = await recordSourceEvidencedFirstIncentiveAward(command);
    assert.equal(award.value, "450.2500");
    assert.equal(award.currency, "USD");
    assert.equal(award.status, "draft");
    assert.equal((await recordSourceEvidencedFirstIncentiveAward(command)).id, award.id);
    const saved = (
      await db.execute<{ source: Record<string, unknown> }>(
        sql`select source_snapshot->'sourceEvidence' as source from hrm_benefit_awards where org_id=${h.org.orgId} and id=${award.id}`,
        "objects",
      )
    )[0]!.source;
    assert.equal(saved.sourcePaidDate, row.paidDate);
    assert.equal(
      (saved.currencyEvidence as Record<string, unknown>).kind,
      "reviewed-native-program-payroll-currency",
    );
    assert.equal(
      (saved.nativeMeasureAnchor as Record<string, unknown>).targetCarryForward,
      "-200.0000",
    );
    const files = saved.sourceArtifacts as { sha256: string; pdfSelection?: { page: number } }[];
    assert.equal(files[1]!.sha256, createHash("sha256").update(reportBytes).digest("hex"));
    assert.equal(files[2]!.sha256, createHash("sha256").update(stubBytes).digest("hex"));
    assert.equal(files[1]!.pdfSelection?.page, 1);
  },
);

sourceTest(
  "retained project-margin carry offsets the next native settlement exactly once",
  async (h) => {
    const { program, target, lossProjectId, query } = await seedProjectMarginLossCase(h);
    await recordSourceEvidencedFirstIncentiveAward(query);
    const augustProjectId = await seedMarginProject(
      h,
      target.workerPartyId,
      "Margin august project",
    );
    await postMargin(h, augustProjectId, "2026-08-10", "20000", "10000");
    const augustPreview = await previewIncentiveSettlement({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: "2026-08-01",
      periodTo: "2026-08-31",
      asOf: "2026-08-31",
    });
    const augustProjects = (
      augustPreview.measured as { projects: readonly { projectId: string }[] }
    ).projects.map((p) => p.projectId);
    assert.deepEqual(
      augustProjects,
      [augustProjectId],
      "the retained loss project is consumed once and never remeasured",
    );
    assert.equal(
      augustPreview.computation.totalAwarded,
      "300.0000",
      "the retained 200 loss carry offsets the 500 native pool",
    );
    const august = await settleIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: "2026-08-01",
      periodTo: "2026-08-31",
      asOf: "2026-08-31",
    });
    assert.deepEqual(
      august.awards.map((a) => a.value),
      ["300.0000"],
    );
    const septemberProjectId = await seedMarginProject(
      h,
      target.workerPartyId,
      "Margin september project",
    );
    await postMargin(h, septemberProjectId, "2026-09-10", "20000", "10000");
    const september = await settleIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
      asOf: "2026-09-30",
    });
    assert.deepEqual(
      september.awards.map((a) => a.value),
      ["500.0000"],
      "the carry does not offset a second native settlement",
    );
    assert.ok(lossProjectId);
  },
);

sourceTest(
  "missing-identity project history does not poison or consume later project-margin settlement",
  async (h) => {
    const program = await seedProjectMarginProgram(h);
    const manager = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
      displayName: "Margin project manager",
    });
    const target = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
      displayName: "Margin member without a project",
    });
    await addProgramMembership({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      employmentId: manager.employmentId,
      effectiveFrom: "2026-01-01",
    });
    await addProgramMembership({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      employmentId: target.employmentId,
      effectiveFrom: "2026-01-01",
    });
    await activateBenefitProgram({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
    });
    const julyProjectId = await seedMarginProject(
      h,
      manager.workerPartyId,
      "Margin july profit project",
    );
    await postMargin(h, julyProjectId, "2026-07-10", "20000", "10000");
    const native = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: "2026-07-01",
      periodTo: "2026-07-31",
      asOf: "2026-07-31",
    });
    assert.equal(native.preview?.computation.totalAwarded, "500.0000");
    const row = {
      sourceCard: "issued-margin-card-missing",
      amount: "25.00",
      currency: "USD",
      earningFrom: "2026-07-01",
      earningTo: "2026-07-31",
      issueDate: "2026-08-05",
    };
    const artifact = await retainRows(h, [row], "retained-margin-missing-rows.json");
    const current = await getBenefitProgram(db, h.org.orgId, h.authorId, program.id);
    await recordSourceEvidencedFirstIncentiveAward({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      expectedProgramRevision: current.revision,
      requestKey: randomUUID(),
      employmentId: target.employmentId,
      periodFrom: row.earningFrom,
      periodTo: row.earningTo,
      asOf: "2026-07-31",
      value: row.amount,
      currency: row.currency,
      sourceIssueDate: row.issueDate,
      sourceRowRef: row.sourceCard,
      sourceEvidenceClass: "missing-source-identity",
      sourceArtifacts: [artifact],
      expectedNativePreviewDigest: sourceEvidenceNativePreviewDigest({
        periodFrom: row.earningFrom,
        periodTo: row.earningTo,
        asOf: "2026-07-31",
        nativeSnapshot: native.preview!.sourceSnapshot,
      }),
      mappingAttestation: {
        employmentId: target.employmentId,
        basis:
          "The reviewed retained margin register and the employment crosswalk identify this recipient and legal payer.",
        reason:
          "I reviewed the retained margin register row and attest it maps to this employment and legal payer.",
        confirmed: true,
      },
      reason:
        "Record the issued source obligation because native source identity is absent for this employment and period.",
    });
    const augustPreview = await previewIncentiveSettlement({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: program.id,
      periodFrom: "2026-08-01",
      periodTo: "2026-08-31",
      asOf: "2026-08-31",
    });
    const augustProjects = (
      augustPreview.measured as { projects: readonly { projectId: string }[] }
    ).projects.map((p) => p.projectId);
    assert.deepEqual(
      augustProjects,
      [julyProjectId],
      "a source row whose employment holds no project share consumes no project",
    );
    assert.equal(
      augustPreview.computation.totalAwarded,
      "500.0000",
      "later native settlement measures normally after source-first history",
    );
  },
);

sourceTest(
  "source-paid-above-native-measure predicate refuses each non-loss and shared shape",
  async (h) => {
    const loss = await seedProjectMarginLossCase(h);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(loss.missingQuery),
      /positive native incentive pool/,
      "the missing-identity class still refuses a native loss",
    );

    const otherManager = await seedProjectMarginLossCase(h, { otherManager: true });
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(otherManager.query),
      /negative project-margin carry-forward for this employment/,
      "an absent target carry refuses",
    );

    const shared = await seedProjectMarginLossCase(h, { sharedRole: true });
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(shared.query),
      /cannot partially consume project/,
      "shared-recipient projects refuse with a governed-review remedy",
    );

    const payable = await seedProjectMarginLossCase(h, { mixedProfit: true });
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...payable.query,
        employmentId: payable.contributor.employmentId,
        mappingAttestation: {
          ...payable.query.mappingAttestation,
          employmentId: payable.contributor.employmentId,
        },
      }),
      /already has a payable recipient/,
      "a native-payable target settles natively instead",
    );

    const component = await seedComponent(h.org.orgId, {
      kind: "earning",
      code: `NP_${randomUUID().slice(0, 6)}`,
    });
    const moneyProgram = await seedPayrollBenefitProgram(
      {
        orgId: h.org.orgId,
        actorId: h.authorId,
        subsidiaryId: h.org.subsidiaryId,
        componentId: component,
        currency: "USD",
      },
      {
        code: `NP_${randomUUID().slice(0, 6)}`,
        name: "Period profit share",
        family: "incentive",
        deliveryMethod: "payroll",
        valuation: "percent",
        metric: "net_profit",
        metricScope: "company",
        allocation: "equal",
        percentRate: "10",
        fixedAmount: null,
        sourceAccountIds: [h.org.accounts.revenue, h.org.accounts.cogs],
        frequency: "manual",
        periodBasis: "calendar",
      },
      { activate: true },
    );
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
      displayName: "Profit-share recipient",
    });
    await addProgramMembership({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: moneyProgram.id,
      employmentId: worker.employmentId,
      effectiveFrom: "2026-01-01",
    });
    await seedBenefitIncentivePosting(
      h,
      [
        { account: h.org.accounts.revenue, amount: neg("10000") },
        { account: h.org.accounts.bank, amount: "10000.0000" },
      ],
      { date: "2026-07-10" },
    );
    await seedBenefitIncentivePosting(
      h,
      [
        { account: h.org.accounts.cogs, amount: "12000.0000" },
        { account: h.org.accounts.bank, amount: neg("12000") },
      ],
      { date: "2026-07-20" },
    );
    const moneyRow = {
      sourceCard: "issued-profit-card-above",
      amount: "300.00",
      currency: "USD",
      earningFrom: "2026-07-01",
      earningTo: "2026-07-31",
      issueDate: "2026-09-16",
      paidDate: "2026-09-18",
    };
    const moneyRetained = await retainRows(h, [moneyRow], "retained-profit-above.json");
    const moneyArtifact = {
      ...moneyRetained,
      sourceFields: { ...moneyRetained.sourceFields, sourcePaidDatePointer: "/paidDate" },
    };
    const moneyNative = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: moneyProgram.id,
      periodFrom: moneyRow.earningFrom,
      periodTo: moneyRow.earningTo,
      asOf: "2026-07-31",
    });
    const moneySnapshot =
      moneyNative.preview?.sourceSnapshot ?? moneyNative.nativeMeasureOnly?.sourceSnapshot;
    assert.ok(moneySnapshot);
    const moneyCurrent = await getBenefitProgram(db, h.org.orgId, h.authorId, moneyProgram.id);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        orgId: h.org.orgId,
        actorId: h.authorId,
        programId: moneyProgram.id,
        expectedProgramRevision: moneyCurrent.revision,
        requestKey: randomUUID(),
        employmentId: worker.employmentId,
        periodFrom: moneyRow.earningFrom,
        periodTo: moneyRow.earningTo,
        asOf: "2026-07-31",
        value: moneyRow.amount,
        currency: moneyRow.currency,
        sourceIssueDate: moneyRow.issueDate,
        sourceRowRef: moneyRow.sourceCard,
        sourceEvidenceClass: "source-paid-above-native-measure",
        sourcePaidDate: moneyRow.paidDate,
        sourceArtifacts: [moneyArtifact],
        expectedNativePreviewDigest: sourceEvidenceNativePreviewDigest({
          periodFrom: moneyRow.earningFrom,
          periodTo: moneyRow.earningTo,
          asOf: "2026-07-31",
          nativeSnapshot: moneySnapshot,
        }),
        mappingAttestation: {
          employmentId: worker.employmentId,
          basis:
            "The reviewed retained register and the employment crosswalk identify this recipient and legal payer.",
          reason:
            "I reviewed the retained register row and attest it maps to this employment and legal payer.",
          confirmed: true,
        },
        governingDecisionAttestation: {
          basis:
            "The recorded program decision for this closed period directs payment of the issued source amount.",
          reason:
            "The source amount was issued for this period under that recorded program decision.",
          confirmed: true,
        },
        reason: "Record the issued source obligation directed above the negative native measure.",
      }),
      /project-margin programs only/,
      "generic money-metric losses are deferred to governed review",
    );
    assert.equal(
      (
        await db.execute(
          sql`select id from hrm_benefit_awards
    where org_id=${h.org.orgId} and source_snapshot#>>'{sourceEvidence,sourceEvidenceClass}' = 'source-paid-above-native-measure'`,
          "objects",
        )
      ).length,
      0,
    );
  },
);

sourceTest(
  "source-paid loss admission preserves other recipients' payable native measures",
  async (h) => {
    const mixed = await seedProjectMarginLossCase(h, { mixedProfit: true });
    const period = {
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: mixed.program.id,
      periodFrom: mixed.query.periodFrom,
      periodTo: mixed.query.periodTo,
      asOf: mixed.query.asOf,
    };
    const before = await reconcileIncentivePeriod(period);
    assert.ok(before.preview);
    const contributorBefore = before.preview.computation.recipients.find(
      (row) => row.employmentId === mixed.contributor.employmentId,
    );
    assert.ok(contributorBefore);
    const award = await recordSourceEvidencedFirstIncentiveAward(mixed.query);
    assert.equal(award.employmentId, mixed.target.employmentId);
    assert.equal(award.value, "450.2500");
    const after = await reconcileIncentivePeriod(period);
    assert.ok(after.preview);
    assert.deepEqual(
      after.preview.computation.recipients.find(
        (row) => row.employmentId === mixed.contributor.employmentId,
      ),
      contributorBefore,
    );
    assert.equal(after.preview.computation.totalAwarded, before.preview.computation.totalAwarded);
  },
);

sourceTest(
  "source-paid-above-native-measure binds paid date, governing decision, replay and ordinary authority",
  async (h) => {
    const { program, query, retained, row } = await seedProjectMarginLossCase(h);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourcePaidDate: "2026-09-19" }),
      /differs from the selected retained row/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourcePaidDate: "2026-02-30" }),
      /civil date/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourceArtifacts: [retained] }),
      /source paid date field/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        governingDecisionAttestation: { ...query.governingDecisionAttestation, basis: "short" },
      }),
      /attest the governing decision/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        governingDecisionAttestation: {
          ...query.governingDecisionAttestation,
          confirmed: false as unknown as true,
        },
      }),
      /attest the governing decision/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstAward({
        orgId: query.orgId,
        actorId: query.actorId,
        programId: query.programId,
        employmentId: query.employmentId,
        periodFrom: query.periodFrom,
        periodTo: query.periodTo,
        value: query.value,
        currency: query.currency,
        sourceKey: `source-first:${randomUUID()}`,
        sourceEvidenceSnapshot: {
          kind: "source-evidenced-first-incentive-v1",
          sourceEvidence: {
            kind: "source-evidenced-first-incentive-v1",
            sourceEvidenceClass: "source-paid-above-native-measure",
            sourcePaidDate: row.paidDate,
            sourceArtifacts: [retained],
          },
        },
      }),
      /locked native retained-source service/,
      "plain JSON cannot mint the above-measure admission",
    );

    const first = await recordSourceEvidencedFirstIncentiveAward(query);
    const replay = await recordSourceEvidencedFirstIncentiveAward(query);
    assert.equal(
      replay.id,
      first.id,
      "exact replay returns the stored row despite a fresh governing-decision stamp",
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        governingDecisionAttestation: {
          ...query.governingDecisionAttestation,
          reason: "A different governing reason for this same retained row and period.",
        },
      }),
      /different first obligation/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, actorId: h.approverId }),
      /different first obligation/,
    );
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({ ...query, sourcePaidDate: "2026-09-20" }),
      /differs from the selected retained row/,
    );

    const overlapRow = { ...row, sourceCard: "issued-margin-card-overlap" };
    const overlapRetained = await retainRows(h, [overlapRow], "retained-margin-overlap.json");
    const overlapArtifact = {
      ...overlapRetained,
      sourceFields: { ...overlapRetained.sourceFields, sourcePaidDatePointer: "/paidDate" },
    };
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        requestKey: randomUUID(),
        sourceRowRef: overlapRow.sourceCard,
        sourceArtifacts: [overlapArtifact],
      }),
      /overlapping the source period/,
    );

    const outsider = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
      displayName: "Non-member recipient",
    });
    const outsiderRow = { ...row, sourceCard: "issued-margin-card-outsider" };
    const outsiderRetained = await retainRows(h, [outsiderRow], "retained-margin-outsider.json");
    const outsiderArtifact = {
      ...outsiderRetained,
      sourceFields: { ...outsiderRetained.sourceFields, sourcePaidDatePointer: "/paidDate" },
    };
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...query,
        requestKey: randomUUID(),
        employmentId: outsider.employmentId,
        sourceRowRef: outsiderRow.sourceCard,
        sourceArtifacts: [outsiderArtifact],
        mappingAttestation: { ...query.mappingAttestation, employmentId: outsider.employmentId },
      }),
      /not an eligible member/,
    );
    assert.ok(program.id);
  },
);

sourceTest(
  "source-paid-above-native-measure retains cap, budget, precision and closed-period refusals",
  async (h) => {
    await assert.rejects(
      seedProjectMarginLossCase(h, { capAmount: "100.0000" }),
      /use project pool caps instead of recipient caps/,
    );
    await assert.rejects(
      seedProjectMarginLossCase(h, { budgetAmount: "100.0000" }),
      /use project pool caps instead of recipient caps/,
    );
    const precise = await seedProjectMarginLossCase(h, { amount: "450.251" });
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward(precise.query),
      /payable precision/,
    );

    const open = await seedProjectMarginLossCase(h);
    const futureRow = {
      ...open.row,
      sourceCard: "issued-margin-card-future",
      earningFrom: "2027-08-01",
      earningTo: "2027-08-31",
    };
    const futureRetained = await retainRows(h, [futureRow], "retained-margin-future.json");
    const futureArtifact = {
      ...futureRetained,
      sourceFields: { ...futureRetained.sourceFields, sourcePaidDatePointer: "/paidDate" },
    };
    const futureNative = await reconcileIncentivePeriod({
      orgId: h.org.orgId,
      actorId: h.authorId,
      programId: open.program.id,
      periodFrom: futureRow.earningFrom,
      periodTo: futureRow.earningTo,
      asOf: "2027-08-31",
    });
    const futureSnapshot =
      futureNative.preview?.sourceSnapshot ?? futureNative.nativeMeasureOnly?.sourceSnapshot;
    assert.ok(futureSnapshot);
    await assert.rejects(
      recordSourceEvidencedFirstIncentiveAward({
        ...open.query,
        requestKey: randomUUID(),
        periodFrom: futureRow.earningFrom,
        periodTo: futureRow.earningTo,
        asOf: "2027-08-31",
        sourceRowRef: futureRow.sourceCard,
        sourceArtifacts: [futureArtifact],
        expectedNativePreviewDigest: sourceEvidenceNativePreviewDigest({
          periodFrom: futureRow.earningFrom,
          periodTo: futureRow.earningTo,
          asOf: "2027-08-31",
          nativeSnapshot: futureSnapshot,
        }),
      }),
      /closed program periods/,
    );
  },
);

async function seedProjectMarginProgram(
  h: Harness,
  terms: Partial<CreateBenefitProgramQuery> = {},
) {
  const component = await seedComponent(h.org.orgId, {
    kind: "earning",
    code: `MGN_${randomUUID().slice(0, 6)}`,
  });
  return seedPayrollBenefitProgram(
    {
      orgId: h.org.orgId,
      actorId: h.authorId,
      subsidiaryId: h.org.subsidiaryId,
      componentId: component,
      currency: "USD",
    },
    {
      code: `MGN_${randomUUID().slice(0, 6)}`,
      name: "Project margin share",
      family: "incentive",
      deliveryMethod: "payroll",
      valuation: "percent",
      metric: "project_margin",
      metricScope: "company",
      allocation: "responsibility",
      percentRate: "5",
      lossPercentRate: "10",
      fixedAmount: null,
      includeOpenCommitments: false,
      sourceAccountIds: [h.org.accounts.revenue, h.org.accounts.cogs],
      frequency: "monthly",
      periodBasis: "calendar",
      paymentDelayDays: 0,
      ...terms,
    },
    { activate: false },
  );
}

async function seedMarginProject(h: Harness, managerPartyId: string, name: string) {
  const projectId = await seedProject(h.org.orgId, name);
  await db.execute(sql`update projects set starts_on='2026-01-01', manager_id=${managerPartyId},
    subsidiary_id=${h.org.subsidiaryId} where org_id=${h.org.orgId} and id=${projectId}`);
  return projectId;
}

async function postMargin(
  h: Harness,
  projectId: string,
  date: string,
  revenue: string,
  cost: string,
) {
  await seedBenefitIncentivePosting(
    h,
    [
      { account: h.org.accounts.revenue, amount: neg(revenue), project: projectId },
      { account: h.org.accounts.bank, amount: revenue },
    ],
    { date, currency: "USD" },
  );
  await seedBenefitIncentivePosting(
    h,
    [
      { account: h.org.accounts.cogs, amount: cost, project: projectId },
      { account: h.org.accounts.bank, amount: neg(cost) },
    ],
    { date, currency: "USD" },
  );
}

async function seedProjectMarginLossCase(
  h: Harness,
  options: {
    amount?: string;
    sharedRole?: boolean;
    mixedProfit?: boolean;
    otherManager?: boolean;
    capAmount?: string;
    budgetAmount?: string;
  } = {},
) {
  const program = await seedProjectMarginProgram(h, {
    ...(options.capAmount === undefined ? {} : { capAmount: options.capAmount }),
    ...(options.budgetAmount === undefined ? {} : { budgetAmount: options.budgetAmount }),
  });
  const targetParty = await linkPerson(h.org.orgId, h.employeeId, "Margin source recipient");
  const target = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
    workerPartyId: targetParty,
  });
  const contributor = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
    displayName: "Margin contributor",
  });
  const role = options.sharedRole ? "crew" : null;
  await addProgramMembership({
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    employmentId: target.employmentId,
    effectiveFrom: "2026-01-01",
    role,
    weight: role ? "1" : null,
  });
  await addProgramMembership({
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    employmentId: contributor.employmentId,
    effectiveFrom: "2026-01-01",
    role,
    weight: role ? "1" : null,
  });
  await activateBenefitProgram({ orgId: h.org.orgId, actorId: h.authorId, programId: program.id });
  const lossProjectId = await seedMarginProject(
    h,
    options.otherManager ? contributor.workerPartyId : target.workerPartyId,
    "Margin loss project",
  );
  await postMargin(h, lossProjectId, "2026-07-10", "10000", "12000");
  let profitProjectId: string | null = null;
  if (options.mixedProfit) {
    profitProjectId = await seedMarginProject(
      h,
      contributor.workerPartyId,
      "Margin profit project",
    );
    await postMargin(h, profitProjectId, "2026-07-12", "20000", "10000");
  }
  const native = await reconcileIncentivePeriod({
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    periodFrom: "2026-07-01",
    periodTo: "2026-07-31",
    asOf: "2026-07-31",
  });
  const nativeSnapshot = native.preview?.sourceSnapshot ?? native.nativeMeasureOnly?.sourceSnapshot;
  assert.ok(nativeSnapshot);
  const row = {
    sourceCard: "issued-margin-card-001",
    amount: options.amount ?? "450.25",
    currency: "USD",
    earningFrom: "2026-07-01",
    earningTo: "2026-07-31",
    issueDate: "2026-09-16",
    paidDate: "2026-09-18",
  };
  const retained = await retainRows(h, [row], "retained-margin-rows.json");
  const artifact = {
    ...retained,
    sourceFields: { ...retained.sourceFields, sourcePaidDatePointer: "/paidDate" },
  };
  const current = await getBenefitProgram(db, h.org.orgId, h.authorId, program.id);
  const common = {
    orgId: h.org.orgId,
    actorId: h.authorId,
    programId: program.id,
    expectedProgramRevision: current.revision,
    requestKey: randomUUID(),
    employmentId: target.employmentId,
    periodFrom: row.earningFrom,
    periodTo: row.earningTo,
    asOf: "2026-07-31",
    value: row.amount,
    currency: row.currency,
    sourceIssueDate: row.issueDate,
    sourceRowRef: row.sourceCard,
    sourceArtifacts: [artifact],
    expectedNativePreviewDigest: sourceEvidenceNativePreviewDigest({
      periodFrom: row.earningFrom,
      periodTo: row.earningTo,
      asOf: "2026-07-31",
      nativeSnapshot,
    }),
    mappingAttestation: {
      employmentId: target.employmentId,
      basis:
        "The reviewed retained margin register and the employment crosswalk identify this recipient and legal payer.",
      reason:
        "I reviewed the retained margin register row and attest it maps to this employment and legal payer.",
      confirmed: true as const,
    },
    reason:
      "Record the issued source obligation that the governing decision directed above the negative native measure.",
  };
  const query = {
    ...common,
    sourceEvidenceClass: "source-paid-above-native-measure" as const,
    sourcePaidDate: row.paidDate,
    governingDecisionAttestation: {
      basis:
        "The recorded program decision for this closed period directs payment of the issued source amount for this employment.",
      reason:
        "The source amount was issued for this period and is recorded above the negative native measure under that decision.",
      confirmed: true as const,
    },
  };
  const missingQuery = { ...common, sourceEvidenceClass: "missing-source-identity" as const };
  return {
    program,
    target,
    contributor,
    lossProjectId,
    profitProjectId,
    row,
    artifact,
    retained,
    query,
    missingQuery,
    native,
  };
}

async function seedRun(h: Harness, employmentId: string, workerPartyId: string) {
  const scheduleId = randomUUID();
  await db.execute(sql`insert into pay_schedules (id,org_id,name,frequency,periods_per_year,anchor_period_end)
    values (${scheduleId},${h.org.orgId},${`Source ${scheduleId.slice(0, 6)}`},'biweekly',26,'2026-07-18')`);
  await db.execute(sql`insert into employee_payroll_profiles (org_id,employee_party_id,employment_id,pay_schedule_id,country,province)
    values (${h.org.orgId},${workerPartyId},${employmentId},${scheduleId},'US','TX')`);
  const documentId = randomUUID();
  await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,document_number,document_date,currency,status,subtotal,tax_total,total)
    values (${documentId},${h.org.orgId},${h.org.subsidiaryId},'pay_run',${`PAY-${documentId.slice(0, 8)}`},'2026-07-18','USD','draft',0,0,0)`);
  await db.execute(sql`insert into pay_runs (document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type)
    values (${documentId},${h.org.orgId},${scheduleId},'2026-07-05','2026-07-18','2026-08-05',2026,'draft','regular')`);
  return documentId;
}
