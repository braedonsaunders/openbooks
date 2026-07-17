import { eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runScheduledScript, computeNextRunAt } from "./scripting.ts";

/**
 * Scheduled-script runner — a real cron-driven loop that polls every 60 s for
 * active scheduled scripts whose next_run_at has passed, runs them, and
 * advances next_run_at to the next cron tick.
 *
 * Single-process (no worker queue); fine for pre-launch single-instance. The
 * UPDATE … WHERE next_run_at = $old RETURNING pattern in tick() naturally
 * serializes when horizontal scaling lands.
 *
 * Started lazily by ensureScheduler() (idempotent singleton) via
 * web/instrumentation.ts so it only runs in the server process.
 */

const TICK_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function ensureScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  tick();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // NOTE: this org-less scan needs a supporting index on user_scripts with
    // column order (trigger_point, is_active, next_run_at).
    const due = (await db.execute(sql`
      select id, org_id as "orgId", cron, next_run_at as "nextRunAt"
        from user_scripts
       where trigger_point = 'scheduled' and is_active and next_run_at <= now()
       order by next_run_at
    `)) as unknown as { rows: { id: string; orgId: string; cron: string | null; nextRunAt: Date }[] };

    for (const s of due.rows) {
      // Claim the run by advancing next_run_at in the same statement. The
      // WHERE next_run_at = $old guard means only one claimer wins; if the
      // process dies mid-run the script stays scheduled for its next tick.
      const next = s.cron ? computeNextRunAt(s.cron) : null;
      const claimed = (await db.execute(sql`
        update user_scripts set next_run_at = ${next}
         where id = ${s.id} and next_run_at = ${s.nextRunAt}
      `)) as unknown as { rowCount?: number };
      if (!claimed.rowCount) continue; // someone else claimed it (or it changed)

      try {
        // Prefer the durable worker (scripts queue); when Redis is down the
        // producer fails fast and the run happens inline in this process.
        let enqueued = false;
        try {
          const { enqueueScriptRun } = await import("@openbooks/jobs");
          await enqueueScriptRun({ orgId: s.orgId, scriptId: s.id, kind: "scheduled" });
          enqueued = true;
        } catch {
          /* Redis unavailable — fall through to inline */
        }
        if (!enqueued) await runScheduledScript(s.id, s.orgId);
      } catch (e) {
        // runScheduledScript writes its own script_runs row for script
        // failures; this catches host-side failures (db insert etc.).
        console.error(`[scheduler] script ${s.id} run failed:`, e);
      }
    }

    // Inbound SFTP bank feeds: scan watch folders and import new statement files.
    try {
      const { runDueSftpImports } = await import("./sftp/import-job.ts");
      await runDueSftpImports();
    } catch (e) {
      console.error("[scheduler] sftp import scan failed:", e);
    }

    // Tenant-configured payment schedules: create draft runs or submit them.
    try {
      const { runDuePaymentSchedules } = await import("./payment-operations.ts");
      await runDuePaymentSchedules();
    } catch (e) {
      console.error("[scheduler] payment schedule scan failed:", e);
    }

    // Flows: scheduled triggers (cron cursor on flows.last_scheduled_run_at).
    try {
      const { runDueScheduledFlows } = await import("./flows/scheduled.ts");
      await runDueScheduledFlows();
    } catch (e) {
      console.error("[scheduler] scheduled flows scan failed:", e);
    }

    // Flows: gate reminder/escalation timers (flow_gates.remind_at/escalate_at).
    try {
      const { processGateTimers } = await import("./flows/gates.ts");
      await processGateTimers();
    } catch (e) {
      console.error("[scheduler] gate timer scan failed:", e);
    }

    // Period close: expire temporary reopen windows and execute deadline rules.
    try {
      const { recloseExpiredReopens, runDueCloseAutomations } = await import("./close.ts");
      await recloseExpiredReopens();
      await runDueCloseAutomations();
    } catch (e) {
      console.error("[scheduler] close automation scan failed:", e);
    }

    // Tenant-configured foreign-exchange feeds. Each due row is claimed with
    // compare-and-swap before its external request, so multiple app servers do
    // not import the same observation concurrently.
    try {
      const { runDueFxProviders } = await import("./fx-providers.ts");
      await runDueFxProviders();
    } catch (e) {
      console.error("[scheduler] FX provider scan failed:", e);
    }

    // Tenant-controlled Accounting and Finance continuous-close agents.
    try {
      const { runDueContinuousCloseAgents } = await import("./continuous-close.ts");
      await runDueContinuousCloseAgents();
    } catch (e) {
      console.error("[scheduler] continuous-close scan failed:", e);
    }
  } catch (e) {
    // Never let a tick rejection escape setInterval — an unhandled rejection
    // would take down the whole server process on a transient DB error.
    console.error("[scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
