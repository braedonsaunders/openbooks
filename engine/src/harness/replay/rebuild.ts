import { withOrgContext } from "../../db.ts";
import { withSimClock } from "../../clock.ts";
import { createScriptJournal } from "../../journal-writes.ts";
import { provisionCorpusOrg, type CorpusWorld } from "../corpus-lib/provision.ts";
import { replayEvent } from "../corpus-lib/post.ts";
import {
  diffKeyed,
  openBalancesByParty,
  projectRollups,
  trialBalanceByKey,
  type SnapshotDiff,
} from "../corpus-lib/extract.ts";
import { cheapInvariants } from "../../sim/invariants/index.ts";
import type { SimOrg } from "../../sim/world.ts";
import type { DatasetEvent, GoldenSnapshot, ReplayDataset } from "./types.ts";

/**
 * Delete-and-rebuild: provision a FRESH org from the dataset and replay every
 * event through the native pipeline, then diff trial balance, per-party open
 * balances, and per-project cost/billed/margin against the golden snapshot —
 * penny-exact, no tolerance.
 *
 * An event that cannot be re-posted natively is copied into a diagnostic
 * GL-faithful journal from its original projection (`glLines`). That can make
 * aggregate comparisons useful for diagnosis, but it is not a successful
 * native rebuild: every fallback makes the report fail.
 */

export interface RebuildReport {
  dataset: string;
  orgId: string;
  events: number;
  native: { documents: number; payments: number; journals: number };
  fallbacks: { event: string; kind: string; reason: string }[];
  hardFailures: { event: string; kind: string; error: string }[];
  trialBalanceDiffs: SnapshotDiff[];
  openBalanceDiffs: SnapshotDiff[];
  projectDiffs: SnapshotDiff[];
  nativeIntegrity: { pass: boolean; failures: { invariant: string; detail: string }[] };
  pass: boolean;
}

function flattenOpens(m: Record<string, { ar?: string; ap?: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [party, sides] of Object.entries(m)) {
    if (sides.ar !== undefined) out[`${party}.ar`] = sides.ar;
    if (sides.ap !== undefined) out[`${party}.ap`] = sides.ap;
  }
  return out;
}

function flattenProjects(m: Record<string, { cost: string; billed: string; margin: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, r] of Object.entries(m)) {
    out[`${key}.cost`] = r.cost;
    out[`${key}.billed`] = r.billed;
    out[`${key}.margin`] = r.margin;
  }
  return out;
}

async function replayAsGlJournal(world: SimOrg, item: DatasetEvent, projectIds: Record<string, string>): Promise<void> {
  if (!item.glLines?.length) throw new Error("no glLines to fall back to");
  await withSimClock(item.event.date, () =>
    withOrgContext(world.orgId, async () => {
      await createScriptJournal(
        world.orgId,
        world.actors.controller,
        {
          documentDate: item.event.date,
          memo: `GL fallback for ${item.event.id} (${item.event.kind})`,
          referenceNumber: `${item.event.id}-GL`,
          lines: item.glLines!.map((l) => ({
            accountId: world.accounts[l.account]!,
            amount: l.amount,
            description: l.description,
            projectId: l.project ? projectIds[l.project] : undefined,
          })),
        },
        { post: true },
      );
    }),
  );
}

export async function rebuildDataset(
  dataset: ReplayDataset,
  golden: GoldenSnapshot,
  opts: { log?: (msg: string) => void } = {},
): Promise<{ report: RebuildReport; world: CorpusWorld }> {
  const corpusWorld = await provisionCorpusOrg(dataset);
  const { world, partyIds, projectIds } = corpusWorld;
  opts.log?.(`rebuild org ${world.orgId} provisioned — replaying ${dataset.events.length} events…`);

  const report: RebuildReport = {
    dataset: dataset.name,
    orgId: world.orgId,
    events: dataset.events.length,
    native: { documents: 0, payments: 0, journals: 0 },
    fallbacks: [],
    hardFailures: [],
    trialBalanceDiffs: [],
    openBalanceDiffs: [],
    projectDiffs: [],
    nativeIntegrity: { pass: false, failures: [] },
    pass: false,
  };

  const docIdByEvent = new Map<string, string>();
  let n = 0;
  for (const item of dataset.events) {
    n++;
    if (n % 250 === 0) opts.log?.(`… ${n}/${dataset.events.length}`);
    try {
      const kind = await replayEvent(world, item.event, { partyIds, projectIds }, docIdByEvent);
      if (kind === "journal") report.native.journals++;
      else if (kind === "payment") report.native.payments++;
      else report.native.documents++;
    } catch (e) {
      const reason = (e as Error).message;
      try {
        await replayAsGlJournal(world, item, projectIds);
        report.fallbacks.push({ event: item.event.id, kind: item.event.kind, reason });
        opts.log?.(`fallback→GL ${item.event.id} (${item.event.kind}): ${reason}`);
      } catch (e2) {
        report.hardFailures.push({
          event: item.event.id,
          kind: item.event.kind,
          error: `${reason}; GL fallback also failed: ${(e2 as Error).message}`,
        });
        opts.log?.(`HARD FAIL ${item.event.id} (${item.event.kind})`);
      }
    }
  }

  const [tb, opens, projects, integrity] = await withOrgContext(world.orgId, async () => [
    await trialBalanceByKey(world.orgId, world.accounts),
    await openBalancesByParty(world.orgId, partyIds),
    await projectRollups(world.orgId, projectIds),
    await cheapInvariants(world.orgId),
  ] as const);

  report.trialBalanceDiffs = diffKeyed(tb, golden.trialBalance);
  report.openBalanceDiffs = diffKeyed(flattenOpens(opens), flattenOpens(golden.openBalances));
  report.projectDiffs = diffKeyed(flattenProjects(projects), flattenProjects(golden.projects));
  report.nativeIntegrity = integrity;
  report.pass =
    report.fallbacks.length === 0 &&
    report.hardFailures.length === 0 &&
    report.trialBalanceDiffs.length === 0 &&
    report.openBalanceDiffs.length === 0 &&
    report.projectDiffs.length === 0 &&
    integrity.pass;
  return { report, world: corpusWorld };
}
