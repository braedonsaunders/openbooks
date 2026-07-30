/**
 * Remove project/equipment dimensions from synthetic posted tax-control lines.
 *
 * Recoverable input tax, output tax, withholding, and reverse-charge control
 * legs settle with a tax authority; nonrecoverable tax is already capitalized
 * into the originating project detail line. A tax-control line carrying the
 * project therefore overstates project balance-sheet activity.
 *
 * This remediation is deliberately dimension-only:
 * - no document or document-line values change;
 * - no amount, account, currency, period, status, or open-item value changes;
 * - every affected document retains complete before/after transaction evidence;
 * - every changed journal line receives a line-level audit record;
 * - the transaction fails closed if the population changes after preflight.
 *
 * Dry-run by default. Live writes require --apply --production --reason.
 */
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  decidePeriodReopen,
  recloseApprovedReopen,
  requestPeriodReopen,
} from "../close.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  type TransactionAuditSnapshot,
} from "../transaction-audit.ts";
import { resolveTargetOrg } from "./target-org.ts";
import {
  reversalPairViolations,
  type TaxProjectDimensionCandidate as Candidate,
} from "./tax-project-dimension-repair-contract.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const requestedOrgId =
  args.get("org") ?? process.env.TARGET_ORG ?? process.env.SANDBOX_ORG;
if (!requestedOrgId || !/^[0-9a-f-]{36}$/i.test(requestedOrgId)) {
  throw new Error("--org=<uuid> is required");
}
const orgId: string = requestedOrgId;
const outputPath =
  args.get("out") ??
  `/tmp/openbooks-tax-project-dimension-repair-${orgId}-${Date.now()}.json`;
const apply = args.get("apply") === "true";
const reason = args.get("reason")?.trim() ?? "";
const correctionActorId = args.get("actor") ?? "";
const controlledReopen = args.get("controlled-reopen") === "true";
const reopenRequesterId = args.get("reopen-requester") ?? "";
const reopenApproverId = args.get("reopen-approver") ?? "";
if (apply && (reason.length < 10 || reason.length > 500)) {
  throw new Error("--reason must be 10-500 characters when applying");
}
if (apply && !/^[0-9a-f-]{36}$/i.test(correctionActorId)) {
  throw new Error("--actor=<uuid> is required when applying");
}
if (
  apply &&
  controlledReopen &&
  (!/^[0-9a-f-]{36}$/i.test(reopenRequesterId) ||
    !/^[0-9a-f-]{36}$/i.test(reopenApproverId) ||
    reopenRequesterId === reopenApproverId)
) {
  throw new Error(
    "--controlled-reopen requires distinct --reopen-requester and --reopen-approver UUIDs",
  );
}

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function mapCandidate(row: Record<string, unknown>): Candidate {
  return {
    lineId: String(row.line_id),
    entryId: String(row.entry_id),
    entryStatus: String(row.entry_status) as Candidate["entryStatus"],
    reversesEntryId: row.reverses_entry_id
      ? String(row.reverses_entry_id)
      : null,
    reversalEntryId: row.reversal_entry_id
      ? String(row.reversal_entry_id)
      : null,
    reversalEntryCount: Number(row.reversal_entry_count),
    documentId: String(row.document_id),
    documentNumber: String(row.document_number),
    periodId: String(row.period_id),
    bookId: String(row.book_id),
    subsidiaryId: String(row.subsidiary_id),
    projectId: String(row.project_id),
    equipmentUnitId: row.equipment_unit_id
      ? String(row.equipment_unit_id)
      : null,
    taxCodeId: String(row.tax_code_id),
    accountId: String(row.account_id),
    amount: String(row.amount),
    currency: String(row.currency),
    txnAmount: String(row.txn_amount),
    fxRate: String(row.fx_rate),
  };
}

async function candidates(): Promise<Candidate[]> {
  const result = await db.execute(sql`
    select jl.id as line_id,
           je.id as entry_id,
           je.status as entry_status,
           je.reverses_entry_id,
           (
             select reversal.id
               from journal_entries reversal
              where reversal.org_id = je.org_id
                and reversal.reverses_entry_id = je.id
                and reversal.status in ('posted', 'reversed')
              order by reversal.id
              limit 1
           ) as reversal_entry_id,
           (
             select count(*)::int
               from journal_entries reversal
              where reversal.org_id = je.org_id
                and reversal.reverses_entry_id = je.id
                and reversal.status in ('posted', 'reversed')
           ) as reversal_entry_count,
           d.id as document_id,
           d.document_number,
           je.period_id,
           je.book_id,
           jl.subsidiary_id,
           jl.project_id,
           jl.equipment_unit_id,
           jl.tax_code_id,
           jl.account_id,
           jl.amount::text,
           jl.currency,
           jl.txn_amount::text,
           jl.fx_rate::text
      from journal_lines jl
      join journal_entries je
        on je.id = jl.entry_id and je.org_id = jl.org_id
      join documents d
        on d.id = je.source_document_id and d.org_id = je.org_id
     where jl.org_id = ${orgId}
       and je.status in ('posted', 'reversed')
       and jl.tax_code_id is not null
       and jl.project_id is not null
     order by d.id, jl.line_number, jl.id
  `);
  return (result.rows as Array<Record<string, unknown>>).map(mapCandidate);
}

async function protectedFinancialFingerprint(
  documentIds: string[],
  entryIds: string[],
): Promise<string> {
  if (documentIds.length === 0 && entryIds.length === 0) {
    return stableHash([]);
  }
  const documents = documentIds.length
    ? await db.execute(sql`
        select id, kind, status, document_number, document_date::text,
               posting_date::text, posting_period_id, currency, fx_rate::text,
               subtotal::text, tax_total::text, total::text,
               open_balance::text, posted_entry_id, reversal_entry_id,
               voided_at, voided_by, void_reason
          from documents
         where org_id = ${orgId}
           and id = any(${`{${documentIds.join(",")}}`}::uuid[])
         order by id
      `)
    : { rows: [] };
  const ledger = entryIds.length
    ? await db.execute(sql`
        select entry.id as entry_id, entry.status as entry_status,
               entry.book_id, entry.subsidiary_id as entry_subsidiary_id,
               entry.posting_date::text, entry.period_id, entry.origin,
               entry.source_document_id, entry.reverses_entry_id,
               line.id as line_id, line.line_number, line.account_id,
               line.subsidiary_id, line.amount::text, line.currency,
               line.txn_amount::text, line.fx_rate::text, line.party_id,
               line.department_id, line.location_id, line.class_id,
               line.payment_card_id, line.tax_code_id, line.due_date::text,
               line.is_open_item, line.quantity::text, line.unit,
               line.extra_dims, line.custom
          from journal_entries entry
          join journal_lines line
            on line.entry_id = entry.id and line.org_id = entry.org_id
         where entry.org_id = ${orgId}
           and entry.id = any(${`{${entryIds.join(",")}}`}::uuid[])
         order by entry.id, line.id
      `)
    : { rows: [] };
  return stableHash({
    documents: documents.rows,
    ledger: ledger.rows,
  });
}

async function main(): Promise<void> {
  const target = await resolveTargetOrg(orgId);
  if (apply && target.isProduction && !process.argv.includes("--production")) {
    throw new Error("--production is required for a live tenant");
  }
  const planned = await candidates();
  const plannedReversalPairViolations = reversalPairViolations(planned);
  const populationFingerprint = stableHash(planned);
  const documentIds = [...new Set(planned.map((row) => row.documentId))];
  const entryIds = [...new Set(planned.map((row) => row.entryId))];
  const periodIds = [...new Set(planned.map((row) => row.periodId))];

  const [lockResult, actorResult, balanceResult] = await Promise.all([
    periodIds.length
      ? db.execute(sql`
          select pl.period_id, ap.name as period_name, pl.book_id,
                 pl.subsidiary_id, pl.state
            from period_locks pl
            join accounting_periods ap
              on ap.id = pl.period_id and ap.org_id = pl.org_id
           where pl.org_id = ${orgId}
             and pl.period_id = any(${`{${periodIds.join(",")}}`}::uuid[])
             and pl.module = 'gl'
             and pl.state <> 'open'
        `)
      : Promise.resolve({ rows: [] }),
    db.execute(sql`
      select id
        from users
       where org_id = ${orgId}
         and id = ${correctionActorId || null}
         and is_active
    `),
    entryIds.length
      ? db.execute(sql`
          select je.id, sum(jl.amount)::text as balance
            from journal_entries je
            join journal_lines jl
              on jl.entry_id = je.id and jl.org_id = je.org_id
           where je.org_id = ${orgId}
             and je.id = any(${`{${entryIds.join(",")}}`}::uuid[])
           group by je.id
          having sum(jl.amount) <> 0
        `)
      : Promise.resolve({ rows: [] }),
  ]);
  const closedScopes = lockResult.rows as Array<Record<string, unknown>>;
  const unbalancedEntries = balanceResult.rows as Array<
    Record<string, unknown>
  >;
  const blockingCount =
    unbalancedEntries.length +
    plannedReversalPairViolations.length +
    (closedScopes.length > 0 && !controlledReopen ? closedScopes.length : 0);

  let updatedLines = 0;
  let auditedDocuments = 0;
  let auditedLines = 0;
  let afterFingerprint = populationFingerprint;
  const protectedBefore = await protectedFinancialFingerprint(
    documentIds,
    entryIds,
  );
  let protectedAfter = protectedBefore;
  const reopenRequests: Array<{
    requestId: string;
    periodId: string;
    bookId: string;
    subsidiaryId: string | null;
    status: "approved" | "reclosed";
  }> = [];
  if (apply) {
    if (blockingCount > 0) {
      throw new Error(
        `refusing tax dimension repair: ${blockingCount} closed scopes or unbalanced entries`,
      );
    }
    if (closedScopes.length > 0 && !controlledReopen) {
      throw new Error(
        `${closedScopes.length} GL scopes are closed; rerun with an independently approved controlled reopen`,
      );
    }
    try {
      if (controlledReopen) {
        const actors = await db.execute(sql`
          select id
            from users
           where org_id = ${orgId}
             and id = any(${`{${reopenRequesterId},${reopenApproverId}}`}::uuid[])
             and is_active
        `);
        if (actors.rows.length !== 2) {
          throw new Error(
            "controlled reopen actors must be distinct active users in the target organization",
          );
        }
        for (const scope of closedScopes) {
          const periodId = String(scope.period_id);
          const bookId = String(scope.book_id);
          const subsidiaryId = scope.subsidiary_id
            ? String(scope.subsidiary_id)
            : null;
          const requestId = await requestPeriodReopen({
            orgId,
            periodId,
            bookId,
            subsidiaryId: subsidiaryId ?? undefined,
            modules: ["gl"],
            reason: `Controlled tax-control dimension correction: ${reason}`,
            actorId: reopenRequesterId,
          });
          await decidePeriodReopen({
            orgId,
            requestId,
            actorId: reopenApproverId,
            approve: true,
            hours: 1,
          });
          reopenRequests.push({
            requestId,
            periodId,
            bookId,
            subsidiaryId,
            status: "approved",
          });
        }
      }
      const actorId = String(
        (actorResult.rows[0] as { id?: unknown } | undefined)?.id ?? "",
      );
      if (!actorId) {
        throw new Error(
          "correction actor is not an active user in the target organization",
        );
      }
      const requestId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          select pg_advisory_xact_lock(
            hashtextextended(${`tax-project-dimension-repair:${orgId}`}, 0)
          )
        `);
        await tx.execute(sql`set local openbooks.amend = 'on'`);

        const lockedResult = await tx.execute(sql`
        select jl.id as line_id,
               je.id as entry_id,
               je.status as entry_status,
               je.reverses_entry_id,
               (
                 select reversal.id
                   from journal_entries reversal
                  where reversal.org_id = je.org_id
                    and reversal.reverses_entry_id = je.id
                    and reversal.status in ('posted', 'reversed')
                  order by reversal.id
                  limit 1
               ) as reversal_entry_id,
               (
                 select count(*)::int
                   from journal_entries reversal
                  where reversal.org_id = je.org_id
                    and reversal.reverses_entry_id = je.id
                    and reversal.status in ('posted', 'reversed')
               ) as reversal_entry_count,
               d.id as document_id,
               d.document_number,
               je.period_id,
               je.book_id,
               jl.subsidiary_id,
               jl.project_id,
               jl.equipment_unit_id,
               jl.tax_code_id,
               jl.account_id,
               jl.amount::text,
               jl.currency,
               jl.txn_amount::text,
               jl.fx_rate::text
          from journal_lines jl
          join journal_entries je
            on je.id = jl.entry_id and je.org_id = jl.org_id
          join documents d
            on d.id = je.source_document_id and d.org_id = je.org_id
         where jl.org_id = ${orgId}
           and je.status in ('posted', 'reversed')
           and jl.tax_code_id is not null
           and jl.project_id is not null
         order by d.id, jl.line_number, jl.id
         for update of jl, je, d
      `);
        const locked = (
          lockedResult.rows as Array<Record<string, unknown>>
        ).map(mapCandidate);
        if (stableHash(locked) !== populationFingerprint) {
          throw new Error(
            "candidate population changed after preflight; rerun the plan",
          );
        }
        const protectedLockedBefore = await protectedFinancialFingerprint(
          documentIds,
          entryIds,
        );
        if (protectedLockedBefore !== protectedBefore) {
          throw new Error(
            "protected document or GL state changed after preflight; rerun the plan",
          );
        }
        const lockedReversalPairViolations = reversalPairViolations(locked);
        if (lockedReversalPairViolations.length > 0) {
          throw new Error(
            `${lockedReversalPairViolations.length} reversal-pair symmetry violations appeared after preflight`,
          );
        }

        const beforeByDocument = new Map<string, TransactionAuditSnapshot>();
        for (const [index, documentId] of documentIds.entries()) {
          const before = await captureTransactionAuditSnapshot(tx, documentId);
          if (!before) throw new Error(`document ${documentId} disappeared`);
          beforeByDocument.set(documentId, before);
          if ((index + 1) % 50 === 0) {
            console.log(
              `captured before evidence ${index + 1}/${documentIds.length}`,
            );
          }
        }

        const changed = await tx.execute(sql`
        update journal_lines
           set project_id = null,
               equipment_unit_id = null
         where org_id = ${orgId}
           and id = any(${`{${locked.map((row) => row.lineId).join(",")}}`}::uuid[])
           and tax_code_id is not null
           and project_id is not null
        returning id
      `);
        updatedLines = changed.rows.length;
        if (updatedLines !== locked.length) {
          throw new Error(
            `planned ${locked.length} line amendments but updated ${updatedLines}`,
          );
        }

        for (const [index, documentId] of documentIds.entries()) {
          const after = await captureTransactionAuditSnapshot(tx, documentId);
          if (!after) throw new Error(`document ${documentId} disappeared`);
          await recordTransactionAudit(tx, {
            orgId,
            documentId,
            action: "update",
            actorId,
            source: `tax-project-dimension-repair:${requestId}`,
            reason,
            before: beforeByDocument.get(documentId)!,
            after,
          });
          auditedDocuments += 1;
          if ((index + 1) % 50 === 0) {
            console.log(
              `captured after evidence ${index + 1}/${documentIds.length}`,
            );
          }
        }

        const lineAudit = await tx.execute(sql`
        with source as (
          select *
            from jsonb_to_recordset(${JSON.stringify(locked)}::jsonb)
                 as x(
                   "lineId" uuid,
                   "entryId" uuid,
                   "entryStatus" text,
                   "reversesEntryId" uuid,
                   "reversalEntryId" uuid,
                   "reversalEntryCount" integer,
                   "documentId" uuid,
                   "documentNumber" text,
                   "periodId" uuid,
                   "bookId" uuid,
                   "subsidiaryId" uuid,
                   "projectId" uuid,
                   "equipmentUnitId" uuid,
                   "taxCodeId" uuid,
                   "accountId" uuid,
                   amount numeric,
                   currency text,
                   "txnAmount" numeric,
                   "fxRate" numeric
                 )
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${orgId}, 'journal_lines', source."lineId", 'update',
               jsonb_build_object(
                 'mode', 'tax_control_dimension_correction',
                 'reason', ${reason}::text,
                 'documentId', source."documentId",
                 'documentNumber', source."documentNumber",
                 'entryId', source."entryId",
                 'taxCodeId', source."taxCodeId",
                 'before', jsonb_build_object(
                   'projectId', source."projectId",
                   'equipmentUnitId', source."equipmentUnitId",
                   'amount', source.amount,
                   'accountId', source."accountId",
                   'periodId', source."periodId"
                 ),
                 'after', jsonb_build_object(
                   'projectId', null,
                   'equipmentUnitId', null,
                   'amount', source.amount,
                   'accountId', source."accountId",
                   'periodId', source."periodId"
                 ),
                 'financialAmountChanged', false
               ),
               ${actorId}, ${requestId}
          from source
        returning row_id
      `);
        auditedLines = lineAudit.rows.length;
        if (auditedLines !== locked.length) {
          throw new Error(
            `planned ${locked.length} line audits but wrote ${auditedLines}`,
          );
        }

        const imbalances = await tx.execute(sql`
        select je.id, sum(jl.amount)::text as balance
          from journal_entries je
          join journal_lines jl
            on jl.entry_id = je.id and jl.org_id = je.org_id
         where je.org_id = ${orgId}
           and je.id = any(${`{${entryIds.join(",")}}`}::uuid[])
         group by je.id
        having sum(jl.amount) <> 0
      `);
        if (imbalances.rows.length) {
          throw new Error(
            `${imbalances.rows.length} entries became unbalanced during dimension correction`,
          );
        }
        protectedAfter = await protectedFinancialFingerprint(
          documentIds,
          entryIds,
        );
        if (protectedAfter !== protectedBefore) {
          throw new Error(
            "protected document or GL state changed; rolling back",
          );
        }
      });
      const remaining = await candidates();
      afterFingerprint = stableHash(remaining);
      if (remaining.length !== 0) {
        throw new Error(`${remaining.length} project-tagged tax lines remain`);
      }
    } finally {
      const recloseErrors: string[] = [];
      for (const window of [...reopenRequests].reverse()) {
        if (window.status !== "approved") continue;
        try {
          await recloseApprovedReopen({
            orgId,
            requestId: window.requestId,
            actorId: reopenApproverId,
            reason:
              "Targeted tax-control dimension correction completed; immediately restore the approved GL lock.",
          });
          window.status = "reclosed";
        } catch (error) {
          recloseErrors.push(
            `${window.requestId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (recloseErrors.length > 0) {
        throw new Error(
          `failed to restore ${recloseErrors.length} controlled GL locks: ${recloseErrors.join("; ")}`,
        );
      }
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: {
      orgId: target.id,
      name: target.name,
      environment: target.envKind,
    },
    mode: apply ? "apply" : "plan",
    reason: apply ? reason : null,
    population: {
      candidateLines: planned.length,
      journalEntries: entryIds.length,
      sourceDocuments: documentIds.length,
      accountingPeriods: periodIds.length,
      populationFingerprint,
      closedScopes: closedScopes.length,
      unbalancedEntries: unbalancedEntries.length,
      reversalPairs: new Set(
        planned
          .filter(
            (row) => row.reversesEntryId || row.reversalEntryId,
          )
          .map((row) =>
            [row.entryId, row.reversesEntryId ?? row.reversalEntryId!]
              .sort()
              .join(":"),
          ),
      ).size,
      reversalPairViolations: plannedReversalPairViolations.length,
    },
    invariants: {
      documentValuesChanged: 0,
      documentLinesChanged: 0,
      journalAmountsChanged: 0,
      journalAccountsChanged: 0,
      journalPeriodsChanged: 0,
      journalStatusesChanged: 0,
      projectDimensionsCleared: updatedLines,
      equipmentDimensionsCleared: apply
        ? planned.filter((row) => row.equipmentUnitId).length
        : 0,
      auditedDocuments,
      auditedLines,
      remainingCandidates: apply ? 0 : planned.length,
      afterFingerprint,
      protectedFinancialFingerprintBefore: protectedBefore,
      protectedFinancialFingerprintAfter: protectedAfter,
      protectedFinancialFieldsChanged:
        protectedBefore === protectedAfter ? 0 : 1,
      controlledReopenUsed: reopenRequests.length > 0,
      controlledReopenRequests: reopenRequests,
    },
    blocking: {
      closedScopes,
      unbalancedEntries,
      reversalPairViolations: plannedReversalPairViolations,
    },
    blockingCount,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ...report,
        blocking: {
          closedScopes: {
            count: closedScopes.length,
            sample: closedScopes.slice(0, 10),
          },
          unbalancedEntries: {
            count: unbalancedEntries.length,
            sample: unbalancedEntries.slice(0, 10),
          },
          reversalPairViolations: {
            count: plannedReversalPairViolations.length,
            sample: plannedReversalPairViolations.slice(0, 10),
          },
        },
      },
      null,
      2,
    ),
  );
  console.log(`report: ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
