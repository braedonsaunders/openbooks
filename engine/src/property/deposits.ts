/** Security-deposit subledger. Split from property/management.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import { postEntry } from "../journal/post-entry.ts";
import { cmp, neg } from "../money/money.ts";
import { assertEnabled, assertLockedSubsidiaryInScope, audit, DEPOSIT_OFFSET_EXCLUDED_TYPES, exactMoney, PropertyManagementError, UUID_RE, validDate, type DepositContextRow, type DepositReversalRow } from "./management-foundation.ts";
import { depositBalance, depositPostingShape, depositReversalKind, isSecurityDepositImportConflict } from "./management-foundation.ts";

export async function recordSecurityDeposit(input: { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; leaseId: string; kind: string; occurredOn: string; amount: string; bankAccountId?: string | null; offsetAccountId?: string | null; appliedDocumentId?: string | null; memo?: string | null; importKey?: string | null }): Promise<{ id: string; entryId: string; balance: string }> {
  const shape = depositPostingShape(input.kind);
  const occurredOn = validDate(input.occurredOn, "Deposit date")!;
  const amount = exactMoney(input.amount, "Deposit amount");
  if (cmp(amount, "0") <= 0) throw new PropertyManagementError("Deposit amount must be positive");
  if ((input.kind === "applied") !== Boolean(input.appliedDocumentId)) {
    throw new PropertyManagementError("An applied deposit must identify exactly one tenant invoice");
  }
  if (["interest", "adjustment_increase", "adjustment_decrease"].includes(input.kind) && !input.offsetAccountId) {
    throw new PropertyManagementError("Interest and adjustments require an offset account");
  }

  return db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, input.orgId, "propertyManagement"))) {
      throw new PropertyManagementError("Property management feature is disabled");
    }
    await tx.execute(sql`select id from subsidiaries where org_id=${input.orgId} order by id for share`);
    // Deposit journals are ordinary postings: the period resolves through
    // the shared covering-period resolver (default calendar, regular
    // periods, deterministic) before the lease lock is taken.
    const depositPeriod = await resolveCoveringPeriod(tx, input.orgId, occurredOn);
    if (!depositPeriod) throw new PropertyManagementError("An open GL period is required");
    const depositPeriodId: string = depositPeriod.id;
    // The lease lock serializes balance-changing deposit activity. The
    // property lock (exclusive, like the rehome path's own) serializes a
    // concurrent subsidiary move, so the subsidiary below is read current
    // and rechecked in the same statement window. Journal, application, and
    // append-only subledger evidence commit as one unit.
    const ctx = (await tx.execute<DepositContextRow>(sql`
      select l.tenant_id,p.subsidiary_id,p.location_id,p.currency,s.base_currency,p.deposit_liability_account_id,p.default_bank_account_id,
        (select id from accounting_books where org_id=l.org_id and is_primary and is_active and posts_gl order by id limit 1 for share) as book_id
      from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
      join subsidiaries s on s.id=p.subsidiary_id and s.org_id=p.org_id
      where l.org_id=${input.orgId} and l.id=${input.leaseId}
      for update of l, p for share of s
    `));
    const row = ctx.rows[0];
    if (!row) throw new PropertyManagementError("Lease not found");
    assertLockedSubsidiaryInScope(input.allowedSubsidiaryIds, row.subsidiary_id);
    const liability = (await tx.execute<{ type: string }>(sql`select type from accounts
      where org_id=${input.orgId} and id=${row.deposit_liability_account_id} for share`)).rows[0];
    if (!row.deposit_liability_account_id || !liability || !["liability_current_other", "liability_long_term"].includes(liability.type)) {
      throw new PropertyManagementError("Configure a liability account for property security deposits");
    }
    if (row.currency !== row.base_currency) {
      throw new PropertyManagementError("Security-deposit journals require the property currency to match the subsidiary functional currency");
    }
    if (!row.book_id) throw new PropertyManagementError("An active primary posting book is required");
    // One period gate: the shared GL check replaces the raw
    // period_module_is_closed finder predicate. Recording a deposit is new
    // local activity, not historical replay, so source-owned imported
    // locks refuse exactly like user locks.
    try {
      const depositBookId: string = row.book_id;
      await assertPeriodModulesOpen(tx, {
        orgId: input.orgId,
        periodId: depositPeriodId,
        bookId: depositBookId,
        subsidiaryIds: [row.subsidiary_id],
        modules: ["gl"],
      });
    } catch (error) {
      if (error instanceof CloseError) throw new PropertyManagementError("An open GL period is required");
      throw error;
    }

    const prior = (await tx.execute<{ kind: string; amount: string }>(sql`select kind,amount from security_deposit_transactions where org_id=${input.orgId} and lease_id=${input.leaseId}`));
    const nextBalance = depositBalance([...prior.rows, { kind: input.kind, amount }]);
    if (cmp(nextBalance, "0") < 0) throw new PropertyManagementError("Deposit transaction exceeds the tenant balance");
    const importKey = input.importKey?.trim() || null;
    if (importKey) {
      const duplicate = (await tx.execute(sql`select 1 from security_deposit_transactions
        where org_id=${input.orgId} and import_key=${importKey} limit 1`));
      if (duplicate.rows.length) throw new PropertyManagementError("Security deposit was already imported");
    }

    const increase = shape.liabilitySide === "credit";
    const applied = shape.offsetIsArOpenItem;
    const bankId = ["received", "refunded"].includes(input.kind) ? input.bankAccountId ?? row.default_bank_account_id : null;
    if (["received", "refunded"].includes(input.kind) && !bankId) throw new PropertyManagementError("A bank account is required");
    if (bankId) {
      const bank = (await tx.execute<{ type: string }>(sql`select type from accounts where org_id=${input.orgId} and id=${bankId} and is_active and not is_summary for share`));
      if (bank.rows[0]?.type !== "asset_bank") throw new PropertyManagementError("Security-deposit cash must use an active bank account");
    }

    // Cash kinds post against the bank recorded on the subledger row — a
    // separate offset would move the GL cash leg somewhere the subledger does
    // not say. Interest and adjustments post against a validated non-cash,
    // non-control account that is not the deposit liability itself (a
    // self-cancelling journal would leave the subledger unreconcilable).
    const cashKind = bankId !== null;
    if (cashKind && input.offsetAccountId && input.offsetAccountId !== bankId) {
      throw new PropertyManagementError("Cash deposit activity posts against the bank account; an offset account is not accepted");
    }
    let targetLineId: string | null = null;
    let offsetId: string | null = applied ? null : cashKind ? bankId : input.offsetAccountId ?? null;
    if (!applied && !cashKind && offsetId) {
      if (!UUID_RE.test(offsetId)) throw new PropertyManagementError("Offset account is invalid");
      const offset = (await tx.execute<{ type: string; is_active: boolean; is_summary: boolean }>(sql`
        select type,is_active,is_summary from accounts where org_id=${input.orgId} and id=${offsetId} for share`)).rows[0];
      if (!offset) throw new PropertyManagementError("Offset account not found");
      if (!offset.is_active || offset.is_summary) throw new PropertyManagementError("Offset account must be an active posting account");
      if (offsetId === row.deposit_liability_account_id) throw new PropertyManagementError("Offset account cannot be the deposit liability account");
      if (DEPOSIT_OFFSET_EXCLUDED_TYPES.has(offset.type)) {
        throw new PropertyManagementError("Interest and adjustments post against an expense or income account, never cash or a control account");
      }
    }
    if (applied) {
      const candidate = (await tx.execute<{ id: string }>(sql`
        select jl.id
        from documents d join journal_lines jl on jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id and jl.is_open_item
        join accounts a on a.id=jl.account_id and a.org_id=jl.org_id and a.type='asset_receivable'
        where d.org_id=${input.orgId} and d.id=${input.appliedDocumentId!} and d.kind='customer_invoice'
          and d.party_id=${row.tenant_id} and d.status='posted' and coalesce(d.open_balance,0)>=${amount}
        order by jl.line_number limit 1
      `)).rows[0];
      if (!candidate) throw new PropertyManagementError("Posted tenant invoice with sufficient open balance not found");
      await lockApplicationEvidence(tx, input.orgId, [candidate.id], [input.appliedDocumentId!]);
      const target = (await tx.execute<{ id: string; account_id: string; invoiceCurrency: string; lineCurrency: string; documentNumber: string }>(sql`
        select jl.id,jl.account_id,d.currency as "invoiceCurrency",jl.currency as "lineCurrency",d.document_number as "documentNumber"
        from documents d join journal_lines jl on jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id and jl.is_open_item
        join accounts a on a.id=jl.account_id and a.org_id=jl.org_id and a.type='asset_receivable'
        where d.org_id=${input.orgId} and d.id=${input.appliedDocumentId!} and d.kind='customer_invoice'
          and d.party_id=${row.tenant_id} and d.status='posted' and coalesce(d.open_balance,0)>=${amount}
          and jl.id=${candidate.id}
        order by jl.line_number limit 1
      `));
      const targetRow = target.rows[0];
      targetLineId = targetRow?.id ?? null;
      offsetId = targetRow?.account_id ?? null;
      if (!targetLineId || !offsetId || !targetRow) throw new PropertyManagementError("Posted tenant invoice with sufficient open balance not found");
      // Deposit applications settle in a single currency: the journal legs and
      // the applications row below are stamped at rate 1 in the deposit
      // currency, so a foreign-currency invoice must refuse by name rather
      // than relieve the wrong AR value with no FX gain/loss.
      if (targetRow.invoiceCurrency !== row.currency || targetRow.lineCurrency !== row.currency) {
        throw new PropertyManagementError(
          `Security-deposit application refused: invoice ${targetRow.documentNumber} is in ${targetRow.invoiceCurrency} but the deposit is in ${row.currency}. ` +
          `Apply the deposit to a ${row.currency} tenant invoice, or collect the ${targetRow.invoiceCurrency} invoice with a customer payment, ` +
          `which posts cross-currency settlement with an FX rate and realized gain/loss.`,
        );
      }
    } else if (!offsetId) {
      throw new PropertyManagementError("An offset account is required");
    }

    const accountIds = [...new Set([row.deposit_liability_account_id, offsetId!])];
    await tx.execute(sql`select id from accounts where org_id=${input.orgId}
      and id=any(${uuidArray(accountIds)}::uuid[]) order by id for share`);
    if (row.location_id) await tx.execute(sql`select id from locations
      where org_id=${input.orgId} and id=${row.location_id} for share`);
    try {
      await validateSubsidiaryRestrictions(tx, {
        orgId: input.orgId, ctx: await loadSubsidiaryContext(tx, input.orgId), docSubsidiaryId: row.subsidiary_id,
        lines: accountIds.map((accountId) => ({ accountId, amount, subsidiaryId: row.subsidiary_id, locationId: row.location_id })),
      });
    } catch (error) {
      if (error instanceof SubsidiaryError) throw new PropertyManagementError(error.message);
      throw error;
    }

    const entryNumber = `DEP-${occurredOn}-${input.leaseId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const debitAccount = increase ? offsetId : row.deposit_liability_account_id;
    const creditAccount = increase ? row.deposit_liability_account_id : offsetId;
    // Party belongs on the deposit-liability leg. Cash/expense offsets do not
    // carry the tenant; an AR application additionally carries it on AR.
    const debitParty = increase ? null : row.tenant_id;
    const creditParty = increase || applied ? row.tenant_id : null;
    // Every journal write routes through the ONE ledger API. Leg order is
    // preserved, so the credit leg keeps input position 2 for the
    // application below.
    const postedDeposit = await postEntry(tx, {
      orgId: input.orgId,
      bookId: row.book_id,
      subsidiaryId: row.subsidiary_id,
      entryNumber,
      postingDate: occurredOn,
      periodId: depositPeriodId,
      memo: input.memo ?? `Security deposit ${input.kind}`,
      origin: "manual",
      custom: { propertyManagement: { leaseId: input.leaseId, kind: input.kind } },
      actorId: input.actorId,
      currency: row.currency,
      lines: [
        {
          accountId: debitAccount,
          amount,
          locationId: row.location_id,
          partyId: debitParty,
          memo: input.memo ?? "Security deposit",
        },
        {
          accountId: creditAccount,
          amount: neg(amount),
          locationId: row.location_id,
          partyId: creditParty,
          isOpenItem: applied,
          memo: input.memo ?? "Security deposit",
        },
      ],
    });
    const entryId = postedDeposit.entryId;
    const creditLineId = postedDeposit.lines[1]!.id;
    if (applied && targetLineId) {
      await tx.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,
        target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
        values(${input.orgId},${creditLineId},${targetLineId},${amount},${amount},${amount},${row.currency},${amount},${row.currency},1,'same_currency','Security deposit application',${occurredOn},${input.actorId},${input.actorId})`);
    }
    const inserted = (await tx.execute<{ id: string }>(sql`insert into security_deposit_transactions(org_id,lease_id,kind,occurred_on,amount,bank_account_id,offset_account_id,applied_document_id,journal_entry_id,import_key,memo,created_by,updated_by)
      values(${input.orgId},${input.leaseId},${input.kind},${occurredOn},${amount},${bankId},${offsetId},${input.appliedDocumentId ?? null},${entryId},${importKey},${input.memo ?? null},${input.actorId},${input.actorId}) returning id`));
    return { id: inserted.rows[0]!.id, entryId, balance: nextBalance };
  }).catch((error: unknown) => {
    if (isSecurityDepositImportConflict(error)) throw new PropertyManagementError("Security deposit was already imported");
    throw error;
  });
}
export async function reverseSecurityDepositTransaction(input: {
  orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; transactionId: string; occurredOn: string; reason: string;
}): Promise<{ id: string; entryId: string; balance: string }> {
  const occurredOn = validDate(input.occurredOn, "Reversal date")!;
  const reason = input.reason.trim();
  if (!reason) throw new PropertyManagementError("Reversal reason is required");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    // Use the same aggregate lock as receipts, refunds and applications before
    // reading the balance. A source-transaction lock alone cannot serialize a
    // reversal against activity on another deposit transaction for this lease.
    const lease = await tx.execute<{ id: string }>(sql`
      select l.id from property_leases l
        join security_deposit_transactions t on t.lease_id=l.id and t.org_id=l.org_id
       where t.org_id=${input.orgId} and t.id=${input.transactionId}
       for update of l
    `);
    if (!lease.rows[0]) throw new PropertyManagementError("Deposit transaction not found");
    // Reversals are ordinary corrections: the period resolves through the
    // shared covering-period resolver (default calendar, regular periods,
    // deterministic) before the transaction lock is taken.
    const reversalPeriod = await resolveCoveringPeriod(tx, input.orgId, occurredOn);
    if (!reversalPeriod) throw new PropertyManagementError("An open GL period is required for the reversal date");
    const reversalPeriodId: string = reversalPeriod.id;
    const context = (await tx.execute<DepositReversalRow>(sql`
      select t.*,p.subsidiary_id,p.currency,s.base_currency,je.book_id,
        exists(select 1 from security_deposit_transactions r where r.org_id=t.org_id and r.reversal_of_id=t.id) as already_reversed
      from security_deposit_transactions t
      join property_leases l on l.id=t.lease_id and l.org_id=t.org_id
      join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
      join subsidiaries s on s.id=p.subsidiary_id and s.org_id=p.org_id
      join journal_entries je on je.id=t.journal_entry_id and je.org_id=t.org_id
      where t.org_id=${input.orgId} and t.id=${input.transactionId} for update of t, p
    `));
    const row = context.rows[0];
    if (!row) throw new PropertyManagementError("Deposit transaction not found");
    // The property lock above serializes a concurrent rehome with the
    // lease lock taken at the top: the subsidiary is current here.
    assertLockedSubsidiaryInScope(input.allowedSubsidiaryIds, row.subsidiary_id);
    if (row.reversal_of_id || row.already_reversed) throw new PropertyManagementError("Deposit transaction is already a reversal or has already been reversed");
    // One period gate: the shared GL check replaces the raw
    // period_module_is_closed finder predicate. A reversal is new local
    // activity, not historical replay, so source-owned imported locks
    // refuse exactly like user locks.
    try {
      await assertPeriodModulesOpen(tx, {
        orgId: input.orgId,
        periodId: reversalPeriodId,
        bookId: row.book_id,
        subsidiaryIds: [row.subsidiary_id],
        modules: ["gl"],
      });
    } catch (error) {
      if (error instanceof CloseError) throw new PropertyManagementError("An open GL period is required for the reversal date");
      throw error;
    }
    if (row.currency !== row.base_currency) throw new PropertyManagementError("Security-deposit reversals require functional-currency deposits");

    const kind = depositReversalKind(row.kind);
    const prior = (await tx.execute<{ kind: string; amount: string }>(sql`select kind,amount from security_deposit_transactions where org_id=${input.orgId} and lease_id=${row.lease_id}`));
    const balance = depositBalance([...prior.rows, { kind, amount: row.amount }]);
    if (cmp(balance, "0") < 0) throw new PropertyManagementError("Later deposit activity must be corrected before this transaction can be reversed");

    const entryNumber = `DEP-REV-${occurredOn}-${input.transactionId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    // The reversal mirrors the source lines exactly through the ONE ledger
    // API. Reversal line ids come back keyed by line number for the
    // application re-linking below.
    const mirrorSource = (await tx.execute<{
      line_number: number;
      account_id: string;
      subsidiary_id: string;
      amount: string;
      currency: string | null;
      txn_amount: string;
      fx_rate: string;
      party_id: string | null;
      department_id: string | null;
      project_id: string | null;
      location_id: string | null;
      class_id: string | null;
      equipment_unit_id: string | null;
      payment_card_id: string | null;
      extra_dims: unknown;
      quantity: string | null;
      unit: string | null;
      due_date: string | null;
      is_open_item: boolean;
      tax_code_id: string | null;
      custom: unknown;
    }>(sql`
      select line_number,account_id,subsidiary_id,amount::text as amount,currency,txn_amount::text as txn_amount,fx_rate::text as fx_rate,
        party_id,department_id,project_id,location_id,class_id,equipment_unit_id,payment_card_id,extra_dims,
        quantity::text as quantity,unit,due_date::text as due_date,is_open_item,tax_code_id,custom
      from journal_lines where org_id=${input.orgId} and entry_id=${row.journal_entry_id} order by line_number
    `)).rows;
    const postedDepReversal = await postEntry(tx, {
      orgId: input.orgId,
      bookId: row.book_id,
      subsidiaryId: row.subsidiary_id,
      entryNumber,
      postingDate: occurredOn,
      periodId: reversalPeriodId,
      memo: `Deposit reversal: ${reason}`,
      origin: "manual",
      reversesEntryId: row.journal_entry_id,
      custom: { propertyManagement: { leaseId: row.lease_id, reversalOfId: input.transactionId, kind } },
      actorId: input.actorId,
      lines: mirrorSource.map((line) => ({
        accountId: line.account_id,
        subsidiaryId: line.subsidiary_id,
        amount: neg(line.amount),
        currency: line.currency,
        txnAmount: neg(line.txn_amount),
        fxRate: line.fx_rate,
        memo: `Deposit reversal: ${reason}`,
        partyId: line.party_id,
        departmentId: line.department_id,
        projectId: line.project_id,
        locationId: line.location_id,
        classId: line.class_id,
        equipmentUnitId: line.equipment_unit_id,
        paymentCardId: line.payment_card_id,
        extraDims: (line.extra_dims ?? {}) as Record<string, string>,
        quantity: line.quantity == null ? null : neg(line.quantity),
        unit: line.unit,
        dueDate: line.due_date,
        isOpenItem: line.is_open_item,
        taxCodeId: line.tax_code_id,
        custom: (line.custom ?? {}) as Record<string, unknown>,
        lineNumber: line.line_number,
      })),
    });
    const entryId = postedDepReversal.entryId;
    const reversalLineByNumber = new Map(postedDepReversal.lines.map((line) => [line.lineNumber, line.id]));

    const applications = (await tx.execute(sql`
      select a.*,source.line_number
      from applications a join journal_lines source on source.id=a.from_line_id and source.org_id=a.org_id
      where a.org_id=${input.orgId} and source.entry_id=${row.journal_entry_id} and a.unapplied_at is null for update of a
    `));
    if (applications.rows.length) {
      await tx.execute(sql`
        update applications set unapplied_at=now(),updated_at=now(),updated_by=${input.actorId}
        where org_id=${input.orgId} and unapplied_at is null and from_line_id in
          (select id from journal_lines where org_id=${input.orgId} and entry_id=${row.journal_entry_id})
      `);
      for (const application of applications.rows) {
        const reversalLineId = reversalLineByNumber.get(Number(application.line_number));
        if (!reversalLineId) throw new PropertyManagementError("Security deposit reversal is missing its mirrored line");
        await tx.execute(sql`
          insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,
            target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
          values(${input.orgId},${application.from_line_id},${reversalLineId},${application.amount},${application.source_amount},
            ${application.source_transaction_amount},${application.source_transaction_currency},${application.target_transaction_amount},${application.target_transaction_currency},
            ${application.settlement_rate},${application.settlement_rate_source},'Security deposit reversal',${occurredOn},${input.actorId},${input.actorId})
        `);
      }
    }
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into security_deposit_transactions(org_id,lease_id,kind,occurred_on,amount,bank_account_id,offset_account_id,journal_entry_id,reversal_of_id,memo,created_by,updated_by)
      values(${input.orgId},${row.lease_id},${kind},${occurredOn},${row.amount},${["received", "refunded"].includes(kind) ? row.bank_account_id : null},
        ${["received", "refunded"].includes(kind) ? row.bank_account_id : row.offset_account_id},${entryId},${input.transactionId},${`Reversal: ${reason}`},${input.actorId},${input.actorId}) returning id
    `));
    await audit(tx, input.orgId, "security_deposit_transactions", inserted.rows[0]!.id, "reverse", input.actorId, { reversalOfId: input.transactionId, reason, occurredOn });
    return { id: inserted.rows[0]!.id, entryId, balance };
  });
}
