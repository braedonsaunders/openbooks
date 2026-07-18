import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.ts";
import { runScenario } from "./scenario.ts";

/**
 * Golden-fixture harness runner.
 *   npm run harness -- [orgId]
 * Runs the non-destructive scenario checks for one org (default: first org),
 * prints a report, writes a diffable checkpoint under engine/harness-checkpoints/,
 * and exits non-zero if any hard check fails (so it can gate CI).
 */

const argOrg = process.argv[2];
const orgId = argOrg ?? ((await db.execute(sql`select id from orgs order by created_at limit 1`)) as unknown as { rows: { id: string }[] }).rows[0]?.id;
if (!orgId) { console.error("no org"); process.exit(1); }

let gitSha: string | null = null;
try { gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* not a git checkout */ }

const at = new Date().toISOString();
const cp = await runScenario(orgId, { at, gitSha });

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n=== Golden fixture: ${cp.orgName} (${cp.orgId}) ===`);
console.log(`git=${cp.gitSha ?? "?"}  at=${cp.at}`);
console.log(`counts: ${JSON.stringify(cp.counts)}`);
console.log(`trial balance: debits=${cp.trialBalance.debits} credits=${cp.trialBalance.credits} accounts=${cp.trialBalance.accounts}`);

console.log(`\nchecks:`);
for (const c of cp.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${pad(c.name, 22)} ${c.detail}`);

console.log(`\nsubledger ↔ GL tie-out:`);
for (const t of cp.controlTieOut) {
  console.log(`  ${pad(t.number ?? "", 8)} ${pad(t.kind, 20)} GL=${pad(t.gl, 16)} sub=${pad(t.subledger, 16)} diff=${t.diff}`);
}

console.log(`\nreport latency (inception-scan hot path):`);
for (const t of cp.timings) console.log(`  ${pad(t.report, 18)} ${String(t.ms).padStart(6)} ms  (${t.rows} rows)`);

const dir = join(process.cwd(), "harness-checkpoints");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${cp.orgName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${at.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(cp, null, 2));
console.log(`\ncheckpoint written: ${file}`);
console.log(cp.pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");

await pool.end();
process.exit(cp.pass ? 0 : 1);
