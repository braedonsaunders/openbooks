import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { orgContext, pool, type SqlExecutor } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import {
  openingSourceYearFenceKey,
  takeOpeningSourceYearFence,
} from "../organization/payroll-source-fence.ts";

const reportingSnapshot = new AsyncLocalStorage<{
  orgId: string;
  taxYear: number;
  runner: SqlExecutor;
}>();

/** Acquire the source fence before a reporting snapshot, and reuse that exact snapshot in every nested builder. */
export async function withOpeningReportingSnapshot<T>(
  orgId: string,
  taxYear: number,
  fn: (runner: SqlExecutor) => Promise<T>,
  issuing = false,
): Promise<T> {
  const pinned = reportingSnapshot.getStore();
  if (pinned) {
    if (pinned.orgId !== orgId || pinned.taxYear !== taxYear)
      throw new PayrollError(
        "The payroll reporting snapshot belongs to a different organization or source year",
      );
    return fn(pinned.runner);
  }
  const active = orgContext.getStore();
  if (active?.txDb && !active.bypass) {
    if (active.orgId !== orgId)
      throw new PayrollError(
        "The payroll reporting organization cannot change inside an active transaction",
      );
    const mode = (
      await active.txDb.execute<{ transaction_isolation: string }>(
        sql`show transaction_isolation`,
        "objects",
      )
    )[0]?.transaction_isolation;
    if (mode === "read committed") {
      await takeOpeningSourceYearFence(active.txDb, orgId, taxYear);
      return reportingSnapshot.run({ orgId, taxYear, runner: active.txDb }, () => fn(active.txDb!));
    }
    if (issuing)
      throw new PayrollError(
        "The filing issue must acquire its opening source fence before taking a reporting snapshot; retry the native issue command outside the existing snapshot transaction",
      );
  }
  const client = await pool.connect();
  const key = openingSourceYearFenceKey(orgId, taxYear);
  let held = false,
    discard = false;
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
    held = true;
    await client.query("begin isolation level repeatable read");
    await client.query(
      "select set_config('app.current_org',$1,true),set_config('app.bypass_rls','off',true)",
      [orgId],
    );
    const runner = drizzle({ client });
    const result = await orgContext.run({ orgId, bypass: false, txDb: runner }, () =>
      reportingSnapshot.run({ orgId, taxYear, runner }, () => fn(runner)),
    );
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    if (held) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock(hashtextextended($1,0)) as unlocked",
          [key],
        );
        discard ||= unlocked.rows[0]?.unlocked !== true;
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
}
