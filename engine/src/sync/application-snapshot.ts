import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";
import { schema, type SqlExecutor } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { authorizeConnectorReplay } from "../journal/replay-authorization.ts";

export interface CompleteApplicationSnapshot {
  complete: true;
  connectionId: string;
  source: string;
  syncRunId?: string;
}

export interface SourceApplicationEvidence {
  id: string;
  payment_ref: string;
  applied_ref: string;
  from_line_id: string;
  to_line_id: string;
  source_amount: string;
  applied_on: string;
  book_id: string;
  subsidiary_id: string;
  account_type: string;
  account_ref: string | null;
  fx_gain_loss_entry_id: string | null;
  evidence: Record<string, unknown>;
}

const sourceKeys: Record<string, string> = {
  netsuite: "nsId", qbo: "qboId", qbd: "qbdId", xero: "xeroId",
  odoo: "odooId", erpnext: "erpId", dynamics: "bcId",
};
const dialect = new PgDialect();

export function sourceConnectionDocumentPredicate(alias: string, connection: string, source: string): string {
  return `(
    ${alias}.custom->>'connectionId'=${connection}
    or (
      not exists (select 1 from connections stamped where stamped.org_id=$1 and stamped.id::text=${alias}.custom->>'connectionId')
      and not exists (select 1 from connections sibling where sibling.org_id=$1 and sibling.source=${source} and sibling.id<>${connection}::uuid)
    )
  )`;
}

/** Render native ledger/period commands onto the reconciliation transaction. */
export function applicationTransaction(client: PoolClient): SqlExecutor {
  return {
    execute: (async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      return { rows: (await client.query(query.sql, query.params)).rows };
    }) as SqlExecutor["execute"],
  };
}

/** Keep replay posting flags inside the native FX posting boundary. Allocation
 * inserts still run with the ordinary endpoint and exact settlement guards. */
export async function postSourceSettlementEntry(
  client: PoolClient,
  input: Parameters<typeof postEntry>[1],
): Promise<Awaited<ReturnType<typeof postEntry>>> {
  const replay = (await client.query<{ allowed: boolean; migration: string | null }>(
    "select connector_historical_replay_authorized($1) as allowed,current_setting('openbooks.migration',true) as migration",
    [input.orgId],
  )).rows[0];
  if (replay?.allowed) await client.query("select set_config('openbooks.migration','on',true)");
  // A posting refusal aborts the surrounding transaction; do not replace its
  // original cause with an attempted command on that aborted transaction.
  const posted = await postEntry(applicationTransaction(client), input);
  if (replay?.allowed) await client.query("select set_config('openbooks.migration',$1,true)", [replay.migration ?? 'off']);
  return posted;
}

/** Only connector-owned application evidence may follow an authoritative snapshot.
 * Legacy migration-labelled, actorless applications retain their imported provenance.
 * Legacy unstamped documents require one unambiguous connection, matching the
 * native document mirror. Controller dispositions and manual settlements remain intact. */
export async function sourceApplicationEvidence(
  client: PoolClient,
  orgId: string,
  refKey: string,
  snapshot: CompleteApplicationSnapshot,
): Promise<SourceApplicationEvidence[]> {
  if (sourceKeys[snapshot.source] !== refKey) {
    throw new Error("application snapshot source identity does not match its reference namespace");
  }
  const connection = await client.query<{ id: string }>(
    "select id from connections where org_id=$1 and id=$2 and source=$3",
    [orgId, snapshot.connectionId, snapshot.source],
  );
  if (connection.rows.length !== 1) throw new Error("application snapshot connection is not available in this organization");
  return (await client.query<SourceApplicationEvidence>(`
    select a.id, df.custom->>$2 as payment_ref, dt.custom->>$2 as applied_ref,
           a.from_line_id, a.to_line_id, a.source_amount::text,
           a.applied_on::text, ef.book_id, lf.subsidiary_id,
           account.type as account_type, account.custom->>$2 as account_ref, a.fx_gain_loss_entry_id, row_to_json(a) as evidence
      from applications a
      join journal_lines lf on lf.org_id=a.org_id and lf.id=a.from_line_id
      join journal_entries ef on ef.org_id=a.org_id and ef.id=lf.entry_id
      join documents df on df.org_id=a.org_id and df.id=ef.source_document_id
      join accounts account on account.org_id=a.org_id and account.id=lf.account_id
      join journal_lines lt on lt.org_id=a.org_id and lt.id=a.to_line_id
      join journal_entries et on et.org_id=a.org_id and et.id=lt.entry_id
      join documents dt on dt.org_id=a.org_id and dt.id=et.source_document_id
     where a.org_id=$1 and a.unapplied_at is null
       and (
         a.settlement_rate_reference=$5
         or (a.settlement_rate_reference='migrated same-currency application'
             and a.settlement_rate_source='same_currency' and a.created_by is null)
       )
       and df.custom->>$2 is not null and dt.custom->>$2 is not null
       and ${sourceConnectionDocumentPredicate("df", "$3", "$4")}
       and ${sourceConnectionDocumentPredicate("dt", "$3", "$4")}
       and not exists (
         select 1 from source_deletion_resolutions r
          where r.org_id=$1 and r.connection_id=$3::uuid
            and r.source_ref in (df.custom->>$2,dt.custom->>$2)
       )
     order by a.id`,
    [orgId, refKey, snapshot.connectionId, snapshot.source, `source application ${refKey}`],
  )).rows;
}

/** Release a changed payer's old allocations, retaining every row and its
 * FX lineage. Its complete current links are then allocated by the ordinary
 * reconciler. No payment or invoice journal is edited or reversed here. */
export async function releaseSourceApplications(
  client: PoolClient,
  orgId: string,
  snapshot: CompleteApplicationSnapshot,
  rows: SourceApplicationEvidence[],
  nextEntryNumber: (preferred: string) => Promise<string>,
): Promise<{ count: number; amount: string }> {
  if (!rows.length) return { count: 0, amount: "0.0000" };
  const runner = applicationTransaction(client);
  const ids = rows.map((row) => row.id);
  const periodsChecked = new Set<string>();
  const replayGrants = new Map<string, { authorizationId: string; actorId: string }>();
  let replayActor: string | null = null;
  const admitPeriod = async (periodId: string, bookId: string, subsidiaryId: string, module: "ap" | "ar") => {
    // Share the native close fence through commit. A simultaneous close cannot
    // invalidate the authorization between allocation discovery and release.
    await runner.execute(sql`select period_posting_fence(${orgId}, ${periodId}, ${bookId})`);
    try {
      await assertPeriodModulesOpen(runner, {
        orgId, periodId, bookId, subsidiaryIds: [subsidiaryId], modules: [module],
      });
      return;
    } catch (error) {
      if (!(error instanceof CloseError) || !snapshot.syncRunId) throw error;
      if (!replayActor) {
        const policy = (await client.query<{ actor_id: string }>(`
          select connection.posted_change_authorized_by as actor_id
            from connections connection
            join sync_runs run on run.connection_id=connection.id and run.org_id=connection.org_id
            join users controller on controller.id=connection.posted_change_authorized_by
              and controller.org_id=connection.org_id and controller.is_active
           where connection.org_id=$1 and connection.id=$2 and connection.source=$3
             and run.id=$4 and run.status='running' and run.source=connection.source
             and run.kind in ('incremental','full_migration')
             and connection.status not in ('paused','unconfigured')
             and connection.posted_change_policy='append_only_automatic'
             and connection.posted_change_authorized_at is not null
             and run.started_at>=connection.posted_change_authorized_at
           for share of connection, run, controller`,
          [orgId, snapshot.connectionId, snapshot.source, snapshot.syncRunId],
        )).rows[0];
        if (!policy) throw error;
        await client.query(`select set_config('openbooks.connector_replay','on',true),
          set_config('openbooks.connector_replay_request',$1,true),
          set_config('openbooks.connector_replay_actor',$2,true)`, [snapshot.syncRunId, policy.actor_id]);
        const allowed = (await client.query<{ allowed: boolean }>(
          'select connector_historical_replay_authorized($1) as allowed', [orgId],
        )).rows[0]?.allowed;
        if (allowed !== true) throw error;
        replayActor = policy.actor_id;
      }
      if (!replayGrants.has(periodId)) {
        // Use the same governed connector grant as append-only document replay.
        // The attributable connection policy authorizes this bounded window;
        // the period locks and every original allocation remain in place.
        const grant = await authorizeConnectorReplay(runner, {
          orgId, connectionId: snapshot.connectionId, authorizedBy: replayActor,
          periodFromId: periodId, periodToId: periodId,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          reason: `Controller-authorized ${snapshot.source} source settlement reconciliation for sync run ${snapshot.syncRunId}`,
          actorId: replayActor,
        });
        replayGrants.set(periodId, { authorizationId: grant.id, actorId: replayActor });
      }
    }
  };
  for (const row of rows) {
    const module = row.account_type === "liability_payable" ? "ap" : "ar";
    const key = `${row.applied_on}|${row.book_id}|${row.subsidiary_id}|${module}`;
    if (periodsChecked.has(key)) continue;
    const period = await resolveCoveringPeriod(runner, orgId, row.applied_on);
    if (!period) throw new Error(`no accounting period covers source settlement ${row.applied_on}`);
    await admitPeriod(period.id, row.book_id, row.subsidiary_id, module);
    periodsChecked.add(key);
  }
  const fxIds = [...new Set(rows.flatMap((row) => row.fx_gain_loss_entry_id ? [row.fx_gain_loss_entry_id] : []))];
  if (fxIds.length) {
    const foreignEvidence = await client.query(
      `select id from applications where org_id=$1 and unapplied_at is null
        and fx_gain_loss_entry_id=any($2::uuid[]) and not(id=any($3::uuid[])) limit 1`,
      [orgId, fxIds, ids],
    );
    if (foreignEvidence.rows.length) {
      throw new Error("source settlement FX evidence is shared with another allocation; its ownership must be reconciled before release");
    }
  }
  const released = await client.query<{ id: string }>(
    `update applications set unapplied_at=now(),updated_at=now()
      where org_id=$1 and id=any($2::uuid[]) and unapplied_at is null returning id`,
    [orgId, ids],
  );
  if (released.rows.length !== rows.length) throw new Error("source settlement changed during reconciliation; retry the mirror");

  for (const entryId of fxIds) {
    const entry = (await client.query<{
      id: string; status: string; origin: string; book_id: string; subsidiary_id: string;
      entry_number: string; posting_date: string; period_id: string; source_document_id: string;
    }>(`select *,posting_date::text as posting_date from journal_entries where org_id=$1 and id=$2`, [orgId, entryId])).rows[0];
    if (!entry || entry.status !== "posted" || entry.origin !== "fx_settlement") {
      throw new Error("source settlement FX journal is missing or no longer posted");
    }
    const ownedRow = rows.find((row) => row.fx_gain_loss_entry_id === entryId)!;
    await admitPeriod(entry.period_id, entry.book_id, entry.subsidiary_id,
      ownedRow.account_type === "liability_payable" ? "ap" : "ar");
    const columns = Object.entries(getTableColumns(schema.journalLines))
      .map(([key, column]) => `${column.name} as "${key}"`).join(",");
    const lines = (await client.query<typeof schema.journalLines.$inferSelect>(
      `select ${columns} from journal_lines where org_id=$1 and entry_id=$2 order by line_number`, [orgId, entryId],
    )).rows;
    if (!lines.length) throw new Error("source settlement FX journal has no lines");
    await postSourceSettlementEntry(client, {
      orgId, bookId: entry.book_id, subsidiaryId: entry.subsidiary_id,
      entryNumber: await nextEntryNumber(`${entry.entry_number}-RELEASE`),
      postingDate: entry.posting_date, periodId: entry.period_id,
      memo: "Source settlement allocation changed", origin: "fx_settlement",
      sourceDocumentId: entry.source_document_id, reversesEntryId: entry.id,
      actorId: replayActor, allowInactiveAccounts: true,
      lines: reversalJournalLines(lines, { orgId, entryId: "" }),
    });
    await markEntryReversed(runner, { orgId, entryId, actorId: replayActor });
  }
  for (const row of rows) {
    const audited = await client.query(
      `insert into audit_log(org_id,table_name,row_id,action,changes,actor_id,request_id)
       values($1,'applications',$2,'update',$3::jsonb,$5,$4) returning id`,
      [orgId, row.id, JSON.stringify({
        source: "mirror", reason: "source_settlement_allocation_changed",
        connectionId: snapshot.connectionId, syncRunId: snapshot.syncRunId ?? null,
        paymentRef: row.payment_ref, appliedRef: row.applied_ref,
        before: row.evidence, after: { unapplied: true },
        ...(replayGrants.size ? { historicalReplay: {
          mode: "authenticated_connector_historical_replay",
          authorizations: [...replayGrants].map(([periodId, grant]) => ({ periodId, ...grant })),
          periodLocksPreserved: true,
        } } : {}),
      }), "sync.applications", replayActor],
    );
    if (audited.rows.length !== 1) throw new Error("source settlement release audit was not recorded");
  }
  return { count: rows.length, amount: fromUnits(rows.reduce((total, row) => total + toUnits(row.source_amount), 0n)) };
}
