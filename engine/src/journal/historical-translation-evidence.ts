import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
} from "../platform/financial-changes.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  NativeFileReadRefusal,
  requireNativeFileReadAuthority,
} from "../records/file-read-authority.ts";
import { toUnits } from "../money/money.ts";
import { multiplyDecimal, subtractDecimal } from "../money/exact-decimal.ts";
import {
  HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION,
  HistoricalTranslationEvidenceError,
  assertHistoricalTranslationSource,
  assertHistoricalTranslationCorrectionParent,
  historicalTranslationEvidenceHash,
  readHistoricalTranslationInstruction,
  sumHistoricalTranslationExactAmounts,
  type HistoricalTranslationEvidence,
  type HistoricalTranslationInstruction,
  type HistoricalTranslationSourceFingerprint,
  type RetainedHistoricalTranslationLayer,
  type AppliedHistoricalTranslationParent,
} from "./historical-translation-contract.ts";

export * from "./historical-translation-contract.ts";
type Authority = { orgId: string; actorId: string };
type SourceRow = HistoricalTranslationSourceFingerprint & { accountType: string; status: string };
type BasisRow = {
  id: string;
  changeId: string;
  evidence: HistoricalTranslationEvidence;
  evidenceHash: string;
};

async function loadSource(
  tx: SqlExecutor,
  orgId: string,
  lineId: string,
  lock = true,
): Promise<HistoricalTranslationSourceFingerprint> {
  if (!isUuid(orgId) || !isUuid(lineId)) throw new ScopeNotFoundError();
  const row = (
    await tx.execute<SourceRow>(
      sql`
    select line.org_id as "orgId",line.id as "lineId",line.entry_id as "entryId",entry.book_id as "bookId",
      line.account_id as "accountId",line.subsidiary_id as "subsidiaryId",line.amount::text as amount,
      line.currency as "transactionCurrency",line.txn_amount::text as "transactionAmount",line.fx_rate::text as "transactionRate",
      entry.posting_date::text as "postingDate",entry.origin,entry.reverses_entry_id as "reversesEntryId",
      account.type as "accountType",entry.status
    from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
    join accounts account on account.org_id=line.org_id and account.id=line.account_id
    where line.org_id=${orgId} and line.id=${lineId} ${lock ? sql`for share of line,entry,account` : sql``}
  `,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  if (
    ![row.orgId, row.lineId, row.entryId, row.bookId, row.accountId, row.subsidiaryId].every(isUuid)
  )
    throw new HistoricalTranslationEvidenceError(
      "The physical equity source must retain its exact book, account and legal entity. Review the posted source; current organization defaults cannot supply its historical identity.",
    );
  if (!["posted", "reversed"].includes(row.status) || row.accountType !== "equity")
    throw new HistoricalTranslationEvidenceError(
      "Select a posted physical equity journal line for historical contribution assessment.",
    );
  const { accountType: _accountType, status: _status, ...fingerprint } = row;
  return fingerprint;
}
async function commandAuthority(
  tx: SqlExecutor,
  input: Authority,
  source: HistoricalTranslationSourceFingerprint,
): Promise<void> {
  await lockActorCommandAuthority(tx, input.orgId, input.actorId, source.subsidiaryId, "close.run");
  if (!(await lockAndCheckOrgFeature(tx, input.orgId, "multiCurrency")))
    throw new HistoricalTranslationEvidenceError(
      "Turn on Multi-Currency in Company Settings → Features before assessing foreign historical contributions.",
    );
}
async function lockIdentity(tx: SqlExecutor, orgId: string, lineId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`historical-translation:${orgId}:${lineId}`}))`,
  );
}
async function basisRow(
  tx: SqlExecutor,
  orgId: string,
  lineId: string,
  currency: string,
  lock = true,
): Promise<BasisRow | null> {
  return (
    (
      await tx.execute<BasisRow>(
        sql`select id,change_id as "changeId",evidence,evidence_hash as "evidenceHash"
    from historical_translation_contributions where org_id=${orgId} and source_line_id=${lineId}
      and presentation_currency=${currency} ${lock ? sql`for share` : sql``}`,
        "objects",
      )
    )[0] ?? null
  );
}
async function sourceAuthority(
  tx: SqlExecutor,
  input: Authority,
  instruction: HistoricalTranslationInstruction,
): Promise<void> {
  for (const fileId of [...new Set(instruction.layers.map((layer) => layer.source.fileId))].sort())
    await requireNativeFileReadAuthority(
      { orgId: input.orgId, actorId: input.actorId, fileId },
      tx,
    );
}
async function prepare(
  tx: SqlExecutor,
  input: Authority,
  instruction: HistoricalTranslationInstruction,
  frozenAllocations?: Pick<
    HistoricalTranslationEvidence,
    "translatedAmounts" | "originalLayerStates"
  >,
): Promise<HistoricalTranslationEvidence> {
  await sourceAuthority(tx, input, instruction);
  await lockIdentity(tx, input.orgId, instruction.sourceLineId);
  const source = await loadSource(tx, input.orgId, instruction.sourceLineId);
  await commandAuthority(tx, input, source);
  assertHistoricalTranslationSource(instruction, source);
  if (
    (
      await tx.execute(
        sql`select id from historical_translation_contributions
    where org_id=${input.orgId} and source_line_id=${instruction.sourceLineId}
      and measurement_currency<>${instruction.measurementCurrency} for share`,
        "objects",
      )
    ).length
  )
    throw new HistoricalTranslationEvidenceError(
      "Another applied certificate proves a different measurement currency for this exact source. Preserve the source and review its approved assessment; currencies cannot vary by presentation pair.",
    );
  // Currency references are registered identities; live book and subsidiary
  // policies never determine the documentary historical measurement basis.
  if (
    (
      await tx.execute(
        sql`select code from currencies where code in (${instruction.measurementCurrency},${instruction.presentationCurrency}) for share`,
        "objects",
      )
    ).length !== new Set([instruction.measurementCurrency, instruction.presentationCurrency]).size
  )
    throw new HistoricalTranslationEvidenceError(
      "Choose registered measurement and presentation currencies.",
    );
  const retainedSources: HistoricalTranslationEvidence["retainedSources"] = [];
  for (const layer of instruction.layers) {
    const retained = (
      await tx.execute<{
        versionNumber: number;
        contentHash: string | null;
        fileInactive: boolean;
        folderInactive: boolean;
      }>(
        sql`
      select version.version_number as "versionNumber",version.content_hash as "contentHash",
        file.is_inactive as "fileInactive",folder.is_inactive as "folderInactive"
      from files file join folders folder on folder.org_id=file.org_id and folder.id=file.folder_id
      join file_versions version on version.file_id=file.id
      where file.org_id=${input.orgId} and file.id=${layer.source.fileId} and version.id=${layer.source.versionId}
      for share of file,folder,version
    `,
        "objects",
      )
    )[0];
    if (
      !retained ||
      retained.fileInactive ||
      retained.folderInactive ||
      retained.contentHash !== layer.source.contentHash ||
      !Number.isSafeInteger(retained.versionNumber) ||
      retained.versionNumber < 1
    )
      throw new HistoricalTranslationEvidenceError(
        "Select the available tenant-owned Cabinet version matching the original historical source hash.",
      );
    retainedSources.push({ ...layer.source, versionNumber: retained.versionNumber });
  }
  const evidence: HistoricalTranslationEvidence = {
    instruction,
    sourceFingerprint: source,
    retainedSources,
    translatedAmounts: instruction.layers.map((layer) =>
      multiplyDecimal(layer.amount, layer.rate, 14),
    ),
    originalLayerStates: [],
  };
  if (frozenAllocations) {
    evidence.translatedAmounts = frozenAllocations.translatedAmounts;
    evidence.originalLayerStates = frozenAllocations.originalLayerStates;
  } else await assertCorrectionBindings(tx, input.orgId, evidence);
  return evidence;
}

/** Serialize allocations on immediate parent identities. Descendant
 * corrections never release previously allocated parent capacity. */
async function assertCorrectionBindings(
  tx: SqlExecutor,
  orgId: string,
  evidence: HistoricalTranslationEvidence,
): Promise<void> {
  if (evidence.instruction.kind !== "correction") return;
  for (const id of evidence.instruction.layers.map((layer) => layer.originalLayerId!).sort())
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`historical-translation-layer:${orgId}:${id}`}))`,
    );
  for (const [position, layer] of evidence.instruction.layers.entries()) {
    const original = (
      await tx.execute<AppliedHistoricalTranslationParent>(
        sql`select layer.id,layer.amount::text,layer.rate::text,layer.historical_date::text as "historicalDate",layer.provenance,
      layer.source_file_id as "sourceFileId",layer.source_version_id as "sourceVersionId",layer.source_hash as "sourceHash",
      layer.source_version_number as "sourceVersionNumber",
      basis.book_id as "bookId",basis.account_id as "accountId",basis.subsidiary_id as "subsidiaryId",
      basis.measurement_currency as "measurementCurrency",basis.presentation_currency as "presentationCurrency",
      basis.source_entry_id as "entryId",basis.posting_date::text as "postingDate",basis.kind,
      (select coalesce(sum(abs(correction.amount)),0)::numeric(19,4)::text from historical_translation_layers correction
        where correction.org_id=layer.org_id and correction.original_layer_id=layer.id) as consumed
      from historical_translation_layers layer join historical_translation_contributions basis on basis.org_id=layer.org_id and basis.id=layer.basis_id
      join financial_changes change on change.org_id=basis.org_id and change.id=basis.change_id
      where layer.org_id=${orgId} and layer.id=${layer.originalLayerId} and change.status='applied' for share of layer,basis,change`,
        "objects",
      )
    )[0];
    assertHistoricalTranslationCorrectionParent(
      evidence.instruction,
      evidence.sourceFingerprint,
      layer,
      evidence.retainedSources[position]!.versionNumber,
      original,
    );
    evidence.originalLayerStates.push({
      originalLayerId: layer.originalLayerId!,
      consumedAmount: original.consumed,
    });
  }
}

export async function proposeHistoricalTranslationContribution(
  input: Authority & {
    instruction: unknown;
    reason: string;
    idempotencyKey: string;
  },
): Promise<{ changeId: string }> {
  const instruction = readHistoricalTranslationInstruction(input.instruction);
  return withOrgTransaction(input.orgId, async () => {
    await sourceAuthority(db, input, instruction);
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`financial-change:${input.orgId}:${input.idempotencyKey}`}))`,
    );
    const replay = (
      await db.execute<{ payload: { evidence?: HistoricalTranslationEvidence } }>(
        sql`select payload from financial_changes
      where org_id=${input.orgId} and idempotency_key=${input.idempotencyKey}`,
        "objects",
      )
    )[0]?.payload.evidence;
    const evidence = await prepare(
      db,
      input,
      instruction,
      replay && canonicalJson(replay.instruction) === canonicalJson(instruction)
        ? replay
        : undefined,
    );
    const proposal = {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: evidence.sourceFingerprint.subsidiaryId,
      domain: "consolidation" as const,
      operation: HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION,
      subjectId: instruction.sourceLineId,
      effectiveOn: evidence.sourceFingerprint.postingDate,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      payload: {
        evidence,
        evidenceHash: historicalTranslationEvidenceHash(evidence),
        requiredSubsidiaryIds: [evidence.sourceFingerprint.subsidiaryId],
      },
    };
    const existing = await existingFinancialChange(db, proposal);
    if (existing) return { changeId: existing };
    if (await basisRow(db, input.orgId, instruction.sourceLineId, instruction.presentationCurrency))
      throw new HistoricalTranslationEvidenceError(
        "This source and presentation currency already have an immutable approved basis. Preserve it and correct accounting through governed source reversals.",
      );
    return {
      changeId: await proposeFinancialChange(db, {
        ...proposal,
        beforeState: {
          sourceFingerprint: evidence.sourceFingerprint,
          originalLayerStates: evidence.originalLayerStates,
        },
      }),
    };
  });
}

/** Applying an existing native approval records evidence only. It never edits
 * posted source lines, obtains a decision, or supplies inherited rates. */
export async function applyHistoricalTranslationContribution(
  input: Authority & { changeId: string },
): Promise<{ basisId: string }> {
  if (!isUuid(input.changeId)) throw new ScopeNotFoundError();
  return withOrgTransaction(input.orgId, async () => {
    // Discover the immutable source references without taking a financial
    // record lock. Cabinet authority has the first lock in native commands.
    const candidate = (
      await db.execute<{ evidence: HistoricalTranslationEvidence }>(
        sql`select payload->'evidence' as evidence from financial_changes
      where org_id=${input.orgId} and id=${input.changeId} and domain='consolidation'
        and operation=${HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION}`,
        "objects",
      )
    )[0];
    if (!candidate) throw new ScopeNotFoundError();
    const candidateInstruction = readHistoricalTranslationInstruction(
      candidate.evidence?.instruction,
    );
    await sourceAuthority(db, input, candidateInstruction);
    const change = await loadFinancialChange(db, input.orgId, input.changeId);
    if (
      change.domain !== "consolidation" ||
      change.operation !== HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION
    )
      throw new HistoricalTranslationEvidenceError(
        "Select the historical contribution assessment approved through Accounting event Flows.",
      );
    const frozen = change.payload.evidence as HistoricalTranslationEvidence | undefined;
    const instruction = readHistoricalTranslationInstruction(frozen?.instruction);
    if (canonicalJson(instruction) !== canonicalJson(candidateInstruction))
      throw new HistoricalTranslationEvidenceError(
        "The assessment changed while its source authority was being resolved. Reload the native assessment before applying it.",
      );
    const evidence = await prepare(
      db,
      input,
      instruction,
      change.status === "applied" ? frozen : undefined,
    );
    if (
      canonicalJson(evidence) !== canonicalJson(frozen) ||
      historicalTranslationEvidenceHash(evidence) !== change.payload.evidenceHash
    )
      throw new HistoricalTranslationEvidenceError(
        "The exact source, retained evidence or original allocation state changed after assessment. Reject the stale assessment and prepare a fresh proposal.",
      );
    const existing = await basisRow(
      db,
      input.orgId,
      instruction.sourceLineId,
      instruction.presentationCurrency,
    );
    if (change.status === "applied") {
      if (
        !existing ||
        existing.changeId !== change.id ||
        canonicalJson(existing.evidence) !== canonicalJson(evidence) ||
        existing.evidenceHash !== change.payload.evidenceHash
      )
        throw new HistoricalTranslationEvidenceError(
          "The applied assessment does not resolve to its retained native basis.",
        );
      return { basisId: existing.id };
    }
    assertFinancialChangeApproved(change, {
      domain: "consolidation",
      subjectId: instruction.sourceLineId,
      beforeState: {
        sourceFingerprint: evidence.sourceFingerprint,
        originalLayerStates: evidence.originalLayerStates,
      },
    });
    if (existing)
      throw new HistoricalTranslationEvidenceError(
        "Another approved assessment already owns this source and presentation currency.",
      );
    const basisId = randomUUID(),
      source = evidence.sourceFingerprint;
    const inserted = await db.execute(
      sql`insert into historical_translation_contributions
      (id,org_id,change_id,source_line_id,source_entry_id,book_id,account_id,subsidiary_id,measurement_currency,
       presentation_currency,source_amount,posting_date,kind,evidence,evidence_hash,created_by)
      values(${basisId},${input.orgId},${change.id},${source.lineId},${source.entryId},${source.bookId},${source.accountId},${source.subsidiaryId},
        ${instruction.measurementCurrency},${instruction.presentationCurrency},${source.amount},${source.postingDate},${instruction.kind},
        ${JSON.stringify(evidence)}::jsonb,${historicalTranslationEvidenceHash(evidence)},${input.actorId}) returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new HistoricalTranslationEvidenceError(
        "The approved historical contribution basis was not recorded.",
      );
    for (let position = 0; position < instruction.layers.length; position++) {
      const layer = instruction.layers[position]!,
        retained = evidence.retainedSources[position]!;
      const insertedLayer = await db.execute(
        sql`insert into historical_translation_layers
        (org_id,basis_id,layer_number,amount,translated_amount,rate,historical_date,provenance,source_file_id,source_version_id,source_hash,source_version_number,original_layer_id)
        values(${input.orgId},${basisId},${position + 1},${layer.amount},${evidence.translatedAmounts[position]},${layer.rate},${layer.historicalDate},${layer.provenance},
          ${retained.fileId},${retained.versionId},${retained.contentHash},${retained.versionNumber},${layer.originalLayerId}) returning id`,
        "objects",
      );
      if (insertedLayer.length !== 1)
        throw new HistoricalTranslationEvidenceError(
          "Every approved historical layer must be recorded exactly once.",
        );
    }
    await completeFinancialChange(db, input.orgId, change.id, input.actorId, { basisId });
    return { basisId };
  });
}

export interface ApprovedHistoricalTranslationContribution {
  basisId: string;
  changeId: string;
  evidence: HistoricalTranslationEvidence;
  evidenceHash: string;
  layers: RetainedHistoricalTranslationLayer[];
  /** Exact fourteen-place product sum; round only after report aggregation. */
  translatedAmount: string;
}
/** Internal report reader: caller owns the organization-scoped transaction
 * and its entity authorization. Drafts and merely approved proposals are
 * never a translation basis. Documentary measurement identity requires an
 * applied certificate for this exact physical source. */
export async function readHistoricalTranslationContribution(
  tx: SqlExecutor,
  args: {
    orgId: string;
    sourceLineId: string;
    presentationCurrency: string;
    measurementCurrency?: string;
    expectedSource?: HistoricalTranslationSourceFingerprint;
  },
): Promise<
  ApprovedHistoricalTranslationContribution & {
    identity?: true;
    sourceFingerprint?: HistoricalTranslationSourceFingerprint;
  }
> {
  if (!/^[A-Z]{3}$/.test(args.presentationCurrency))
    throw new HistoricalTranslationEvidenceError("Select a registered presentation currency.");
  const source = await loadSource(tx, args.orgId, args.sourceLineId, false);
  if (args.expectedSource && canonicalJson(source) !== canonicalJson(args.expectedSource))
    throw new HistoricalTranslationEvidenceError(
      "The report source changed; reload the source transaction snapshot.",
    );
  const basis =
    (await basisRow(tx, args.orgId, args.sourceLineId, args.presentationCurrency, false)) ??
    (
      await tx.execute<BasisRow>(
        sql`select id,change_id as "changeId",evidence,evidence_hash as "evidenceHash"
      from historical_translation_contributions where org_id=${args.orgId} and source_line_id=${args.sourceLineId}
        and measurement_currency=${args.presentationCurrency} order by id limit 1`,
        "objects",
      )
    )[0] ??
    null;
  if (!basis)
    throw new HistoricalTranslationEvidenceError(
      `Journal line ${args.sourceLineId} has no approved historical contribution basis for ${args.presentationCurrency}. Open its Journal entry → Historical translation tab, retain the exact original source and genuine layers, obtain an Accounting event approval, then Apply the assessment.`,
      source.entryId,
      source.lineId,
    );
  const change = (
    await tx.execute<{ status: string; result: { basisId?: string } | null }>(
      sql`select status,result from financial_changes
    where org_id=${args.orgId} and id=${basis.changeId} and domain='consolidation' and operation=${HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION}`,
      "objects",
    )
  )[0];
  if (
    change?.status !== "applied" ||
    change.result?.basisId !== basis.id ||
    canonicalJson(source) !== canonicalJson(basis.evidence.sourceFingerprint) ||
    historicalTranslationEvidenceHash(basis.evidence) !== basis.evidenceHash ||
    (args.measurementCurrency !== undefined &&
      args.measurementCurrency !== basis.evidence.instruction.measurementCurrency)
  )
    throw new HistoricalTranslationEvidenceError(
      "The historical contribution basis does not match the applied approval and exact physical source. Review its retained assessment.",
    );
  const instruction = readHistoricalTranslationInstruction(basis.evidence.instruction);
  assertHistoricalTranslationSource(instruction, source);
  const layers = await tx.execute<RetainedHistoricalTranslationLayer>(
    sql`select id,amount::text,translated_amount::text as "translatedAmount",rate::text,historical_date::text as "historicalDate",provenance,
    jsonb_build_object('fileId',source_file_id::text,'versionId',source_version_id::text,'contentHash',source_hash) as source,
    source_version_number as "versionNumber",original_layer_id as "originalLayerId"
    from historical_translation_layers where org_id=${args.orgId} and basis_id=${basis.id} order by layer_number`,
    "objects",
  );
  if (
    layers.length !== instruction.layers.length ||
    layers.some((layer, i) => {
      const { id: _id, versionNumber, translatedAmount, ...physical } = layer;
      return (
        canonicalJson(physical) !== canonicalJson(instruction.layers[i]) ||
        versionNumber !== basis.evidence.retainedSources[i]?.versionNumber ||
        translatedAmount !== basis.evidence.translatedAmounts[i]
      );
    })
  )
    throw new HistoricalTranslationEvidenceError(
      "The approved contribution layer composition is incomplete or differs from its retained evidence.",
    );
  const applied = {
    basisId: basis.id,
    changeId: basis.changeId,
    evidence: basis.evidence,
    evidenceHash: basis.evidenceHash,
    layers,
  };
  if (instruction.measurementCurrency === args.presentationCurrency)
    return {
      ...applied,
      identity: true,
      translatedAmount: source.amount,
      sourceFingerprint: source,
    };
  return {
    ...applied,
    translatedAmount: sumHistoricalTranslationExactAmounts(
      layers.map((layer) => layer.translatedAmount),
    ),
  };
}

export interface HistoricalTranslationAuthoringContext {
  source: HistoricalTranslationSourceFingerprint;
  currencies: string[];
  certificates: ApprovedHistoricalTranslationContribution[];
  proposals: Array<{
    changeId: string;
    status: string;
    reason: string;
    evidence: HistoricalTranslationEvidence;
  }>;
  originalLayers: Array<
    RetainedHistoricalTranslationLayer & {
      sourceLineId: string;
      entryId: string;
      measurementCurrency: string;
      presentationCurrency: string;
      remainingAmount: string;
    }
  >;
}

/** Read the source-authoring workspace under the same native actor, entity
 * and Cabinet authority as its commands. Protected source references are
 * never projected through a generic query or an inferred viewer grant. */
export async function readHistoricalTranslationAuthoringContext(
  input: Authority & {
    sourceLineId: string;
  },
): Promise<HistoricalTranslationAuthoringContext> {
  return withOrgTransaction(input.orgId, async () => {
    const candidate = await loadSource(db, input.orgId, input.sourceLineId, false);
    const proposals = await db.execute<HistoricalTranslationAuthoringContext["proposals"][number]>(
      sql`
      select id as "changeId",status,reason,payload->'evidence' as evidence from financial_changes
      where org_id=${input.orgId} and domain='consolidation'
        and operation=${HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION} and subject_id=${input.sourceLineId}
      order by created_at,id`,
      "objects",
    );
    const originalBases = await db.execute<{
      sourceLineId: string;
      presentationCurrency: string;
      evidence: HistoricalTranslationEvidence;
    }>(
      sql`
      select basis.source_line_id as "sourceLineId",basis.presentation_currency as "presentationCurrency",basis.evidence
      from historical_translation_contributions basis
      join financial_changes change on change.org_id=basis.org_id and change.id=basis.change_id
      where basis.org_id=${input.orgId} and basis.book_id=${candidate.bookId} and basis.account_id=${candidate.accountId}
        and basis.subsidiary_id=${candidate.subsidiaryId} and change.status='applied'
        and basis.posting_date<=${candidate.postingDate}::date
        and (${candidate.reversesEntryId}::uuid is null or basis.source_entry_id=${candidate.reversesEntryId}::uuid)
        and sign(basis.source_amount)<>sign(${candidate.amount}::numeric)
      order by basis.id`,
      "objects",
    );
    // Resolve Cabinet fences before taking any financial source or request
    // locks, matching the proposal, approval and application lock order.
    const fileIds = new Set<string>();
    for (const evidence of proposals.map((row) => row.evidence)) {
      for (const layer of readHistoricalTranslationInstruction(evidence?.instruction).layers)
        fileIds.add(layer.source.fileId);
    }
    for (const fileId of [...fileIds].sort())
      await requireNativeFileReadAuthority({ ...input, fileId }, db);
    const accessibleOriginalBases: typeof originalBases = [];
    for (const basis of originalBases) {
      try {
        await sourceAuthority(
          db,
          input,
          readHistoricalTranslationInstruction(basis.evidence.instruction),
        );
        accessibleOriginalBases.push(basis);
      } catch (error) {
        // Optional originals never disclose protected provenance or prevent
        // authoring an assessment against an independently accessible source.
        if (!(error instanceof NativeFileReadRefusal)) throw error;
      }
    }
    const source = await loadSource(db, input.orgId, input.sourceLineId);
    await commandAuthority(db, input, source);
    if (canonicalJson(source) !== canonicalJson(candidate))
      throw new HistoricalTranslationEvidenceError(
        "The source changed while its workspace was opening. Reload the posted journal before authoring its assessment.",
      );
    const certificates: ApprovedHistoricalTranslationContribution[] = [];
    const currencies = (
      await db.execute<{ code: string }>(sql`select code from currencies order by code`, "objects")
    ).map((row) => row.code);
    const existing = await db.execute<{ presentationCurrency: string }>(
      sql`
      select presentation_currency as "presentationCurrency" from historical_translation_contributions
      where org_id=${input.orgId} and source_line_id=${input.sourceLineId} order by presentation_currency`,
      "objects",
    );
    for (const row of existing) {
      const certificate = await readHistoricalTranslationContribution(db, {
        orgId: input.orgId,
        sourceLineId: input.sourceLineId,
        presentationCurrency: row.presentationCurrency,
        expectedSource: source,
      });
      certificates.push(certificate);
    }
    const originalLayers: HistoricalTranslationAuthoringContext["originalLayers"] = [];
    for (const row of accessibleOriginalBases) {
      const certificate = await readHistoricalTranslationContribution(db, {
        orgId: input.orgId,
        sourceLineId: row.sourceLineId,
        presentationCurrency: row.presentationCurrency,
      });
      for (const layer of certificate.layers) {
        const consumed = (
          await db.execute<{ amount: string }>(
            sql`
          select coalesce(sum(abs(amount)),0)::numeric(19,4)::text as amount from historical_translation_layers
          where org_id=${input.orgId} and original_layer_id=${layer.id}`,
            "objects",
          )
        )[0]?.amount;
        if (consumed === undefined)
          throw new HistoricalTranslationEvidenceError(
            "The applied parent allocation could not be read. Reload its approved source.",
          );
        const magnitude = layer.amount.startsWith("-") ? layer.amount.slice(1) : layer.amount;
        const remainingAmount = subtractDecimal(magnitude, consumed);
        if (toUnits(remainingAmount) === 0n) continue;
        if (toUnits(remainingAmount) < 0n)
          throw new HistoricalTranslationEvidenceError(
            "The applied parent's retained corrections exceed its amount. Review the approved allocation history.",
          );
        originalLayers.push({
          ...layer,
          sourceLineId: row.sourceLineId,
          entryId: certificate.evidence.sourceFingerprint.entryId,
          measurementCurrency: certificate.evidence.instruction.measurementCurrency,
          presentationCurrency: certificate.evidence.instruction.presentationCurrency,
          remainingAmount,
        });
      }
    }
    return { source, currencies, certificates, proposals, originalLayers };
  });
}
