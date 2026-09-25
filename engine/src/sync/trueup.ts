import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { db, withOrg } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { civilDateFromParts, daysInCivilMonth } from "../platform/business-date.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { postEntry } from "../journal/post-entry.ts";
import type { MigrationSource } from "./source.ts";

/**
 * GL residual trueup — the migration's opening-balance / sub-ledger reconciler.
 *
 * Native documents reproduce AR/AP/payments exactly, but some source GL has no
 * importable document form: perpetual-inventory valuation (COGS, shrinkage —
 * the source computes it and the API never exposes the amount), realized FX on
 * settlement, and opening balances. For those, the honest migration treatment
 * is what a controller does by hand — bring them in as dated adjusting journal
 * entries. This posts, per posting month, the residual between the source's own
 * per-account GL (source.monthlyActivity, debit-positive, home currency) and
 * what our native documents posted. Each month nets to zero (double-entry), so
 * the entry balances; a sub-cent rounding drift is absorbed on the largest line.
 *
 * Trueup lines are is_open_item=false, so AR/AP aging (driven by the native
 * documents + applications) is untouched. Idempotent: once trued, the residual
 * is zero and re-runs post nothing. A NO-OP where native import is already
 * penny-exact (e.g. NetSuite) — nothing is posted. Only months the source
 * reported are compared: a month absent from the source population is unknown,
 * never zero, so activity older than a report-windowed adapter's coverage is
 * left alone instead of reversed.
 */

export interface TrueUpStats {
  entries: number;
  lines: number;
  byAccount: { account: string; amount: string }[];
}

export interface TrueUpControlContext {
  /** Human actor when a user launched the sync; null means connector/system. */
  actorId?: string | null;
  /** Immutable sync-run attribution for connector-initiated adjustments. */
  syncRunId?: string | null;
}

const MONTH_END = (m: string): string => {
  const [y, mo] = m.split("-").map(Number);
  // daysInCivilMonth keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999.
  return civilDateFromParts(y!, mo!, daysInCivilMonth(y!, mo!));
};

export async function trueUpResidualGl(
  orgId: string,
  source: MigrationSource,
  control: TrueUpControlContext = {},
): Promise<TrueUpStats> {
  const refKey = source.refKey;
  const empty: TrueUpStats = { entries: 0, lines: 0, byAccount: [] };
  const srcRows = await source.monthlyActivity();
  // Carried balances predating a bounded history window. A company with no
  // in-range activity still needs its opening journal, so the early return
  // below requires BOTH populations to be empty.
  const openingRows = typeof source.openingBalances === "function" ? await source.openingBalances() : [];
  if (srcRows.length === 0 && openingRows.length === 0) return empty;

  return withOrg(orgId, async () => {
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`migration-gl-trueup:${orgId}:${source.name}`}, 0)
      )
    `);
    const org = (await db.execute<{ base_currency: string }>(sql`
      select base_currency
        from orgs
       where id = ${orgId}
    `));
    if (!org.rows[0]) throw new Error("true-up organization not found");
    if (org.rows[0].base_currency !== source.baseCurrency) {
      throw new Error(
        `true-up source currency ${source.baseCurrency} does not match organization base currency ${org.rows[0].base_currency}`,
      );
    }
    // The shared active posting primary: opening balances must land where
    // the posting run writes, never a deactivated primary.
    const bookId = await activePostingPrimaryBookId(orgId);
    if (!bookId) throw new Error("true-up requires a primary accounting book");
    const subRow = (await db.execute<{ id: string }>(sql`
      select id
        from subsidiaries
       where org_id = ${orgId} and parent_id is null
       limit 1
    `));
    const subsidiaryId = subRow.rows[0]?.id;
    if (!subsidiaryId) throw new Error("true-up requires a root subsidiary");

    const accRows = (await db.execute<{ id: string; ref: string }>(sql`
      select id, custom->>${refKey} as ref
        from accounts
       where org_id = ${orgId}
         and custom->>${refKey} is not null
    `));
    const idByRef = new Map(
      accRows.rows.map((row) => [row.ref, row.id] as const),
    );
    const missingRefs = [
      ...new Set(
        srcRows
          .map((row) => row.accountRef)
          .filter((accountRef) => !idByRef.has(accountRef)),
      ),
    ].sort();
    if (missingRefs.length > 0) {
      throw new Error(
        `true-up cannot silently omit ${missingRefs.length} unmapped source account(s): ${missingRefs.join(", ")}`,
      );
    }
    for (const row of srcRows) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)) {
        throw new Error(`invalid true-up source month ${row.month}`);
      }
    }
    // Refuse by name before posting anything: the ledger would reject an
    // inactive account mid-run, after earlier months already posted. Name
    // each inactive account and the remedy instead.
    const touchedAccountIds = [
      ...new Set(
        [...srcRows, ...openingRows]
          .map((row) => idByRef.get(row.accountRef))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (touchedAccountIds.length > 0) {
      const inactive = (
        await db.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${orgId}
             and id in (${sql.join(touchedAccountIds.map((id) => sql`${id}::uuid`), sql`, `)})
             and is_active is distinct from true`)
      ).rows.map((row) => row.id);
      if (inactive.length > 0) {
        throw new Error(
          `true-up account ${inactive.sort().join(", ")} is inactive; reactivate the account before re-syncing ${source.name}`,
        );
      }
    }

    const byAccountTotal = new Map<string, bigint>();
    let entries = 0;
    let lines = 0;

    // -- Opening balances ------------------------------------------------------
    // One governed opening-balance journal on the history start date for the
    // carried balances, through the same posting path as the monthly
    // residuals below (never a raw insert). The lines tie to the opening
    // trial balance exactly, and the entry carries the connector_trueup
    // projection marker so verification counts it — with an openingBalance
    // flag so the monthly residual comparison (which knows only in-window
    // activity) leaves it alone. Idempotent: a re-sync skips when the posted
    // opening journal ties exactly, and refuses instead of double-posting
    // when it differs.
    const openingDates = [...new Set(openingRows.map((row) => row.openingDate))];
    if (openingDates.length > 1) {
      throw new Error(`true-up cannot post opening balances for multiple dates: ${openingDates.sort().join(", ")}`);
    }
    const openingDate = openingDates[0];
    if (openingDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) {
        throw new Error(`invalid true-up opening date ${openingDate}`);
      }
      const openingRefs = [...new Set(openingRows.map((row) => row.accountRef).filter((accountRef) => !idByRef.has(accountRef)))].sort();
      if (openingRefs.length > 0) {
        throw new Error(
          `true-up cannot silently omit ${openingRefs.length} unmapped opening-balance account(s): ${openingRefs.join(", ")}`,
        );
      }
      const openingUnits = new Map<string, bigint>();
      for (const row of openingRows) {
        const units = toUnits(row.amount);
        if (units === 0n) continue;
        const accountId = idByRef.get(row.accountRef)!;
        openingUnits.set(accountId, (openingUnits.get(accountId) ?? 0n) + units);
      }
      if (openingUnits.size > 0) {
        const openingNet = [...openingUnits.values()].reduce((total, units) => total + units, 0n);
        if (openingNet !== 0n) {
          throw new Error(
            `source opening balance for ${openingDate} is unbalanced by ${fromUnits(openingNet)}; true-up refused instead of posting an unbalanced opening journal`,
          );
        }
        const existing = (await db.execute<{ id: string }>(sql`
          select id from journal_entries
           where org_id = ${orgId} and status = 'posted'
             and custom->'sourceProjection'->>'kind' = 'connector_trueup'
             and custom->'sourceProjection'->>'sourceName' = ${source.name}
             and custom->'sourceProjection'->>'refKey' = ${refKey}
             and coalesce(custom->'sourceProjection'->>'openingBalance', 'false') = 'true'
        `));
        if (existing.rows.length > 0) {
          const have = (await db.execute<{ account_id: string; amount: string }>(sql`
            select jl.account_id, sum(jl.amount)::text as amount
              from journal_lines jl
              join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
             where jl.org_id = ${orgId}
               and e.id in (${sql.join(existing.rows.map((row) => sql`${row.id}`), sql`, `)})
             group by jl.account_id
          `));
          const haveByAccount = new Map(have.rows.map((row) => [row.account_id, toUnits(row.amount)] as const));
          const ties = haveByAccount.size === openingUnits.size
            && [...openingUnits.entries()].every(([accountId, units]) => haveByAccount.get(accountId) === units);
          if (!ties) {
            throw new Error(
              `a posted opening-balance journal for ${source.name} already exists with different lines; reverse it before re-syncing the opening balance for ${openingDate}`,
            );
          }
        } else {
          const periodId = (await resolveCoveringPeriod(db, orgId, openingDate))?.id;
          if (!periodId) {
            throw new Error(`no accounting period covers true-up opening date ${openingDate}`);
          }
          await assertPeriodModulesOpen(db, {
            orgId,
            periodId,
            bookId,
            subsidiaryIds: [subsidiaryId],
            modules: ["gl"],
          });
          // Every journal write routes through the ONE ledger API: the
          // true-up audit payload travels with the posting.
          const entryId = randomUUID();
          const postedOpening = await postEntry(db, {
            id: entryId,
            orgId,
            bookId,
            subsidiaryId,
            entryNumber: `OPENING-${openingDate}-${entryId.slice(0, 8)}`,
            postingDate: openingDate,
            periodId,
            memo: `Migration opening balance ${source.name} ${openingDate}`,
            origin: "migration",
            custom: {
              sourceProjection: {
                kind: "connector_trueup",
                sourceName: source.name,
                refKey,
                syncRunId: control.syncRunId ?? null,
                openingBalance: true,
                openingDate,
              },
            },
            actorId: control.actorId,
            currency: org.rows[0].base_currency,
            closeModules: ["gl"],
            auditAction: "insert",
            requestId: control.syncRunId ?? "migration_gl_opening_balance",
            auditChanges: {
              mode: "migration_gl_opening_balance",
              source: source.name,
              openingDate,
              syncRunId: control.syncRunId ?? null,
              lineCount: openingUnits.size,
            },
            lines: [...openingUnits.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([accountId, units]) => ({
                accountId,
                amount: fromUnits(units),
              })),
          });
          if (postedOpening.entryId !== entryId)
            throw new Error("true-up opening balance was not posted");
          for (const [accountId, units] of openingUnits) {
            byAccountTotal.set(accountId, (byAccountTotal.get(accountId) ?? 0n) + units);
            lines++;
          }
          entries++;
        }
      }
    }

    const oursRows = (await db.execute<{ account_id: string; month: string; amount: string }>(sql`
      select jl.account_id, to_char(e.posting_date, 'YYYY-MM') as month,
             sum(jl.amount)::text as amount
        from journal_lines jl
        join journal_entries e
          on e.id = jl.entry_id and e.org_id = jl.org_id
       where jl.org_id = ${orgId}
         and e.status in ('posted', 'reversed')
         and (
           exists (
             select 1
               from documents source_document
              where source_document.id = e.source_document_id
                and source_document.org_id = e.org_id
                and source_document.custom->>${refKey} is not null
           )
           or (
             e.custom->'sourceProjection'->>'kind' = 'connector_trueup'
             and e.custom->'sourceProjection'->>'sourceName' = ${source.name}
             and e.custom->'sourceProjection'->>'refKey' = ${refKey}
           )
         )
         -- Opening-balance journals are reconciled against the opening trial
         -- balance by the dedicated check above, not against in-window
         -- monthly activity: including them here would read the carried
         -- balance as same-month activity and residual it away.
         and coalesce(e.custom->'sourceProjection'->>'openingBalance', 'false') <> 'true'
       group by jl.account_id, to_char(e.posting_date, 'YYYY-MM')
    `));
    const ours = new Map<string, bigint>();
    for (const row of oursRows.rows) {
      ours.set(
        `${row.account_id}|${row.month}`,
        toUnits(row.amount),
      );
    }

    const residualByMonth = new Map<string, Map<string, bigint>>();
    const seen = new Set<string>();
    const bump = (month: string, accountId: string, units: bigint) => {
      if (units === 0n) return;
      const monthRows =
        residualByMonth.get(month) ?? new Map<string, bigint>();
      monthRows.set(accountId, (monthRows.get(accountId) ?? 0n) + units);
      residualByMonth.set(month, monthRows);
    };
    for (const sourceRow of srcRows) {
      const accountId = idByRef.get(sourceRow.accountRef)!;
      const key = `${accountId}|${sourceRow.month}`;
      // Multiple source rows for one account/month contribute to one source
      // total. Subtract our total once, after source aggregation.
      const monthRows =
        residualByMonth.get(sourceRow.month) ?? new Map<string, bigint>();
      monthRows.set(
        accountId,
        (monthRows.get(accountId) ?? 0n) + toUnits(sourceRow.amount),
      );
      residualByMonth.set(sourceRow.month, monthRows);
      seen.add(key);
    }
    // Months the source actually reported. A month absent from the source
    // population is UNKNOWN — never zero: our activity there (e.g. older
    // than a report-windowed adapter's coverage) must be left alone, not
    // reversed. Both branches below therefore only fire inside coverage.
    const coveredMonths = new Set(srcRows.map((row) => row.month));
    for (const [key, amount] of ours) {
      const [accountId, month] = key.split("|") as [string, string];
      if (!coveredMonths.has(month)) continue;
      if (seen.has(key)) bump(month, accountId, -amount);
      else if (amount !== 0n) bump(month, accountId, -amount);
    }

    // No migration flag: true-up residuals are ordinary postings by a
    // user-launched sync, not a migration, so every posting check applies —
    // including the inactive-account refusal. A narrower waiver would hide
    // exactly the misconfiguration (a deactivated account) the operator
    // must see.
    for (const [month, accounts] of [...residualByMonth.entries()].sort()) {
      const entryLines = [...accounts.entries()].filter(
        ([, units]) => units !== 0n,
      );
      if (entryLines.length === 0) continue;
      const net = entryLines.reduce(
        (total, [, units]) => total + units,
        0n,
      );
      if (net !== 0n) {
        throw new Error(
          `source residual for ${month} is unbalanced by ${fromUnits(net)}; true-up refused instead of silently changing a source amount`,
        );
      }
      const endOn = MONTH_END(month);
      // Ordinary posting: shared covering-period resolver (default
      // calendar, regular periods, deterministic under overlaps).
      const periodId = (await resolveCoveringPeriod(db, orgId, endOn))?.id;
      if (!periodId) {
        throw new Error(`no accounting period covers true-up month ${month}`);
      }
      await assertPeriodModulesOpen(db, {
        orgId,
        periodId,
        bookId,
        subsidiaryIds: [subsidiaryId],
        modules: ["gl"],
      });

      // The id is client-generated randomUUID (v4) — never a DB uuidv7 whose
      // leading bytes repeat for ~50 days — so the whole id is a collision-
      // free per-generation salt under journal_entries_org_number.
      // Every journal write routes through the ONE ledger API: the true-up
      // audit payload travels with the posting.
      const entryId = randomUUID();
      const postedTrueup = await postEntry(db, {
        id: entryId,
        orgId,
        bookId,
        subsidiaryId,
        entryNumber: `TRUEUP-${month}-${entryId}`,
        postingDate: endOn,
        periodId,
        memo: `Migration GL true-up ${source.name} ${month}`,
        origin: "migration",
        custom: {
          sourceProjection: {
            kind: "connector_trueup",
            sourceName: source.name,
            refKey,
            syncRunId: control.syncRunId ?? null,
          },
        },
        actorId: control.actorId,
        currency: org.rows[0].base_currency,
        closeModules: ["gl"],
        auditAction: "insert",
        requestId: control.syncRunId ?? "migration_gl_trueup",
        auditChanges: {
          mode: "migration_gl_trueup",
          source: source.name,
          month,
          syncRunId: control.syncRunId ?? null,
          lineCount: entryLines.length,
        },
        lines: entryLines.map(([accountId, units]) => ({
          accountId,
          amount: fromUnits(units),
        })),
      });
      if (postedTrueup.entryId !== entryId)
        throw new Error("true-up residual was not posted");
      for (const [accountId, units] of entryLines) {
        byAccountTotal.set(
          accountId,
          (byAccountTotal.get(accountId) ?? 0n) + units,
        );
        lines++;
      }
      entries++;
    }
    return {
      entries,
      lines,
      byAccount: [...byAccountTotal.entries()].map(([account, units]) => ({
        account,
        amount: fromUnits(units),
      })),
    };
  });
}
