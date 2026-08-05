import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../../db.ts";
import { assertDedicatedSimDatabase, assertSimEnabled } from "../../sim/db-guard.ts";
import { provisionRun, autopilotRunToEnd, loadRun } from "../../sim/runner.ts";
import { resetOrg } from "../../sim/world.ts";
import { exportDataset } from "./export.ts";
import { rebuildDataset } from "./rebuild.ts";
import type { GoldenSnapshot, ReplayDataset } from "./types.ts";

/**
 * Public replay-validation harness CLI.
 *
 *   OPENBOOKS_SIM=1 npm -w engine run harness:replay -- build --profile general-contractor --seed public-1 \
 *       --start 2026-01-01 --end 2026-06-30 --name gc-public-1
 *   OPENBOOKS_SIM=1 npm -w engine run harness:replay -- rebuild ../corpus/replay/gc-public-1 [--keep]
 *
 * `build` simulates a complete company (the deterministic autopilot over the
 * full window: daily field labor, job-cost AP, five billing methods, payroll,
 * monthly closes), exports it as corpus/replay/<name>/{dataset,golden}.json,
 * and tears the build org down. `rebuild` provisions a FRESH org, replays the
 * dataset through the native pipeline, and diffs against the simulator-derived
 * golden snapshot. This is regression and rebuild-integrity evidence, not an
 * independent opinion on accounting correctness.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const REPLAY_DIR = join(REPO_ROOT, "corpus", "replay");
const REPORT_DIR = join(REPO_ROOT, ".local", "replay");

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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  assertSimEnabled();
  assertDedicatedSimDatabase("replay validation harness");

  if (cmd === "build") {
    const f = parseFlags(argv.slice(1));
    const profileId = f.profile ?? "general-contractor";
    const seed = f.seed ?? "public-1";
    const startDate = f.start ?? "2026-01-01";
    const endDate = f.end ?? "2026-06-30";
    const name = f.name ?? `${profileId}-${seed}`;

    console.error(`[replay] simulating ${profileId} seed=${seed} ${startDate}..${endDate} …`);
    const run = await provisionRun({ profileId, seed, startDate, endDate, runsRoot: join(REPO_ROOT, "engine", "sim-runs") });
    await autopilotRunToEnd(run.runDir);
    const { world, manifest } = loadRun(run.runDir);
    console.error(`[replay] simulation complete (org ${world.orgId}) — exporting…`);

    const { dataset, golden } = await exportDataset(world, manifest, name);
    const dir = join(REPLAY_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dataset.json"), JSON.stringify(dataset, null, 2) + "\n");
    writeFileSync(join(dir, "golden.json"), JSON.stringify(golden, null, 2) + "\n");
    console.log(JSON.stringify({ dir, events: dataset.events.length, counts: golden.counts, projects: Object.keys(golden.projects).length }, null, 2));

    if (f["keep-org"] !== "true") {
      await resetOrg(world.orgId);
      console.error(`[replay] build org wiped (pass --keep-org to retain)`);
    }
    return 0;
  }

  if (cmd === "rebuild") {
    const dir = argv[1]!;
    const dataset = JSON.parse(readFileSync(join(dir, "dataset.json"), "utf8")) as ReplayDataset;
    const golden = JSON.parse(readFileSync(join(dir, "golden.json"), "utf8")) as GoldenSnapshot;
    const f = parseFlags(argv.slice(2));

    const { report, world } = await rebuildDataset(dataset, golden, {
      log: (msg) => console.error(`[replay] ${msg}`),
    });

    console.log(`\n=== Delete-and-rebuild: ${dataset.name} ===`);
    console.log(`events: ${report.events}  native docs: ${report.native.documents}  payments: ${report.native.payments}  journals: ${report.native.journals}`);
    console.log(`fallbacks→GL: ${report.fallbacks.length}  hard failures: ${report.hardFailures.length}`);
    for (const fb of report.fallbacks.slice(0, 10)) console.log(`  fallback ${fb.event} (${fb.kind}): ${fb.reason}`);
    for (const hf of report.hardFailures.slice(0, 10)) console.log(`  HARD ${hf.event} (${hf.kind}): ${hf.error}`);
    const show = (label: string, diffs: typeof report.trialBalanceDiffs) => {
      console.log(`${label}: ${diffs.length === 0 ? "EXACT MATCH" : `${diffs.length} difference(s)`}`);
      for (const d of diffs.slice(0, 20)) {
        console.log(`  ${d.key.padEnd(28)} rebuilt=${d.openbooks.padStart(14)} golden=${d.reference.padStart(14)} delta=${d.delta}`);
      }
    };
    show("trial balance (rebuilt vs golden)", report.trialBalanceDiffs);
    show("open balances (rebuilt vs golden)", report.openBalanceDiffs);
    show("project cost/billed/margin (rebuilt vs golden)", report.projectDiffs);
    console.log(`native integrity: ${report.nativeIntegrity.pass ? "PASS" : "FAIL"}`);
    for (const failure of report.nativeIntegrity.failures) console.log(`  ${failure.invariant}: ${failure.detail}`);

    mkdirSync(REPORT_DIR, { recursive: true });
    const reportFile = join(REPORT_DIR, `rebuild-${dataset.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`report written: ${reportFile}`);

    if (report.pass && f.keep !== "true") {
      await resetOrg(report.orgId);
      console.error(`[replay] rebuild org wiped (pass --keep to retain)`);
    } else if (!report.pass) {
      console.error(`[replay] FAILING rebuild org retained: ${report.orgId}`);
    }
    console.log(report.pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
    return report.pass ? 0 : 2;
  }

  console.error("usage: build [--profile --seed --start --end --name --keep-org] | rebuild <datasetDir> [--keep]");
  return 1;
}

main()
  .then(async (code) => { await pool.end().catch(() => {}); process.exit(code); })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    let cause = (e as { cause?: unknown }).cause;
    while (cause) {
      const c = cause as { message?: string; detail?: string; code?: string; cause?: unknown };
      console.error(`  caused by: ${c.code ? `[${c.code}] ` : ""}${c.message ?? String(cause)}${c.detail ? ` — ${c.detail}` : ""}`);
      cause = c.cause;
    }
    await pool.end().catch(() => {});
    process.exit(1);
  });
