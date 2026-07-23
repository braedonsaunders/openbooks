import { join } from "node:path";
import { pool, withOrgContext } from "../db.ts";
import { withSimClock } from "../clock.ts";
import { assertSimEnabled } from "./db-guard.ts";
import { listProfiles } from "./profiles/index.ts";
import { provisionRun, dayStart, dayEnd, verify, loadRun } from "./runner.ts";
import { resetOrg } from "./world.ts";
import { autopilotDay } from "./autopilot.ts";
import { getProfile } from "./profiles/index.ts";
import * as observe from "./observe.ts";
import * as ops from "./ops.ts";
import type { ScriptJournalLine } from "../journal-writes.ts";

/**
 * The environment CLI — the entire action + observation surface a persona
 * subagent operates through (via Bash), plus the operator's day-loop controls.
 *
 *   npm run sim -- provision --profile <id> --seed <s> --start <d> --end <d>
 *   npm run sim -- day-start <runDir>
 *   npm run sim -- observe <screen> <runDir> [--flags]
 *   npm run sim -- act <action> <runDir> [--flags]
 *   npm run sim -- day-end <runDir>
 *   npm run sim -- verify <runDir>      (re-check after a fix)
 *   npm run sim -- status|coverage <runDir>
 *   npm run sim -- reset <runDir>
 *   npm run sim -- list-profiles
 */

const RUNS_ROOT = join(process.cwd(), "sim-runs");

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "true";
      out[key] = val;
    }
  }
  return out;
}

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

/** Run a function scoped to the run's org and pinned to its simulated day. */
async function inRun<T>(runDir: string, fn: (ctx: { world: ReturnType<typeof loadRun>["world"]; manifest: ReturnType<typeof loadRun>["manifest"] }) => Promise<T>): Promise<T> {
  const { world, manifest } = loadRun(runDir);
  return withSimClock(manifest.simDate, () => withOrgContext(manifest.orgId, () => fn({ world, manifest })));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "list-profiles") {
    print(listProfiles().map((p) => ({ id: p.id, name: p.name, industry: p.industry, expects: p.expectedCapabilities })));
    return 0;
  }

  assertSimEnabled();

  switch (cmd) {
    case "provision": {
      const f = parseFlags(argv.slice(1));
      const res = await provisionRun({
        profileId: f.profile ?? "general-contractor",
        seed: f.seed ?? "1",
        startDate: f.start ?? "2026-01-01",
        endDate: f.end ?? "2026-03-31",
        runsRoot: RUNS_ROOT,
      });
      print({ ...res, next: `npm run sim -- day-start ${res.runDir}` });
      return 0;
    }

    case "day-start": {
      const runDir = argv[1]!;
      const res = await dayStart(runDir);
      print(res);
      return res.halted ? 2 : 0;
    }

    case "day-end": {
      const runDir = argv[1]!;
      const res = await dayEnd(runDir);
      print(res);
      return res.pass ? 0 : 2;
    }

    case "autopilot": {
      // Play one day mechanically (the deterministic persona stand-in).
      const runDir = argv[1]!;
      const out = await inRun(runDir, ({ world, manifest }) =>
        autopilotDay(getProfile(manifest.profileId), world, manifest),
      );
      print(out);
      return 0;
    }

    case "run": {
      // Convenience: loop day-start → autopilot → day-end to the end (or a halt).
      // The LLM-operated path uses day-start / persona subagents / day-end instead.
      const runDir = argv[1]!;
      for (;;) {
        const start = await dayStart(runDir);
        if (start.halted) { print({ halted: start.halted }); return 2; }
        if (start.done) { print({ done: true, simDate: start.simDate }); return 0; }
        await inRun(runDir, ({ world, manifest }) => autopilotDay(getProfile(manifest.profileId), world, manifest));
        const end = await dayEnd(runDir);
        if (end.halted) { print({ simDate: end.simDate, halted: end.halted }); return 2; }
        if (end.ranFull) console.error(`[${end.simDate}] period checks passed`);
      }
    }

    case "verify": {
      const res = await verify(argv[1]!);
      print(res);
      return res.pass ? 0 : 2;
    }

    case "status": {
      const { manifest } = loadRun(argv[1]!);
      print(manifest);
      return 0;
    }

    case "coverage": {
      const { manifest } = loadRun(argv[1]!);
      const { getProfile } = await import("./profiles/index.ts");
      const profile = getProfile(manifest.profileId);
      const missing = profile.expectedCapabilities.filter((c) => !manifest.coverage.includes(c));
      print({ covered: manifest.coverage, missing, counters: manifest.counters, complete: missing.length === 0 });
      return missing.length === 0 ? 0 : 1;
    }

    case "reset": {
      const { manifest } = loadRun(argv[1]!);
      await resetOrg(manifest.orgId);
      print({ reset: manifest.orgId });
      return 0;
    }

    case "observe": {
      const screen = argv[1];
      const runDir = argv[2]!;
      const f = parseFlags(argv.slice(3));
      const out = await inRun(runDir, async ({ world, manifest }) => {
        switch (screen) {
          case "ap-inbox": return observe.apInbox(world);
          case "ap-open": return observe.apOpen(world);
          case "ar-inbox": return observe.arInbox(world);
          case "ar-receipts": return observe.arReceipts(world);
          case "ar-aging": return observe.arAging(world, f.asOf ?? manifest.simDate);
          case "trial-balance": return observe.trialBalance(world, f.asOf ?? manifest.simDate);
          case "period-status": return observe.periodStatus(world);
          default: throw new Error(`unknown observe screen "${screen}"`);
        }
      });
      print(out);
      return 0;
    }

    case "act": {
      const action = argv[1];
      const runDir = argv[2]!;
      const f = parseFlags(argv.slice(3));
      const out = await inRun(runDir, async ({ world, manifest }) => {
        switch (action) {
          case "post-bill":
            return ops.postBill(world, f.doc!);
          case "dispute-bill":
            return ops.disputeBill(world, f.doc!, f.reason ?? "under review").then(() => ({ disputed: f.doc }));
          case "pay-vendor":
            return ops.payVendor(world, f.vendor!, (f.lines ?? "").split(",").filter(Boolean), world.actors.apClerk, manifest.simDate);
          case "issue-invoice":
            return ops.issueInvoice(world, f.doc!);
          case "apply-receipt": {
            const alloc = (f.alloc ?? "").split(",").filter(Boolean).map((s) => {
              const [lineId, amount] = s.split(":");
              return { lineId: lineId!, amount: amount! };
            });
            return ops.applyReceipt(world, f.payment!, alloc, world.actors.arClerk);
          }
          case "post-journal": {
            const lines: ScriptJournalLine[] = (f.lines ?? "").split(",").filter(Boolean).map((s) => {
              const [key, amount] = s.split(":");
              const accountId = world.accounts[key!] ?? key!;
              return { accountId, amount: amount! };
            });
            return ops.postAdjustingJournal(world, world.actors.controller, lines, f.memo ?? "adjustment", manifest.simDate);
          }
          case "close-month": {
            const period = world.periods.find((p) => p.name === f.period || p.id === f.period);
            if (!period) throw new Error(`unknown period "${f.period}"`);
            return ops.closeMonth(world, period.id, world.actors.controller, f.reason ?? "month-end close");
          }
          default:
            throw new Error(`unknown act "${action}"`);
        }
      });
      print(out ?? { ok: true });
      return 0;
    }

    default:
      console.error("usage: provision | day-start | observe | act | day-end | verify | status | coverage | reset | list-profiles");
      return 1;
  }
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    // Drizzle wraps the driver error; surface the underlying Postgres cause.
    let cause = (e as { cause?: unknown }).cause;
    while (cause) {
      const c = cause as { message?: string; detail?: string; code?: string; cause?: unknown };
      console.error(`  caused by: ${c.code ? `[${c.code}] ` : ""}${c.message ?? String(cause)}${c.detail ? ` — ${c.detail}` : ""}`);
      cause = c.cause;
    }
    await pool.end();
    process.exit(1);
  });
