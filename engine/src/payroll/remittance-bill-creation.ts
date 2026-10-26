import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { lockScopeRow, ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import { payrollSubsidiaryInScope, type PayrollSubsidiaryScope } from "./scope.ts";
import { remittanceScopeLines, coveredRemittanceStubLines, remittanceBillsWithoutCoverage, sliceStubCurrencies, type RemittanceScopeLine } from "./remittance-coverage.ts";
import { remittanceMemo, remittanceGroupDueDate, type RemittanceEntitySlice, type RemittanceGroup } from "./remittance-group-schedule.ts";
import { rawPayrollSettings, makeRemittanceDestinationResolver, remittancePeriodProblem, payrollRemittanceSummary } from "./remittance-summary.ts";

/** Remittance bill creation: one vendor bill per destination, filing account, and legal entity. */

/**
 * The identity of one remittance bill: destination vendor × period window ×
 * filing account × legal entity. One bill per key — the key is both the
 * advisory lock's scope and the structured marker searched back before a
 * second bill is minted. The entity segment is what keeps two concurrent
 * creators for different slices of one multi-entity group from minting the
 * same slice twice while letting each slice proceed independently.
 */
export interface RemittanceBillKey {
  partyId: string;
  from: string;
  to: string;
  filingAccountId: string | null;
  subsidiaryId?: string | null;
}

/** The transaction advisory lock that serializes creation for one key. */
export function remittanceBillLockKey(orgId: string, key: RemittanceBillKey): string {
  return `payroll-remittance-bill:${orgId}:${key.partyId}:${key.from}:${key.to}:${key.filingAccountId ?? ""}:${key.subsidiaryId ?? ""}`;
}

/**
 * The fence shared by every period for one remittance destination, filing
 * account and legal entity. Periods are deliberately not part of this key:
 * two overlapping windows must serialize before the overlap check can decide
 * which one wins. The entity IS part of this key: without it, two concurrent
 * creators each raising a different slice of the same group would serialize
 * on one lock and — worse — neither would see the other's marker.
 */
export function remittanceFenceLockKey(
  orgId: string,
  key: Pick<RemittanceBillKey, "partyId" | "filingAccountId"> & Pick<RemittanceBillKey, "subsidiaryId">,
): string {
  return `payroll-remittance-fence:${orgId}:${key.partyId}:${key.filingAccountId ?? ""}:${key.subsidiaryId ?? ""}`;
}

/**
 * The duplicate refusal, or null when the coast is clear.
 *
 * Pure, so the rule — one bill per uncovered remainder, and no second bill
 * for lines a live bill already consumed — is verifiable without a database.
 * An exact re-run with nothing new left to bill is refused naming the first
 * bill; a voided bill frees its lines deliberately, so the correction path
 * stays void-then-recreate, never two live drafts debiting the same
 * liabilities.
 */
export function duplicateRemittanceMessage(
  existing: { documentNumber: string | null } | undefined,
): string | null {
  if (!existing) return null;
  return `a remittance bill for this vendor, period and filing account already exists `
    + `(${existing.documentNumber ?? "unnumbered"}) — one bill per remittance; `
    + "post, edit or void that draft instead of raising a second";
}

/** Refusal for a new period that would consume liabilities already covered by
 * another live remittance bill. The exact-window case keeps the established
 * idempotency message; this names the two windows so a controller can choose
 * a non-overlapping correction period without guessing. */
export function overlappingRemittanceMessage(
  existing: { documentNumber: string | null; from: string; to: string } | undefined,
): string | null {
  if (!existing) return null;
  return `this remittance period overlaps ${existing.from} – ${existing.to}`
    + ` for the same vendor and filing account (${existing.documentNumber ?? "unnumbered"})`;
}

/**
 * Which vendor_bill series numbers the remittance bill: the org's EXISTING
 * one, never a parallel series.
 *
 * The bill is a vendor_bill like any other, and the org's vendor-bill series
 * issues numbers that are distinct across the organization — so allocating
 * from a private org-level series hardcoded 'BILL-' forks the org's
 * vendor-bill numbering and reissues numbers once the org's real series emits
 * the same prefix and number (a collision outright for the same remittance
 * vendor, documents_org_kind_party_number). Preference follows the AP path's own rule
 * (web/lib/bills.ts): the billed entity's series when the org scopes its
 * vendor bills per subsidiary, else the org-wide series. Null when neither
 * exists, and the caller seeds 'BILL-' exactly as it always did.
 */
export function pickRemittanceSequence(
  rows: readonly { prefix: string; subsidiaryId: string | null }[],
  billedSubsidiaryId: string,
): { prefix: string; subsidiaryId: string | null } | null {
  return rows.find((row) => row.subsidiaryId === billedSubsidiaryId)
    ?? rows.find((row) => row.subsidiaryId === null)
    ?? null;
}

/**
 * Which entity slice of a remittance group a bill is raised for. A caller
 * naming `subsidiaryId` bills exactly that slice; otherwise the group must
 * hold exactly one slice — a group spanning several entities never bills as
 * one document (that would re-merge what double-entry keeps apart), it
 * splits: one call per slice. Pure, so the split-or-refuse rule is verifiable
 * without a database.
 */
export function pickRemittanceSlice(
  group: RemittanceGroup,
  subsidiaryId: string | null,
): RemittanceEntitySlice {
  if (subsidiaryId != null) {
    const slice = group.slices.find((candidate) => candidate.subsidiaryId === subsidiaryId);
    if (!slice) throw new PayrollError("nothing to remit to this vendor for the period");
    return slice;
  }
  if (group.slices.length === 1) return group.slices[0]!;
  if (group.slices.length === 0) {
    throw new PayrollError(
      "this remittance group includes payroll with no legal entity — attribute its pay runs "
      + "to a subsidiary before remitting",
    );
  }
  throw new PayrollError(
    `this remittance spans ${group.slices.length} legal entities `
    + `(${group.slices.map((slice) => `${slice.subsidiaryName ?? slice.subsidiaryId}: ${slice.total} ${slice.currency}`).join("; ")}) `
    + "— raise one bill per entity",
  );
}

/**
 * Materialize one destination's remittance as a draft vendor bill debiting
 * the liability accounts. Fails closed on unassigned accounts. The bill then
 * posts DR liabilities / CR AP and is paid like any other payable.
 *
 * `filingAccountId` selects the payroll program/EIN account being remitted;
 * omit it (or pass null) for the unassigned bucket of a single-account org.
 * One bill per account keeps each PD7A remittance separately traceable.
 *
 * `subsidiaryId` selects the legal entity being remitted. A bill is a
 * single-entity AP document: it is stamped with the entity whose books
 * credited the accruals, in that entity's currency, and debits that entity's
 * liabilities so they clear. Omit it for a single-entity group; a group
 * spanning several entities splits — one call per slice — and an omitted
 * `subsidiaryId` there is refused naming the entities.
 *
 * Creating is IDEMPOTENT per (destination, period, filing account, entity)
 * AND consumed line: a transaction-scoped advisory lock serializes
 * concurrent creators (a double-click, a retried request), per-accrual
 * coverage records exactly which lines each bill consumed, and a later
 * same-window run bills only the unbilled remainder. An exact re-run with
 * nothing left to bill is refused by name rather than minted twice, and an
 * intersecting live bill with no coverage rows (an unreconciled legacy bill)
 * fails closed rather than risk a double bill.
 */
export async function createRemittanceBill(
  orgId: string,
  actorId: string,
  input: {
    partyId: string;
    from: string;
    to: string;
    filingAccountId?: string | null;
    subsidiaryId?: string | null;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  },
): Promise<{ documentId: string; documentNumber: string }> {
  const filingAccountId = input.filingAccountId ?? null;
  const periodProblem = remittancePeriodProblem(input.from, input.to);
  if (periodProblem) throw new PayrollError(periodProblem);

  // Auto mode must discover WHICH entity before it can fence it. This
  // preflight read may go stale — the canonical summary inside the
  // transaction re-resolves and governs — but it can only resolve to a
  // refusal or to a slice the canonical pass re-checks.
  let entityId = input.subsidiaryId ?? null;
  if (entityId == null) {
    const preflight = await payrollRemittanceSummary(
      orgId,
      { from: input.from, to: input.to },
      input.allowedSubsidiaryIds,
    );
    const found = preflight.find(
      (g) => g.partyId === input.partyId && g.filingAccount.id === filingAccountId,
    );
    if (!found) throw new PayrollError("nothing to remit to this vendor for the period");
    if (found.hasUnknownFilingAccount) {
      throw new PayrollError(
        "this remittance group includes payroll with an unknown historical filing account — reconcile its original payroll evidence before remitting",
      );
    }
    if (found.hasEntitylessAccruals) {
      throw new PayrollError(
        "this remittance group includes payroll with no legal entity — attribute its pay runs "
        + "to an active subsidiary before remitting (open the pay run and choose Attribute entity)",
      );
    }
    entityId = pickRemittanceSlice(found, null).subsidiaryId;
  }

  return await db.transaction(async (tx) => {
    // Serialize every period for this destination, filing account AND entity
    // BEFORE reading the accruals. The explicit READ COMMITTED mode is
    // intentional: PostgreSQL takes a fresh statement snapshot after a
    // blocked advisory lock returns, so accruals committed while this creator
    // waited are in the canonical summary below. Two creators for different
    // slices hold different locks and proceed independently; two for the same
    // slice serialize, and the second meets the first's marker.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${remittanceFenceLockKey(orgId, {
        partyId: input.partyId, filingAccountId, subsidiaryId: entityId,
      })}, 0))
    `);

    // The vendor party is mutable master data. Fence its ownership for the
    // entire bill transaction so a concurrent subsidiary rehome cannot move
    // the remittance destination after the caller's route-level preflight.
    try {
      await lockScopeRow(
        tx,
        orgId,
        "party",
        input.partyId,
        input.allowedSubsidiaryIds ?? null,
        "share",
        { orgWideNull: true },
      );
    } catch (error) {
      if (error instanceof ScopeNotFoundError) {
        throw new PayrollError("nothing to remit to this vendor for the period");
      }
      throw error;
    }

    const vendor = (await tx.execute<{ party_id: string | null; subsidiary_id: string | null }>(sql`
      select p.id as party_id, p.subsidiary_id
        from vendor_roles v
        left join parties p on p.id = v.party_id and p.org_id = v.org_id
       where v.org_id = ${orgId} and v.party_id = ${input.partyId} and v.is_active
    `, "objects"));
    if (!vendor.length) throw new PayrollError("the remittance destination must be an active vendor");
    if (
      input.allowedSubsidiaryIds != null
      && (!(vendor[0]!.party_id)
        || !payrollSubsidiaryInScope(
          input.allowedSubsidiaryIds,
          vendor[0]!.subsidiary_id ?? entityId,
        ))
    ) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, entityId)) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }

    // The registration this run is filed under — metadata ABOUT the
    // obligation, never the bill's entity. When it names another entity, the
    // run was filed under the wrong registration: refuse, naming both.
    const filing = filingAccountId
      ? (await tx.execute<{
        subsidiary_id: string | null; account_number: string | null; name: string | null;
      }>(sql`
        select subsidiary_id, account_number, name from payroll_filing_accounts
         where org_id = ${orgId} and id = ${filingAccountId} and is_active
      `, "objects"))[0] ?? null
      : null;
    if (filingAccountId && !filing) throw new PayrollError("nothing to remit to this vendor for the period");
    if (
      input.allowedSubsidiaryIds != null
      && filing
      && !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, filing.subsidiary_id ?? entityId)
    ) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }

    // Recompute from this transaction's snapshot only after the entity fence
    // is held. A pay run committed after a caller's preflight summary is
    // therefore included in this canonical bill, rather than stranded behind
    // an exact-period duplicate marker.
    const groups = await payrollRemittanceSummary(
      orgId,
      { from: input.from, to: input.to },
      input.allowedSubsidiaryIds,
      tx,
    );
    const group = groups.find(
      (g) => g.partyId === input.partyId && g.filingAccount.id === filingAccountId,
    );
    if (!group) throw new PayrollError("nothing to remit to this vendor for the period");
    // Fail closed for this run's boxes only: a group carrying unattributed
    // legacy accruals must not become a remittance bill under any account
    // until those stubs are reconciled. Every other group still bills.
    if (group.hasUnknownFilingAccount) {
      throw new PayrollError(
        "this remittance group includes payroll with an unknown historical filing account — reconcile its original payroll evidence before remitting",
      );
    }
    // A bill is stamped with the entity whose books credited the accruals.
    // Entityless rows stay in the consolidated group only: billing the
    // attributed slices while unattributed money sits in the same group
    // would remit a partial period as if it were whole.
    if (group.hasEntitylessAccruals) {
      throw new PayrollError(
        "this remittance group includes payroll with no legal entity — attribute its pay runs "
        + "to an active subsidiary before remitting (open the pay run and choose Attribute entity)",
      );
    }
    const slice = pickRemittanceSlice(group, input.subsidiaryId ?? null);
    if (slice.subsidiaryId !== entityId) {
      // The group re-sliced between preflight and fence: another entity's
      // payroll committed (or voided) while this creator waited. Refuse
      // rather than bill a slice the caller never saw.
      throw new PayrollError("nothing to remit to this vendor for the period");
    }
    // Liability-account assignment is checked against the lines this bill
    // will actually consume (below): a line an earlier bill already covered
    // was assigned then, and only the remainder can refuse now.

    // The AUTHORITATIVE entity resolution. The summary labelled this slice
    // from its own snapshot; the bill stamps what the subsidiaries table says
    // in this transaction — an inactive entity, a missing currency, or
    // accruals that do not belong to one currency cannot become a bill.
    const entity = (await tx.execute<{ id: string; name: string | null; base_currency: string | null }>(sql`
      select id, name, base_currency from subsidiaries
       where org_id = ${orgId} and id = ${entityId} and is_active
    `, "objects"))[0] ?? null;
    if (!entity) {
      throw new PayrollError(
        `cannot remit this payroll: its subsidiary is missing or inactive — attribute its pay runs to an active subsidiary before remitting`,
      );
    }
    if (!entity.base_currency) {
      throw new PayrollError(
        `cannot remit ${entity.name ?? "this entity"}'s payroll: it has no base currency — set one on the subsidiary before remitting`,
      );
    }
    const stubCurrencies = await sliceStubCurrencies(tx, orgId, {
      from: input.from, to: input.to, partyId: input.partyId, filingAccountId, entityId,
    });
    if (stubCurrencies.length !== 1 || stubCurrencies[0] !== entity.base_currency) {
      throw new PayrollError(
        `cannot remit ${entity.name ?? "this entity"}'s payroll in ${entity.base_currency}: `
        + `its accruals are stated in ${stubCurrencies.length ? stubCurrencies.join(", ") : "no currency"} `
        + "— reconcile the pay runs before remitting",
      );
    }

    // Payroll filed under another entity's registration is a compliance fact,
    // not a preference. The filing account's entity must equal the accruals'
    // entity; when it does not, the message names both entities and the runs
    // behind the slice so the operator can act without opening a console.
    if (filing && filing.subsidiary_id != null && filing.subsidiary_id !== entityId) {
      const accountEntity = (await tx.execute<{ name: string | null }>(sql`
        select name from subsidiaries where org_id = ${orgId} and id = ${filing.subsidiary_id}
      `, "objects"))[0]?.name ?? null;
      const runs = (await tx.execute<{ document_number: string }>(sql`
        select distinct d.document_number
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where s.org_id = ${orgId} and s.pay_date between ${input.from} and ${input.to}
           and d.subsidiary_id = ${entityId}
           and s.filing_account_id is not distinct from ${filingAccountId}
         order by d.document_number
      `, "objects")).map((r) => r.document_number);
      throw new PayrollError(
        `cannot remit ${entity.name ?? "this entity"}'s payroll under filing account `
        + `${filing.account_number ?? filing.name ?? filingAccountId} `
        + `(registered to ${accountEntity ?? "another entity"}): `
        + `pay run${runs.length === 1 ? "" : "s"} ${runs.length ? runs.join(", ") : "unknown"} `
        + `accrued on ${entity.name ?? "this entity"}'s books — remit under `
        + `${entity.name ?? "this entity"}'s registration instead`,
      );
    }

    // The structured marker written below is the bill's identity. Search live
    // markers for this destination/account/entity and reject any intersecting
    // date window, not only exact from/to equality. A legacy bill with no
    // entity marker covered the consolidated group, so it fails closed for
    // every slice rather than risking a double remittance — unless coverage
    // proves exactly which lines it consumed (below), in which case a later
    // same-window bill covers only the unbilled remainder.
    const overlap = (await tx.execute<{
      id: string; document_number: string | null; subsidiary_id: string | null; from: string; to: string;
    }>(sql`
      select id::text as id, document_number, subsidiary_id,
             custom->'payrollRemittance'->>'from' as from,
             custom->'payrollRemittance'->>'to' as to
        from documents
       where org_id = ${orgId} and kind = 'vendor_bill' and status <> 'voided'
         and custom->'payrollRemittance'->>'partyId' = ${input.partyId}
         and custom->'payrollRemittance'->>'from' <= ${input.to}
         and custom->'payrollRemittance'->>'to' >= ${input.from}
         and (custom->'payrollRemittance'->>'filingAccountId') is not distinct from ${filingAccountId}
         and ((custom->'payrollRemittance'->>'subsidiaryId') is null
              or (custom->'payrollRemittance'->>'subsidiaryId') = ${entityId})
      order by custom->'payrollRemittance'->>'from', created_at
    `, "objects"));
    const existing = overlap[0];
    // Refuse by name over an intersecting live bill. The first bill whose
    // window matches exactly keeps the established idempotency message; any
    // other overlap names both windows so a controller can choose a
    // non-overlapping correction period without guessing.
    const refuseOverlapping = (found: NonNullable<typeof existing>): never => {
      // Keep the overlap fence org-wide: hiding a conflicting document must
      // never permit a duplicate liability bill. Its identifying metadata is
      // only available to actors who can read that document's legal entity.
      if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, found.subsidiary_id)) {
        throw new PayrollError("nothing to remit to this vendor for the period");
      }
      const exact = found.from === input.from && found.to === input.to;
      const refusal = exact
        ? duplicateRemittanceMessage({ documentNumber: found.document_number })
        : overlappingRemittanceMessage({
            documentNumber: found.document_number,
            from: found.from,
            to: found.to,
          });
      if (refusal) throw new PayrollError(refusal);
      throw new PayrollError("nothing to remit to this vendor for the period");
    };

    // Number off the org's EXISTING vendor_bill series — its prefix, padding
    // and current position — falling back to seeding the org-level 'BILL-'
    // series only when the org has no vendor_bill numbering at all. The
    // billed entity's own series wins, exactly like the AP path's rule.
    const sequences = (await tx.execute<{ prefix: string; subsidiary_id: string | null }>(sql`
      select prefix, subsidiary_id from number_sequences
       where org_id = ${orgId} and document_kind = 'vendor_bill'
         and (subsidiary_id = ${entityId} or subsidiary_id is null)
    `, "objects"));
    const chosen = pickRemittanceSequence(
      sequences.map((row) => ({ prefix: row.prefix, subsidiaryId: row.subsidiary_id })),
      entityId,
    );
    const seq = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'vendor_bill', ${chosen?.subsidiaryId ?? null}, ${chosen?.prefix ?? "BILL-"})
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${orgId}
      returning prefix, next_number, padding
    `, "objects"));
    const number = `${seq[0]!.prefix}${String(seq[0]!.next_number).padStart(seq[0]!.padding, "0")}`;

    // Per-accrual coverage (migration 0296): record exactly which committed
    // lines this bill consumed, resolved through the same resolver the
    // summary folds by — including region-scoped rows whose snapshot party
    // is not their resolved destination. The equality below is the insert's
    // own receipt: coverage that does not sum to the billed slice is a
    // failure, not a success.
    const creatorResolution = makeRemittanceDestinationResolver(await rawPayrollSettings(orgId, tx));
    const billed = (await remittanceScopeLines(tx, orgId, {
      from: input.from, to: input.to, filingAccountId, entityId,
    })).filter((line) =>
      !creatorResolution.isInternalAccrual(line)
      && creatorResolution.resolveDestination(line).partyId === input.partyId,
    );
    const billedTotal = sum(billed.map((line) => (line.kind === "credit" ? neg(line.amount) : line.amount)));
    const scopeTotal = sum(slice.components.map((c) => c.amount));
    if (cmp(billedTotal, scopeTotal) !== 0) {
      throw new PayrollError(
        "remittance bill coverage does not match the billed payroll — regenerate this bill",
      );
    }
    // Coverage-aware remainder: lines a live bill already consumed are never
    // billed twice. A later same-window run bills only its unbilled lines;
    // with nothing left unbilled the fence refusals above still apply, so an
    // exact re-run keeps the established duplicate message.
    const coveredLineIds = await coveredRemittanceStubLines(tx, orgId);
    const billable = billed.filter((line) => !coveredLineIds.has(line.lineId));
    if (billable.length === 0) {
      if (existing) refuseOverlapping(existing);
      throw new PayrollError("nothing to remit to this vendor for the period");
    }
    if (existing) {
      // An intersecting live bill with no coverage rows consumed an
      // unknowable set (a legacy bill the 0296 repair could not reconcile):
      // no remainder can be proven against its window, so fail closed.
      const blind = await remittanceBillsWithoutCoverage(
        tx,
        orgId,
        overlap.map((bill) => bill.id),
      );
      if (blind.length > 0) refuseOverlapping(existing);
    }
    // Aggregate the remainder by the same (component, kind, liability
    // account) identity the summary folds by, in first-seen line order, so
    // the bill debits exactly the accounts its own lines credited.
    const entries: {
      componentId: string; kind: RemittanceScopeLine["kind"]; name: string;
      liabilityAccountId: string | null; amount: string;
    }[] = [];
    for (const line of billable) {
      const amount = line.kind === "credit" ? neg(line.amount) : line.amount;
      const found = entries.find((entry) =>
        entry.componentId === line.componentId
        && entry.kind === line.kind
        && entry.liabilityAccountId === line.liabilityAccountId,
      );
      if (found) found.amount = add(found.amount, amount);
      else {
        entries.push({
          componentId: line.componentId,
          kind: line.kind,
          name: line.componentName,
          liabilityAccountId: line.liabilityAccountId,
          amount,
        });
      }
    }
    const missing = entries.filter((entry) => !entry.liabilityAccountId);
    if (missing.length > 0) {
      throw new PayrollError(
        `no liability account for: ${missing.map((entry) => entry.name).join(", ")} — set it in Payroll setup → Accounts & posting`,
      );
    }
    const total = sum(entries.map((entry) => entry.amount));
    if (cmp(sum(billable.map((line) => (line.kind === "credit" ? neg(line.amount) : line.amount))), total) !== 0) {
      throw new PayrollError(
        "remittance bill coverage does not match the billed payroll — regenerate this bill",
      );
    }
    // The bill's due date comes from the destination's pack-declared schedule.
    // Filing-account remitter types feed only schedules that declare that
    // source; an undated destination refuses instead of borrowing a timetable.
    const dueDate = remittanceGroupDueDate(group, input.to);
    const doc = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date,
                             due_date, currency, status, memo, subtotal, tax_total, total, custom,
                             created_by, updated_by)
      values (${orgId}, 'vendor_bill', ${number}, ${input.partyId}, ${entityId}, ${input.to},
              ${dueDate},
              ${entity.base_currency}, 'draft',
              ${remittanceMemo(group, input.from, input.to, group.slices.length > 1 ? (entity.name ?? null) : null)}, ${total}, '0', ${total},
              ${JSON.stringify({
                payrollRemittance: {
                  partyId: input.partyId, from: input.from, to: input.to, filingAccountId,
                  subsidiaryId: entityId,
                  // The filing account's CRA registration, for operators
                  // reconciling the bill against the PD7A. It did NOT date
                  // this bill when a destination schedule governs — see
                  // `schedule`, which names what did.
                  remitterType: group.filingAccount.remitterType,
                  schedule: group.schedule
                    ? {
                        vendorSettingsKey: group.schedule.vendorSettingsKey,
                        authority: group.schedule.authority,
                        frequency: group.schedule.frequency,
                      }
                    : null,
                },
              })}::jsonb,
              ${actorId}, ${actorId})
      returning id
    `, "objects"));
    const documentId = doc[0]!.id;
    let lineNumber = 1;
    for (const entry of entries) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${entry.liabilityAccountId},
                ${`${entry.name} · ${input.from} – ${input.to}`}, 1, ${entry.amount},
                ${entry.amount}, ${actorId}, ${actorId})
      `);
    }
    // The remainder's own coverage rows: one per consumed line, never one per
    // bill. The row count below is the insert's receipt — a short write means
    // a later same-window bill would re-bill the missing line, so refuse.
    const covered = (await tx.execute<{ stub_line_id: string }>(sql`
      insert into payroll_remittance_coverage (org_id, bill_document_id, stub_line_id, amount, created_by)
      select ${orgId}, ${documentId}, cov.line_id, cov.line_amount::numeric, ${actorId}
        from unnest(${`{${billable.map((line) => line.lineId).join(",")}}`}::uuid[],
                    ${`{${billable.map((line) => line.amount).join(",")}}`}::text[]) as cov(line_id, line_amount)
      returning stub_line_id::text as stub_line_id
    `, "objects"));
    if (covered.length !== billable.length) {
      throw new PayrollError(
        "remittance bill coverage was not recorded — regenerate this bill",
      );
    }
    return { documentId, documentNumber: number };
  }, { isolationLevel: "read committed" });
}
