import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../../db.ts";
import { withSimClock } from "../../clock.ts";
import { createScriptJournal } from "../../journal-writes.ts";
import {
  createPaymentDocument,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
  type AllocationInput,
} from "../../payments.ts";
import { sum } from "../../money.ts";
import { createDraftDocument, postDraftDocument, releaseDraftIfUngated } from "../../sim/activities/documents.ts";
import type { SimOrg } from "../../sim/world.ts";
import type { CorpusEvent, CommercialEvent, JournalEvent, PaymentEvent } from "./types.ts";

/**
 * Replay a neutral event stream through the REAL OpenBooks pipeline: document
 * insert → approval boundary → posting kernel → payment-application engine.
 * Nothing writes journal rows directly; a replay only succeeds if the product
 * itself produces the expected ledger.
 *
 * Every event is pinned to its own simulated instant (withSimClock) so audit
 * stamps and period-driven behavior advance with the corpus dates.
 */

export interface ReplayFailure {
  event: string;
  kind: string;
  error: string;
}

export interface ReplayResult {
  posted: number;
  paymentsApplied: number;
  journals: number;
  failures: ReplayFailure[];
  /** Corpus event id → OpenBooks document id. */
  docIdByEvent: Map<string, string>;
}

export interface ReplayOptions {
  partyIds: Record<string, string>;
  projectIds?: Record<string, string>;
  /** Stop at the first failure (default true — a corpus replay should be exact). */
  failFast?: boolean;
  log?: (msg: string) => void;
}

/** Replay ONE event, pinned to its own simulated instant and org context. */
export async function replayEvent(
  world: SimOrg,
  event: CorpusEvent,
  opts: ReplayOptions,
  docIdByEvent: Map<string, string>,
): Promise<"journal" | "payment" | "document"> {
  return withSimClock(event.date, () =>
    withOrgContext(world.orgId, async () => {
      if (event.kind === "journal") {
        await replayJournal(world, event, opts);
        return "journal" as const;
      }
      if ("allocations" in event) {
        await replayPayment(world, event, opts, docIdByEvent);
        return "payment" as const;
      }
      const docId = await replayCommercial(world, event, opts);
      docIdByEvent.set(event.id, docId);
      return "document" as const;
    }),
  );
}

export async function replayEvents(world: SimOrg, events: CorpusEvent[], opts: ReplayOptions): Promise<ReplayResult> {
  const result: ReplayResult = { posted: 0, paymentsApplied: 0, journals: 0, failures: [], docIdByEvent: new Map() };
  const failFast = opts.failFast ?? true;

  for (const event of events) {
    try {
      const kind = await replayEvent(world, event, opts, result.docIdByEvent);
      if (kind === "journal") result.journals++;
      else if (kind === "payment") result.paymentsApplied++;
      else result.posted++;
    } catch (e) {
      const failure = { event: event.id, kind: event.kind, error: (e as Error).message };
      result.failures.push(failure);
      opts.log?.(`FAIL ${event.id} (${event.kind}): ${failure.error}`);
      if (failFast) return result;
    }
  }
  return result;
}

function resolveAccount(world: SimOrg, key: string): string {
  const id = world.accounts[key];
  if (!id) throw new Error(`unknown account key "${key}"`);
  return id;
}

function resolveParty(opts: ReplayOptions, key: string): string {
  const id = opts.partyIds[key];
  if (!id) throw new Error(`unknown party key "${key}"`);
  return id;
}

function resolveProject(opts: ReplayOptions, key: string | null | undefined): string | null {
  if (!key) return null;
  const id = opts.projectIds?.[key];
  if (!id) throw new Error(`unknown project key "${key}"`);
  return id;
}

async function replayJournal(world: SimOrg, event: JournalEvent, opts: ReplayOptions): Promise<void> {
  await createScriptJournal(
    world.orgId,
    world.actors.controller,
    {
      documentDate: event.date,
      memo: event.memo ?? `Corpus journal ${event.id}`,
      referenceNumber: event.id,
      lines: event.lines.map((l) => ({
        accountId: resolveAccount(world, l.account),
        amount: l.amount,
        description: l.description,
        projectId: resolveProject(opts, l.project) ?? undefined,
      })),
    },
    { post: true },
  );
}

async function replayCommercial(world: SimOrg, event: CommercialEvent, opts: ReplayOptions): Promise<string> {
  const { documentId } = await createDraftDocument(world, {
    kind: event.kind,
    documentNumber: event.id,
    partyId: resolveParty(opts, event.party),
    documentDate: event.date,
    dueDate: event.dueDate ?? null,
    memo: event.memo ?? null,
    createdBy: world.actors.apClerk,
    currency: world.currency,
    custom: { corpus: { event: event.id } },
    lines: event.lines.map((l) => ({
      accountId: resolveAccount(world, l.account),
      description: l.description ?? l.account,
      amount: l.amount,
      projectId: resolveProject(opts, l.project),
    })),
  });
  await postDraftDocument(world, documentId);
  return documentId;
}

/** The control-side open-item line a payment allocation targets. */
async function openItemLine(world: SimOrg, documentId: string): Promise<string> {
  const rows = (await db.execute<{ id: string }>(sql`
    select l.id from journal_lines l
      join documents d on d.posted_entry_id = l.entry_id
     where d.id = ${documentId} and d.org_id = ${world.orgId} and l.is_open_item`));
  if (rows.rows.length !== 1) {
    throw new Error(`expected exactly one open-item line for document ${documentId}, found ${rows.rows.length}`);
  }
  return rows.rows[0]!.id;
}

async function replayPayment(
  world: SimOrg,
  event: PaymentEvent,
  opts: ReplayOptions,
  docIdByEvent: Map<string, string>,
): Promise<void> {
  const allocations: AllocationInput[] = [];
  for (const alloc of event.allocations) {
    const docId = docIdByEvent.get(alloc.event);
    if (!docId) throw new Error(`payment ${event.id} allocates to unknown/unposted event "${alloc.event}"`);
    allocations.push(sameCurrencyAllocation(await openItemLine(world, docId), alloc.amount));
  }
  const actor = event.kind === "vendor_payment" ? world.actors.apClerk : world.actors.arClerk;
  const payment = await createPaymentDocument({
    orgId: world.orgId,
    kind: event.kind,
    createdBy: actor,
    partyId: resolveParty(opts, event.party),
    bankAccountId: world.accounts.bank,
    documentDate: event.date,
    currency: world.currency,
    memo: event.memo ?? `Corpus payment ${event.id} (${sum(event.allocations.map((a) => a.amount))})`,
  });
  await updateDraftPayment(payment.id, { allocations, bankAccountId: world.accounts.bank }, actor, world.orgId);
  await releaseDraftIfUngated(world, payment.id, actor);
  await postPaymentWithApplications(payment.id, undefined, actor);
}
