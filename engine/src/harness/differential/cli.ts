import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withOrgContext } from "../../db.ts";
import { assertSimEnabled } from "../../sim/db-guard.ts";
import { resetOrg } from "../../sim/world.ts";
import { cheapInvariants } from "../../sim/invariants/index.ts";
import { provisionCorpusOrg } from "../corpus-lib/provision.ts";
import { replayEvents } from "../corpus-lib/post.ts";
import { diffKeyed, openBalancesByParty, trialBalanceByKey, type SnapshotDiff } from "../corpus-lib/extract.ts";
import { computeExpected } from "./reference-ledger.ts";
import { generateCorpus } from "./corpus.ts";
import type { Corpus, ExpectedBalances } from "../corpus-lib/types.ts";

/**
 * Differential-testing harness CLI.
 *
 *   npm -w engine run harness:differential -- generate [--seed S] [--start D] [--end D]
 *   npm -w engine run harness:differential -- check <corpus.json>
 *   OPENBOOKS_SIM=1 npm -w engine run harness:differential -- replay <corpus.json> [--keep]
 *
 * `generate` writes the publishable corpus + the reference ledger's expected
 * balances to corpus/differential/. `replay` provisions a disposable sim-tagged
 * org, drives every event through the REAL posting pipeline, and diffs the
 * resulting trial balance and per-party open balances against the independent
 * reference ledger — penny-exact, no tolerance. Exit code 0 only on a clean run.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CORPUS_DIR = join(REPO_ROOT, "corpus", "differential");
const REPORT_DIR = join(REPO_ROOT, ".local", "differential");

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

function readCorpus(path: string): Corpus {
  const corpus = JSON.parse(readFileSync(path, "utf8")) as Corpus;
  if (corpus.schemaVersion !== 1) throw new Error(`unsupported corpus schemaVersion ${String(corpus.schemaVersion)}`);
  return corpus;
}

function summarize(corpus: Corpus): Record<string, number> {
  const byKind: Record<string, number> = {};
  for (const e of corpus.events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return byKind;
}

function printDiffs(label: string, diffs: SnapshotDiff[]): void {
  console.log(`\n${label}: ${diffs.length === 0 ? "EXACT MATCH" : `${diffs.length} difference(s)`}`);
  for (const d of diffs) {
    console.log(`  ${d.key.padEnd(24)} openbooks=${d.openbooks.padStart(14)} reference=${d.reference.padStart(14)} delta=${d.delta}`);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "generate") {
    const f = parseFlags(argv.slice(1));
    const seed = f.seed ?? "obk-1";
    const corpus = generateCorpus({
      seed,
      startDate: f.start ?? "2026-01-01",
      endDate: f.end ?? "2026-06-30",
    });
    const expected = computeExpected(corpus); // re-validates every event
    mkdirSync(CORPUS_DIR, { recursive: true });
    const corpusFile = join(CORPUS_DIR, `corpus-${seed}.json`);
    const expectedFile = join(CORPUS_DIR, `expected-${seed}.json`);
    writeFileSync(corpusFile, JSON.stringify(corpus, null, 2) + "\n");
    writeFileSync(expectedFile, JSON.stringify(expected, null, 2) + "\n");
    console.log(JSON.stringify({ corpusFile, expectedFile, events: corpus.events.length, byKind: summarize(corpus) }, null, 2));
    return 0;
  }

  if (cmd === "check") {
    const corpus = readCorpus(argv[1]!);
    const expected = computeExpected(corpus);
    const accounts = Object.keys(expected.trialBalance).length;
    const parties = Object.keys(expected.openBalances).length;
    console.log(JSON.stringify({
      corpus: corpus.name, events: corpus.events.length, byKind: summarize(corpus),
      trialBalanceAccounts: accounts, partiesWithOpenBalances: parties,
    }, null, 2));
    // If a published expected file sits beside the corpus, verify it matches.
    const expectedPath = argv[1]!.replace(/corpus-([^/]+)\.json$/, "expected-$1.json");
    try {
      const published = JSON.parse(readFileSync(expectedPath, "utf8")) as ExpectedBalances;
      const tbDiffs = diffKeyed(published.trialBalance, expected.trialBalance);
      if (tbDiffs.length > 0) {
        printDiffs("published expected vs recomputed", tbDiffs);
        return 1;
      }
      console.log(`published expected file matches recomputation: ${expectedPath}`);
    } catch {
      /* no published expected file — nothing to cross-check */
    }
    return 0;
  }

  if (cmd === "replay") {
    assertSimEnabled();
    const f = parseFlags(argv.slice(2));
    const corpus = readCorpus(argv[1]!);
    const expected = computeExpected(corpus);
    console.error(`[differential] corpus "${corpus.name}": ${corpus.events.length} events — provisioning replay org…`);

    const { world, partyIds, projectIds } = await provisionCorpusOrg(corpus);
    console.error(`[differential] org ${world.orgId} provisioned — replaying…`);

    const started = Date.now();
    const replay = await replayEvents(world, corpus.events, {
      partyIds,
      projectIds,
      log: (msg) => console.error(`[differential] ${msg}`),
    });
    const replayMs = Date.now() - started;

    const [tb, opens, integrity] = await withOrgContext(world.orgId, async () => [
      await trialBalanceByKey(world.orgId, world.accounts),
      await openBalancesByParty(world.orgId, partyIds),
      await cheapInvariants(world.orgId),
    ] as const);

    const tbDiffs = diffKeyed(tb, expected.trialBalance);
    const flatOpens = (m: Record<string, { ar?: string; ap?: string }>) => {
      const out: Record<string, string> = {};
      for (const [party, sides] of Object.entries(m)) {
        if (sides.ar !== undefined) out[`${party}.ar`] = sides.ar;
        if (sides.ap !== undefined) out[`${party}.ap`] = sides.ap;
      }
      return out;
    };
    const openDiffs = diffKeyed(flatOpens(opens), flatOpens(expected.openBalances));

    const pass = replay.failures.length === 0 && tbDiffs.length === 0 && openDiffs.length === 0 && integrity.pass;

    console.log(`\n=== Differential replay: ${corpus.name} ===`);
    console.log(`events: ${corpus.events.length}  posted docs: ${replay.posted}  journals: ${replay.journals}  payments: ${replay.paymentsApplied}  (${replayMs} ms)`);
    if (replay.failures.length > 0) {
      console.log(`replay FAILURES: ${replay.failures.length}`);
      for (const failure of replay.failures) console.log(`  ${failure.event} (${failure.kind}): ${failure.error}`);
    }
    printDiffs("trial balance (OpenBooks vs reference)", tbDiffs);
    printDiffs("open balances by party (OpenBooks vs reference)", openDiffs);
    console.log(`\nnative integrity (double-entry + doc-total tie-out): ${integrity.pass ? "PASS" : "FAIL"}`);
    for (const failure of integrity.failures) console.log(`  ${failure.invariant}: ${failure.detail}`);

    mkdirSync(REPORT_DIR, { recursive: true });
    const reportFile = join(REPORT_DIR, `report-${corpus.seed}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportFile, JSON.stringify({
      corpus: corpus.name, seed: corpus.seed, orgId: world.orgId, at: new Date().toISOString(),
      events: corpus.events.length, byKind: summarize(corpus), replayMs,
      replayFailures: replay.failures, trialBalanceDiffs: tbDiffs, openBalanceDiffs: openDiffs,
      nativeIntegrity: integrity, pass,
    }, null, 2));
    console.log(`report written: ${reportFile}`);

    if (pass && f.keep !== "true") {
      await resetOrg(world.orgId);
      console.error(`[differential] replay org wiped (pass --keep to retain)`);
    } else if (!pass) {
      console.error(`[differential] FAILING org retained for investigation: ${world.orgId}`);
    }
    console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
    return pass ? 0 : 2;
  }

  console.error("usage: generate [--seed --start --end] | check <corpus.json> | replay <corpus.json> [--keep]");
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
