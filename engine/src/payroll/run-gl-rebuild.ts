import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { isDocumentRevisionToken } from "../records/revision.ts";
import { add, cmp, neg, normalizeMoney } from "../money/money.ts";
import { canonicalJson } from "./run-calculation-evidence.ts";
import { PayrollError } from "./error.ts";
import { payrollSubsidiaryInScope, type PayrollSubsidiaryScope } from "./scope.ts";
import {
  payRunGlCodingKey,
  payRunGlLegCustom,
  payRunGlLegs,
  type EntitlementReliefLine,
  type PayRunGlLeg,
  type PayRunGlLegKind,
  type PayRunGlRelief,
} from "./run-commit.ts";
import {
  type EntitlementReliefBinding,
  selectEntitlementRelief,
} from "./run-gl-entitlement-relief.ts";

/**
 * The optional governed correction of a committed, never-posted projection:
 * stub lines that settled an entitlement bank but were stamped to an expense
 * account move to the bound plan liability. Nothing else may change.
 */
export interface EntitlementReliefRequest {
  /** payRunGlProjectionHash of the committed projection the operator reviewed. */
  expectedProjectionHash: string;
  bindings: EntitlementReliefBinding[];
}

type ProjectionLine = {
  account_id: string;
  amount: string;
  description: string | null;
  party_id: string | null;
  project_id: string | null;
  department_id: string | null;
  custom: Record<string, unknown> | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A stable digest of a pay run's GL projection: each line normalized to its
 * account, canonical amount, description, party, project, department and
 * metadata, independent of row ids, line numbers and row order.
 */
export function payRunGlProjectionHash(lines: readonly ProjectionLine[]): string {
  const normalized = lines
    .map((line) =>
      canonicalJson({
        accountId: line.account_id,
        amount: normalizeMoney(line.amount),
        description: line.description ?? null,
        partyId: line.party_id ?? null,
        projectId: line.project_id ?? null,
        departmentId: line.department_id ?? null,
        custom: line.custom ?? {},
      }),
    )
    .sort();
  return createHash("sha256")
    .update(`[${normalized.join(",")}]`)
    .digest("hex");
}

/**
 * The projection covers every employee on the run, so an actor whose entity
 * scope excludes any of them can neither review nor rebuild it.
 */
async function assertCompleteRunScope(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowed: ReadonlySet<string> | null | undefined,
): Promise<void> {
  if (allowed == null) return;
  const outside = (
    await tx.execute<{ subsidiary_id: string | null }>(
      sql`
    select distinct p.subsidiary_id::text as subsidiary_id
      from pay_stubs s
      left join parties p on p.org_id = s.org_id and p.id = s.employee_party_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
  `,
      "objects",
    )
  ).filter((row) => row.subsidiary_id === null || !allowed.has(row.subsidiary_id));
  if (outside.length > 0) throw new PayrollError("pay run not found");
}

/**
 * The reviewable identity of a pay run's GL projection: its revision and
 * projection hash, which a governed correction must quote back.
 */
export async function readPayRunGlProjection(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{
  documentNumber: string;
  revision: string;
  runStatus: string;
  documentStatus: string;
  lineCount: number;
  projectionHash: string;
}> {
  const { orgId, documentId, actorId } = input;
  return withOrgTransaction(orgId, async () => {
    if (!(await actorHasPermission(db, orgId, actorId, "payroll.read")))
      throw new PayrollError("pay run not found");
    if (!(await lockAndCheckOrgFeature(db, orgId, "payroll")))
      throw new PayrollError("Payroll feature is disabled");
    const actorScope = await actorAllowedSubsidiaryIds(db, orgId, actorId);
    const run = (
      await db.execute<{
        run_status: string;
        doc_status: string;
        kind: string;
        subsidiary_id: string | null;
        document_number: string;
        revision: string;
      }>(
        sql`
      select r.run_status, d.status as doc_status, d.kind, d.subsidiary_id::text as subsidiary_id,
             d.document_number, d.revision_seq::text as revision
        from pay_runs r
        join documents d on d.org_id = r.org_id and d.id = r.document_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
    `,
        "objects",
      )
    )[0];
    if (
      !run ||
      run.kind !== "pay_run" ||
      !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id) ||
      (actorScope !== null && run.subsidiary_id !== null && !actorScope.has(run.subsidiary_id))
    ) {
      throw new PayrollError("pay run not found");
    }
    await assertCompleteRunScope(db, orgId, documentId, actorScope);
    await assertCompleteRunScope(db, orgId, documentId, input.allowedSubsidiaryIds);
    const lines = await db.execute<ProjectionLine>(
      sql`
      select account_id::text as account_id, amount::text as amount, description,
             party_id::text as party_id, project_id::text as project_id, department_id::text as department_id, custom
        from document_lines
       where org_id = ${orgId} and document_id = ${documentId}
    `,
      "objects",
    );
    return {
      documentNumber: run.document_number,
      revision: run.revision,
      runStatus: run.run_status,
      documentStatus: run.doc_status,
      lineCount: lines.length,
      projectionHash: payRunGlProjectionHash(lines),
    };
  });
}

/**
 * Rebuild the GL projection of a committed pay run that has never reached the
 * books, so its document lines carry the current line identity (employee, time
 * type, service item, leg kind) without restating any amount or account.
 *
 * The projection is rebuilt only from the run's own committed records: stub
 * amounts and their calculation and commit stamps, and the accounts the
 * committed projection already used. Today's payroll settings, component
 * accounts and costing mode are never read. The rebuilt lines must
 * re-aggregate to exactly the committed lines; any difference refuses.
 *
 * The run must be committed, its document still draft, and nothing may
 * reference it yet: no journal entry, payment, bank file, remittance bill,
 * document link or retro settlement.
 *
 * With `entitlementRelief`, the rebuild also performs one governed coding
 * correction: stub lines proven to settle a bound entitlement plan's bank
 * move from their expense account to the plan's liability. The operator
 * quotes the reviewed projection hash and binds each plan to its liability
 * account; every other line, the money totals and net pay stay identical,
 * and the stub lines themselves are never changed. Corrections already
 * recorded on the projection are carried through every later rebuild.
 */
export async function rebuildPayRunGlProjection(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  reason: string;
  /** documents.revision_seq the caller reviewed. */
  expectedRevision: string;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  entitlementRelief?: EntitlementReliefRequest;
}): Promise<{
  documentNumber: string;
  linesBefore: number;
  linesAfter: number;
  revision: string;
  projectionHash: string;
  relievedLines: number;
}> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 2000) {
    throw new PayrollError(
      "give a reason of 1–2000 characters for rebuilding the pay run's GL projection",
    );
  }
  if (!isDocumentRevisionToken(input.expectedRevision)) {
    throw new PayrollError(
      "reload the pay run and confirm the revision you reviewed before rebuilding its GL projection",
    );
  }
  const reliefRequest = input.entitlementRelief;
  if (reliefRequest) {
    if (
      typeof reliefRequest.expectedProjectionHash !== "string" ||
      !HASH_PATTERN.test(reliefRequest.expectedProjectionHash)
    ) {
      throw new PayrollError(
        "quote the projection hash you reviewed before correcting the pay run's entitlement coding",
      );
    }
    const bindings = Array.isArray(reliefRequest.bindings) ? reliefRequest.bindings : [];
    if (
      bindings.length === 0 ||
      bindings.length > 50 ||
      bindings.some(
        (binding) =>
          !UUID_PATTERN.test(binding?.planId ?? "") ||
          !UUID_PATTERN.test(binding?.liabilityAccountId ?? ""),
      ) ||
      new Set(bindings.map((binding) => binding.planId)).size !== bindings.length
    ) {
      throw new PayrollError(
        "bind each entitlement plan once to its liability account (1–50 bindings) before correcting the pay run's entitlement coding",
      );
    }
  }
  const { orgId, documentId, actorId } = input;
  return withOrgTransaction(orgId, async () => {
    const tx = db;
    await lockLedgerSetupFence(tx, orgId, "shared");
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll")))
      throw new PayrollError("Payroll feature is disabled");
    const run = (
      await tx.execute<{
        run_status: string;
        doc_status: string;
        kind: string;
        subsidiary_id: string | null;
        document_number: string;
        revision: string;
        posted_entry_id: string | null;
        paid_at: string | null;
        paid_entry_id: string | null;
        pay_date: string;
      }>(
        sql`
      select r.run_status, d.status as doc_status, d.kind, d.subsidiary_id::text as subsidiary_id,
             d.document_number, d.revision_seq::text as revision, d.posted_entry_id::text as posted_entry_id,
             r.paid_at::text as paid_at, r.paid_entry_id::text as paid_entry_id, r.pay_date::text as pay_date
        from pay_runs r
        join documents d on d.org_id = r.org_id and d.id = r.document_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r, d
    `,
        "objects",
      )
    )[0];
    if (
      !run ||
      run.kind !== "pay_run" ||
      !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)
    ) {
      throw new PayrollError("pay run not found");
    }
    const actorScope = await lockActorCommandAuthority(
      tx,
      orgId,
      actorId,
      run.subsidiary_id,
      "payroll.manage",
    );
    await assertCompleteRunScope(tx, orgId, documentId, actorScope);
    await assertCompleteRunScope(tx, orgId, documentId, input.allowedSubsidiaryIds);
    const number = run.document_number;
    if (run.run_status !== "committed") {
      throw new PayrollError(
        `pay run ${number} is ${run.run_status} — only a committed run's GL projection can be rebuilt`,
      );
    }
    if (run.doc_status !== "draft") {
      throw new PayrollError(
        `pay run ${number} is ${run.doc_status} — its GL projection is frozen. Return an approved, unposted run to draft before rebuilding, then submit it through its tenant Flow again. Correct posted or paid runs through governed reversals.`,
      );
    }
    if (run.revision !== input.expectedRevision) {
      throw new PayrollError(
        `pay run ${number} changed after you opened it — reload and review the latest revision`,
      );
    }
    if (run.posted_entry_id || run.paid_at || run.paid_entry_id) {
      throw new PayrollError(
        `pay run ${number} has already reached the books or been paid — its GL projection cannot be rebuilt`,
      );
    }
    const references = await tx.execute<{ reference: string }>(
      sql`
      select 'journal entry ' || e.entry_number as reference from journal_entries e
       where e.org_id = ${orgId} and e.source_document_id = ${documentId}
      union all
      select 'bank file ' || f.file_number from pay_run_bank_files f
       where f.org_id = ${orgId} and f.pay_run_document_id = ${documentId}
      union all
      -- Remittances are per legal entity: only the run's own entity's bills
      -- can cover it, so another entity's bills neither block nor disclose.
      select 'remittance bill ' || bill.document_number from documents bill
       where bill.org_id = ${orgId} and bill.kind = 'vendor_bill' and bill.status <> 'voided'
         and coalesce(bill.custom->'payrollRemittance'->>'subsidiaryId', bill.subsidiary_id::text)
             is not distinct from ${run.subsidiary_id}
         and bill.custom ? 'payrollRemittance'
         and bill.custom->'payrollRemittance'->>'from' <= ${run.pay_date}
         and bill.custom->'payrollRemittance'->>'to' >= ${run.pay_date}
      union all
      select 'linked document' from document_links k
       where k.org_id = ${orgId} and (k.from_document_id = ${documentId} or k.to_document_id = ${documentId})
      union all
      select 'retro settlement' from payroll_retro_settlements st
       where st.org_id = ${orgId} and st.source_pay_run_document_id = ${documentId}
      limit 5
    `,
      "objects",
    );
    if (references.length > 0) {
      throw new PayrollError(
        `pay run ${number} is already referenced (${references.map((row) => row.reference).join(", ")}) — its GL projection cannot be rebuilt`,
      );
    }

    const before = await tx.execute<{
      id: string;
      line_number: number;
      account_id: string;
      amount: string;
      description: string | null;
      party_id: string | null;
      project_id: string | null;
      department_id: string | null;
      custom: Record<string, unknown> | null;
    }>(
      sql`
      select id::text as id, line_number, account_id::text as account_id, amount::text as amount, description,
             party_id::text as party_id, project_id::text as project_id, department_id::text as department_id, custom
        from document_lines
       where org_id = ${orgId} and document_id = ${documentId}
       order by line_number
       for update
    `,
      "objects",
    );
    if (before.length === 0) {
      throw new PayrollError(`pay run ${number} has no committed GL projection to rebuild`);
    }
    const projectionHashBefore = payRunGlProjectionHash(before);
    if (reliefRequest && reliefRequest.expectedProjectionHash !== projectionHashBefore) {
      throw new PayrollError(
        `pay run ${number}'s GL projection changed after you reviewed it — reload, review the current projection and resubmit its hash`,
      );
    }
    const committedKind = (line: (typeof before)[number]): PayRunGlLegKind => {
      const recorded = line.custom?.legKind;
      if (
        recorded === "expense" ||
        recorded === "non_cash_offset" ||
        recorded === "liability" ||
        recorded === "net_pay" ||
        recorded === "labor_clearing" ||
        recorded === "entitlement_relief"
      )
        return recorded;
      // Projections committed before leg kinds were recorded follow the
      // materialization rules that wrote them.
      if (line.party_id) return "net_pay";
      if (line.description === "Wages (labor clearing)") return "labor_clearing";
      if (typeof line.custom?.payComponentId === "string") return "expense";
      if (line.description?.startsWith("Non-cash benefit: ")) return "non_cash_offset";
      return "liability";
    };
    if (before.some((line) => committedKind(line) === "labor_clearing")) {
      throw new PayrollError(
        `pay run ${number} washed wages through labor clearing — that basis is not recorded per line, so its GL projection cannot be rebuilt`,
      );
    }
    const netAccounts = [
      ...new Set(
        before.filter((line) => committedKind(line) === "net_pay").map((line) => line.account_id),
      ),
    ];
    // Employer-only runs carry no net pay leg; anything else must name one account.
    if (netAccounts.length > 1) {
      throw new PayrollError(
        `pay run ${number} credits more than one net pay account in its committed projection — its GL projection cannot be rebuilt`,
      );
    }
    const codingAccounts = new Map<string, Set<string>>();
    for (const line of before) {
      if (committedKind(line) !== "expense") continue;
      const key = payRunGlCodingKey(
        typeof line.custom?.payComponentId === "string" ? line.custom.payComponentId : null,
        line.department_id,
        line.project_id,
      );
      const accounts = codingAccounts.get(key) ?? new Set<string>();
      accounts.add(line.account_id);
      codingAccounts.set(key, accounts);
    }
    const expenseAccountByCoding = new Map<string, string>();
    for (const [key, accounts] of codingAccounts) {
      if (accounts.size === 1) expenseAccountByCoding.set(key, [...accounts][0]!);
    }
    // Corrections already recorded on the committed projection: each relief
    // leg names its plan, movement and the stub lines it carries.
    const carried = new Map<string, EntitlementReliefLine>();
    for (const line of before) {
      if (
        committedKind(line) !== "entitlement_relief" ||
        line.custom?.entitlementReliefBasis !== "governed_correction"
      )
        continue;
      const {
        entitlementPlanId: planId,
        entitlementMovementId: movementId,
        stubLineIds,
      } = line.custom ?? {};
      if (
        typeof planId !== "string" ||
        typeof movementId !== "string" ||
        !Array.isArray(stubLineIds) ||
        stubLineIds.length === 0 ||
        stubLineIds.some((id) => typeof id !== "string" || carried.has(id))
      ) {
        throw new PayrollError(
          `pay run ${number}'s recorded entitlement correction does not identify its plan, movement and stub lines — its GL projection cannot be rebuilt`,
        );
      }
      for (const stubLineId of stubLineIds as string[])
        carried.set(stubLineId, { accountId: line.account_id, planId, movementId });
    }
    const basis = { netPayAccountId: netAccounts[0] ?? null, expenseAccountByCoding };

    const { legs: identityLegs } = await payRunGlLegs(
      tx,
      orgId,
      documentId,
      input.allowedSubsidiaryIds,
      {
        ...basis,
        entitlementReliefByStubLine: carried,
      },
    );

    // The rebuilt identity may only split committed lines, never move money:
    // both projections must agree per account, party, project, department,
    // component and expense classification.
    const committedKey = (
      accountId: string,
      partyId: string | null,
      projectId: string | null,
      departmentId: string | null,
      payrollExpense: boolean,
      payComponentId: string | null,
    ) =>
      [
        accountId,
        partyId ?? "",
        projectId ?? "",
        departmentId ?? "",
        payrollExpense ? "expense" : "",
        payComponentId ?? "",
      ].join("|");
    const totals = (rows: { key: string; amount: string }[]) => {
      const out = new Map<string, string>();
      for (const row of rows) out.set(row.key, add(out.get(row.key) ?? "0", row.amount));
      for (const [key, value] of out) if (cmp(value, "0") === 0) out.delete(key);
      return out;
    };
    const committedTotals = totals(
      before.map((line) => ({
        key: committedKey(
          line.account_id,
          line.party_id,
          line.project_id,
          line.department_id,
          line.custom?.payrollExpense === true,
          typeof line.custom?.payComponentId === "string" ? line.custom.payComponentId : null,
        ),
        amount: line.amount,
      })),
    );
    const rebuiltTotals = totals(
      identityLegs.map((leg: PayRunGlLeg) => ({
        key: committedKey(
          leg.accountId,
          leg.partyId,
          leg.projectId,
          leg.departmentId,
          leg.payrollExpense === true,
          leg.payComponentId ?? null,
        ),
        amount: leg.amount,
      })),
    );
    const differing = [...new Set([...committedTotals.keys(), ...rebuiltTotals.keys()])].filter(
      (key) => cmp(committedTotals.get(key) ?? "0", rebuiltTotals.get(key) ?? "0") !== 0,
    );
    if (differing.length > 0) {
      throw new PayrollError(
        `rebuilding pay run ${number}'s GL projection would restate ${differing.length} committed account line(s) — the committed records do not support an identical rebuild`,
      );
    }

    let legs = identityLegs;
    let corrections: (PayRunGlRelief & {
      movementStubLineId: string | null;
      linkage: string;
      hours: string | null;
    })[] = [];
    if (reliefRequest) {
      const { relief, selected } = await selectEntitlementRelief(tx, {
        orgId,
        documentId,
        number,
        bindings: reliefRequest.bindings,
        carried,
      });
      if (relief.size === 0) {
        throw new PayrollError(
          `pay run ${number} has no bank settlement on the bound plans left to correct`,
        );
      }
      const corrected = await payRunGlLegs(tx, orgId, documentId, input.allowedSubsidiaryIds, {
        ...basis,
        entitlementReliefByStubLine: new Map([...carried, ...relief]),
      });
      const applied = corrected.reliefs.filter((row) => relief.has(row.stubLineId));
      if (applied.length !== relief.size || applied.some((row) => row.fromAccountId === null)) {
        throw new PayrollError(
          `pay run ${number}'s selected settlement lines do not resolve to their committed expense accounts — the correction is refused`,
        );
      }
      // The only permitted change: each relieved line's amount leaves its
      // committed expense account and lands on the bound liability. Liability,
      // net pay and non-cash legs are identical line for line.
      const byAccount = (rows: { accountId: string; amount: string }[]) =>
        totals(rows.map((row) => ({ key: row.accountId, amount: row.amount })));
      const expected = byAccount([
        ...identityLegs.map((leg) => ({ accountId: leg.accountId, amount: leg.amount })),
        ...applied.flatMap((row) => [
          { accountId: row.fromAccountId!, amount: neg(row.amount) },
          { accountId: row.toAccountId, amount: row.amount },
        ]),
      ]);
      const actual = byAccount(
        corrected.legs.map((leg) => ({ accountId: leg.accountId, amount: leg.amount })),
      );
      const unchangedKinds = new Set<PayRunGlLegKind>(["liability", "net_pay", "non_cash_offset"]);
      const fixedLegs = (rows: PayRunGlLeg[]) =>
        totals(
          rows
            .filter((leg) => unchangedKinds.has(leg.legKind))
            .map((leg) => ({
              key:
                committedKey(
                  leg.accountId,
                  leg.partyId,
                  leg.projectId,
                  leg.departmentId,
                  false,
                  leg.payComponentId ?? null,
                ) + `|${leg.legKind}`,
              amount: leg.amount,
            })),
        );
      const fixedBefore = fixedLegs(identityLegs),
        fixedAfter = fixedLegs(corrected.legs);
      const moved =
        [...new Set([...expected.keys(), ...actual.keys()])].some(
          (key) => cmp(expected.get(key) ?? "0", actual.get(key) ?? "0") !== 0,
        ) ||
        [...new Set([...fixedBefore.keys(), ...fixedAfter.keys()])].some(
          (key) => cmp(fixedBefore.get(key) ?? "0", fixedAfter.get(key) ?? "0") !== 0,
        );
      if (moved) {
        throw new PayrollError(
          `correcting pay run ${number}'s entitlement coding would change more than the relieved settlement lines — the correction is refused`,
        );
      }
      const selection = new Map(selected.map((row) => [row.stubLineId, row]));
      corrections = applied.map((row) => ({
        ...row,
        movementStubLineId: selection.get(row.stubLineId)!.movementStubLineId,
        linkage: selection.get(row.stubLineId)!.linkage,
        hours: selection.get(row.stubLineId)!.hours,
      }));
      legs = corrected.legs;
    }

    const deleted = await tx.execute<{ id: string }>(
      sql`
      delete from document_lines where org_id = ${orgId} and document_id = ${documentId} returning id::text as id
    `,
      "objects",
    );
    if (deleted.length !== before.length) {
      throw new PayrollError(
        `pay run ${number}'s GL projection changed while it was being rebuilt — reload and try again`,
      );
    }
    let lineNumber = 1;
    const after: Record<string, unknown>[] = [];
    for (const leg of legs) {
      const custom = payRunGlLegCustom(leg);
      const inserted = await tx.execute<{ id: string }>(
        sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    amount, party_id, project_id, department_id, custom, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber}, ${leg.accountId}, ${leg.description},
                ${leg.amount}, ${leg.partyId}, ${leg.projectId}, ${leg.departmentId},
                ${JSON.stringify(custom)}::jsonb, ${actorId}, ${actorId})
        returning id::text as id
      `,
        "objects",
      );
      if (inserted.length !== 1)
        throw new PayrollError(`pay run ${number}'s rebuilt GL line could not be written`);
      after.push({
        id: inserted[0]!.id,
        line_number: lineNumber,
        account_id: leg.accountId,
        amount: leg.amount,
        description: leg.description,
        party_id: leg.partyId,
        project_id: leg.projectId,
        department_id: leg.departmentId,
        custom,
      });
      lineNumber++;
    }
    // The locked document passed OCC before any line changed. Its own line
    // triggers advance the revision during the rebuild; retain their final
    // value rather than comparing it with the pre-write revision again.
    const revised = await tx.execute<{ revision: string }>(
      sql`
      update documents set updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${documentId} and status = 'draft' and posted_entry_id is null
      returning revision_seq::text as revision
    `,
      "objects",
    );
    if (revised.length !== 1) {
      throw new PayrollError(
        `pay run ${number}'s rebuilt projection revision could not be saved — reload and review the run`,
      );
    }
    const projectionHash = payRunGlProjectionHash(after as ProjectionLine[]);
    const audited = await tx.execute<{ id: string }>(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'documents', ${documentId}, 'update',
              ${JSON.stringify({
                operation: "rebuild-pay-run-gl-projection",
                reason,
                revisionBefore: input.expectedRevision,
                revisionAfter: revised[0]!.revision,
                projectionHashBefore,
                projectionHashAfter: projectionHash,
                entitlementRelief: reliefRequest
                  ? {
                      bindings: reliefRequest.bindings.map((binding) => ({
                        planId: binding.planId,
                        liabilityAccountId: binding.liabilityAccountId,
                      })),
                      corrections,
                    }
                  : null,
                before,
                after,
              })}::jsonb, ${actorId})
      returning id::text as id
    `,
      "objects",
    );
    if (audited.length !== 1)
      throw new PayrollError(`pay run ${number}'s GL projection rebuild could not be audited`);
    return {
      documentNumber: number,
      linesBefore: before.length,
      linesAfter: after.length,
      revision: revised[0]!.revision,
      projectionHash,
      relievedLines: corrections.length,
    };
  });
}
