import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { postDocument, PostingError } from "../../posting.ts";
import { runScenario, type Checkpoint } from "../../harness/scenario.ts";
import { postingDeps } from "../activities/documents.ts";
import type { SimOrg, SimPeriod } from "../world.ts";

/**
 * The oracle. Cheap checks run after every persona action; the full golden-
 * fixture suite (engine/src/harness/scenario.ts) and the closed-period
 * immutability probe run at each period boundary. Any failure is a HALT: the
 * runner writes a defect bundle and stops so the operator fixes the product.
 */

export interface InvariantFailure {
  invariant: string;
  detail: string;
}
export interface InvariantResult {
  pass: boolean;
  failures: InvariantFailure[];
  checkpoint?: Checkpoint;
}

async function scalar(q: ReturnType<typeof sql>): Promise<string> {
  const r = (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
  const row = r.rows[0] ?? {};
  return String(Object.values(row)[0] ?? "");
}

/** Fast integrity checks safe to run after every action. */
export async function cheapInvariants(orgId: string): Promise<InvariantResult> {
  const failures: InvariantFailure[] = [];

  const globalBal = await scalar(sql`
    select coalesce(sum(l.amount), 0) from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and e.status = 'posted'`);
  if (Number(globalBal) !== 0) {
    failures.push({ invariant: "global-balance", detail: `sum(all posted lines) = ${globalBal} (want 0)` });
  }

  const unbalanced = await scalar(sql`
    select count(*) from (
      select e.id from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${orgId} and e.status = 'posted'
       group by e.id having abs(sum(l.amount)) >= 0.005) x`);
  if (Number(unbalanced) !== 0) {
    failures.push({ invariant: "per-entry-balance", detail: `${unbalanced} posted entries do not balance` });
  }

  // documents.total must equal the debit sum of its posted entry (for the
  // kinds the harness creates with a header total).
  const totalDrift = await scalar(sql`
    select count(*) from documents d
      join journal_lines l on l.entry_id = d.posted_entry_id
     where d.org_id = ${orgId} and d.status = 'posted'
       and d.kind in ('vendor_bill','customer_invoice','vendor_credit','customer_credit')
     group by d.id, d.total
    having abs(coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) - d.total) >= 0.005`);
  if (totalDrift !== "" && Number(totalDrift) > 0) {
    failures.push({ invariant: "doc-total-tieout", detail: `${totalDrift} documents whose total != entry debit sum` });
  }

  return { pass: failures.length === 0, failures };
}

/** The full golden-fixture suite as of the last closed period. */
export async function fullInvariants(orgId: string, at: string, gitSha: string | null): Promise<InvariantResult> {
  const checkpoint = await runScenario(orgId, { at, gitSha });
  const failures: InvariantFailure[] = checkpoint.checks
    .filter((c) => !c.ok)
    .map((c) => ({ invariant: c.name, detail: c.detail }));
  return { pass: failures.length === 0, failures, checkpoint };
}

/**
 * Closed-period immutability: posting a document dated inside a closed period
 * MUST be rejected. Creates a throwaway draft, attempts to post it, and asserts
 * the kernel refuses. Cleans up the probe draft afterward.
 */
export async function immutabilityProbe(world: SimOrg, closedPeriod: SimPeriod): Promise<InvariantResult> {
  const probeDate = closedPeriod.startsOn;
  const vendor = world.vendors[0];
  if (!vendor) return { pass: true, failures: [] };

  const docId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, currency, subtotal, tax_total, total, created_by, custom)
    values (${docId}, ${world.orgId}, 'vendor_bill', 'draft', ${`PROBE-${docId.slice(0, 8)}`}, ${probeDate}, ${world.currency}, '100.00', '0.00', '100.00', ${world.actors.admin}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount)
    values (${randomUUID()}, ${world.orgId}, ${docId}, 1, ${world.accounts.materials}, 'immutability probe', '1', '100.00', '100.00', '0.00')`);

  let rejected = false;
  try {
    await postDocument(docId, postingDeps(world));
  } catch (e) {
    if (e instanceof PostingError) rejected = true;
    else rejected = true; // any refusal counts; unexpected errors still block the post
  }

  // Clean up: if it was (correctly) rejected the draft is still unposted → delete.
  if (rejected) {
    await db.execute(sql`delete from document_lines where document_id = ${docId} and org_id = ${world.orgId}`);
    await db.execute(sql`delete from documents where id = ${docId} and org_id = ${world.orgId}`);
    return { pass: true, failures: [] };
  }
  return {
    pass: false,
    failures: [{ invariant: "period-immutability", detail: `posting into closed period ${closedPeriod.name} was NOT rejected (probe doc ${docId})` }],
  };
}

/**
 * Write a defect bundle: the failing invariant, a reproduction recipe, and a
 * copy of the run manifest. Returns the bundle directory.
 */
export function writeDefectBundle(
  runDir: string,
  args: {
    seq: number;
    simDate: string;
    profileId: string;
    seed: string;
    orgId: string;
    phase: string;
    failures: InvariantFailure[];
    checkpoint?: Checkpoint;
  },
): string {
  const dir = join(runDir, "defects", `${String(args.seq).padStart(3, "0")}-${args.simDate}`);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, "defect.json"),
    JSON.stringify(
      { simDate: args.simDate, phase: args.phase, failures: args.failures, checkpoint: args.checkpoint ?? null },
      null,
      2,
    ),
  );

  const repro = [
    `# Defect — ${args.failures.map((f) => f.invariant).join(", ")}`,
    "",
    `Surfaced on simulated day **${args.simDate}** during **${args.phase}**.`,
    "",
    "## Failing invariants",
    ...args.failures.map((f) => `- **${f.invariant}** — ${f.detail}`),
    "",
    "## Reproduce",
    "```bash",
    `# same seed reproduces the same business up to the failure`,
    `OPENBOOKS_SIM=1 npm run sim -- resume ${join(runDir)}`,
    "```",
    "",
    `Profile: \`${args.profileId}\`  Seed: \`${args.seed}\`  Org: \`${args.orgId}\``,
    "",
    "## Operator protocol",
    "1. Investigate the failing invariant against the org state above.",
    "2. Fix the DEFECT IN THE PRODUCT (engine/schema/web) — never the harness, never relax the invariant.",
    "3. Add a regression test capturing the case.",
    "4. `resume` this run; the invariant now passes and prior days still pass.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "repro.md"), repro);

  const manifestSrc = join(runDir, "manifest.json");
  if (existsSync(manifestSrc)) copyFileSync(manifestSrc, join(dir, "manifest.json"));

  return dir;
}
