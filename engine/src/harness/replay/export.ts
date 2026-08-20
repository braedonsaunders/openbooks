import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { fromUnits, toUnits } from "../../money.ts";
import { openBalancesByParty, projectRollups, trialBalanceByKey } from "../corpus-lib/extract.ts";
import { assertSimOrg } from "../../sim/db-guard.ts";
import type { CorpusAccount, CorpusDocLine, CorpusParty, CorpusProject } from "../corpus-lib/types.ts";
import type { SimOrg } from "../../sim/world.ts";
import type { RunManifest } from "../../sim/manifest.ts";
import type { DatasetEvent, GoldenSnapshot, ReplayDataset } from "./types.ts";

/**
 * Export a completed, explicitly tagged simulation org as a replay dataset and
 * same-system golden snapshot. The result is useful for deterministic
 * regression and restore-integrity testing; it is not independent accounting
 * evidence.
 *
 * The dataset is synthetic by construction (the simulator generated it), so
 * publishing it carries no tenant data. Every GL-affecting posting is
 * exported: documents with their commercial lines, payments with their
 * settlement applications, and pure-GL engine entries (labor costing,
 * overhead pairs, recognition) as origin-tagged journals.
 */

const COMMERCIAL_KINDS = ["vendor_bill", "customer_invoice", "customer_credit", "vendor_credit", "expense_report"];
const PAYMENT_KINDS = ["vendor_payment", "customer_payment"];

interface Maps {
  accountKeyById: Map<string, string>;
  partyKeyById: Map<string, string>;
  projectKeyById: Map<string, string>;
}

function buildMaps(world: SimOrg): { maps: Maps; parties: CorpusParty[]; partyIds: Record<string, string>; projectIds: Record<string, string> } {
  const accountKeyById = new Map(Object.entries(world.accounts).map(([key, id]) => [id, key]));
  const parties: CorpusParty[] = [];
  const partyIds: Record<string, string> = {};
  const partyKeyById = new Map<string, string>();
  world.customers.forEach((c, i) => {
    const key = `c${i + 1}`;
    parties.push({ key, name: c.name, roles: ["customer"] });
    partyIds[key] = c.id;
    partyKeyById.set(c.id, key);
  });
  world.vendors.forEach((v, i) => {
    const key = `v${i + 1}`;
    parties.push({ key, name: v.name, roles: ["vendor"] });
    partyIds[key] = v.id;
    partyKeyById.set(v.id, key);
  });
  world.employees.forEach((e, i) => {
    const key = `e${i + 1}`;
    parties.push({ key, name: e.name, roles: ["employee"] });
    partyIds[key] = e.id;
    partyKeyById.set(e.id, key);
  });
  const projectKeyById = new Map<string, string>();
  const projectIds: Record<string, string> = {};
  for (const job of world.jobs) {
    projectKeyById.set(job.id, job.code);
    projectIds[job.code] = job.id;
  }
  for (const eng of world.engagements) {
    projectKeyById.set(eng.id, eng.code);
    projectIds[eng.code] = eng.id;
  }
  return { maps: { accountKeyById, partyKeyById, projectKeyById }, parties, partyIds, projectIds };
}

function requireKey<T>(map: Map<string, T>, id: string, what: string): T {
  const key = map.get(id);
  if (key === undefined) throw new Error(`export: ${what} ${id} has no semantic key (outside the sim world)`);
  return key;
}

async function exportAccounts(world: SimOrg): Promise<CorpusAccount[]> {
  const ids = Object.values(world.accounts);
  const rows = (await db.execute<{ id: string; number: string; name: string; type: string }>(sql`
    select id, number, name, type from accounts where id in ${ids} order by number`));
  const keyById = new Map(Object.entries(world.accounts).map(([key, id]) => [id, key]));
  return rows.rows.map((r) => ({ key: keyById.get(r.id)!, number: r.number, name: r.name, type: r.type }));
}

async function exportProjects(world: SimOrg, maps: Maps): Promise<CorpusProject[]> {
  const out: CorpusProject[] = [];
  const custKey = (id: string) => requireKey(maps.partyKeyById, id, "customer");
  for (const job of world.jobs) {
    const sov = (await db.execute<{ description: string; scheduled_value: string }>(sql`
      select description, scheduled_value::text as scheduled_value from sov_lines
       where project_id = ${job.id} and org_id = ${world.orgId} order by sort_order`));
    out.push({
      key: job.code,
      name: job.name,
      method: job.method,
      customer: custKey(job.customerId),
      contractValue: job.contractValue,
      sovLines: sov.rows.length ? sov.rows.map((l) => ({ description: l.description, scheduledValue: l.scheduled_value })) : undefined,
    });
  }
  for (const eng of world.engagements) {
    out.push({ key: eng.code, name: eng.name, method: "time_and_materials", customer: custKey(eng.customerId) });
  }
  return out;
}

/** Signed GL lines of one journal entry in semantic keys. */
async function entryGlLines(entryId: string, maps: Maps): Promise<CorpusDocLine[]> {
  const rows = (await db.execute<{ account_id: string; project_id: string | null; amount: string; memo: string | null }>(sql`
    select account_id, project_id, amount::text as amount, memo from journal_lines
     where entry_id = ${entryId} order by line_number`));
  return rows.rows.map((l) => ({
    account: requireKey(maps.accountKeyById, l.account_id, "account"),
    amount: fromUnits(toUnits(l.amount)),
    project: l.project_id ? requireKey(maps.projectKeyById, l.project_id, "project") : null,
    description: l.memo ?? undefined,
  }));
}

export async function exportDataset(
  world: SimOrg,
  manifest: RunManifest,
  name: string,
): Promise<{ dataset: ReplayDataset; golden: GoldenSnapshot }> {
  await assertSimOrg(world.orgId);
  const { maps, parties, partyIds, projectIds } = buildMaps(world);
  const accounts = await exportAccounts(world);
  const projects = await exportProjects(world, maps);

  // Every posted/reversed entry, with its source document when it has one,
  // in stable replay order.
  const entries = (await db.execute<{
      entry_id: string; origin: string | null; posting_date: string;
      doc_id: string | null; kind: string | null; document_number: string | null;
      party_id: string | null; document_date: string | null; due_date: string | null; memo: string | null;
    }>(sql`
    select e.id as entry_id, e.origin, e.posting_date::text as posting_date,
           d.id as doc_id, d.kind, d.document_number, d.party_id,
           d.document_date::text as document_date, d.due_date::text as due_date, d.memo
      from journal_entries e
      left join documents d on d.posted_entry_id = e.id
     where e.org_id = ${world.orgId} and e.status in ('posted', 'reversed')
     order by e.posting_date, e.created_at, e.entry_number`));

  const events: DatasetEvent[] = [];
  const eventIdByDocId = new Map<string, string>();
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = base;
    let n = 1;
    while (usedIds.has(id)) id = `${base}#${++n}`;
    usedIds.add(id);
    return id;
  };

  let documents = 0;
  let glOnly = 0;
  const deferredPayments: typeof entries.rows = [];

  for (const row of entries.rows) {
    if (row.kind && PAYMENT_KINDS.includes(row.kind)) {
      deferredPayments.push(row); // resolved after all targets have event ids
      continue;
    }
    const glLines = await entryGlLines(row.entry_id, maps);

    if (row.doc_id && row.kind && COMMERCIAL_KINDS.includes(row.kind)) {
      const docLines = (await db.execute<{ account_id: string; project_id: string | null; amount: string; description: string | null }>(sql`
        select account_id, project_id, amount::text as amount, description from document_lines
         where document_id = ${row.doc_id} and org_id = ${world.orgId} order by line_number`));
      const id = uniqueId(row.document_number ?? row.doc_id);
      eventIdByDocId.set(row.doc_id, id);
      documents++;
      events.push({
        event: {
          id,
          kind: row.kind as "vendor_bill",
          date: row.document_date ?? row.posting_date,
          dueDate: row.due_date,
          party: requireKey(maps.partyKeyById, row.party_id!, "party"),
          memo: row.memo ?? undefined,
          lines: docLines.rows.map((l) => ({
            account: requireKey(maps.accountKeyById, l.account_id, "account"),
            amount: fromUnits(toUnits(l.amount)),
            project: l.project_id ? requireKey(maps.projectKeyById, l.project_id, "project") : null,
            description: l.description ?? undefined,
          })),
        },
        glLines,
      });
      continue;
    }

    // Journal documents and pure-GL engine entries both replay as journals.
    const id = uniqueId(row.document_number ?? `GL-${String(events.length + 1).padStart(6, "0")}`);
    if (row.doc_id) {
      eventIdByDocId.set(row.doc_id, id);
      documents++;
    } else {
      glOnly++;
    }
    events.push({
      event: {
        id,
        kind: "journal",
        date: row.document_date ?? row.posting_date,
        memo: row.memo ?? (row.origin ? `engine:${row.origin}` : undefined),
        lines: glLines,
      },
      glLines,
      origin: row.doc_id ? null : (row.origin ?? "journal_entry"),
    });
  }

  // Payments last within their date (they settle previously posted items).
  for (const row of deferredPayments) {
    const glLines = await entryGlLines(row.entry_id, maps);
    const allocs = (await db.execute<{ amount: string; target_doc: string }>(sql`
      select a.amount::text as amount, td.id as target_doc
        from applications a
        join journal_lines fl on fl.id = a.from_line_id
        join journal_lines tl on tl.id = a.to_line_id
        join documents td on td.posted_entry_id = tl.entry_id
       where fl.entry_id = ${row.entry_id} and a.unapplied_at is null
       order by a.created_at`));
    const id = uniqueId(row.document_number ?? row.doc_id!);
    eventIdByDocId.set(row.doc_id!, id);
    documents++;
    events.push({
      event: {
        id,
        kind: row.kind as "vendor_payment",
        date: row.document_date ?? row.posting_date,
        party: requireKey(maps.partyKeyById, row.party_id!, "party"),
        memo: row.memo ?? undefined,
        allocations: allocs.rows.map((a) => {
          const target = eventIdByDocId.get(a.target_doc);
          if (!target) throw new Error(`payment ${id} settles document ${a.target_doc} that was not exported`);
          return { event: target, amount: fromUnits(toUnits(a.amount)) };
        }),
      },
      glLines,
    });
  }

  // Re-sort so payments sit in date order after that date's documents.
  events.sort((a, b) => (a.event.date < b.event.date ? -1 : a.event.date > b.event.date ? 1 : 0));

  const dataset: ReplayDataset = {
    schemaVersion: 1,
    name,
    seed: manifest.seed,
    currency: world.currency,
    country: "CA",
    startDate: manifest.startDate,
    endDate: manifest.endDate,
    accounts,
    parties,
    projects: projects.length ? projects : undefined,
    generator: {
      profileId: manifest.profileId,
      seed: manifest.seed,
      startDate: manifest.startDate,
      endDate: manifest.endDate,
    },
    events,
  };

  const golden: GoldenSnapshot = {
    schemaVersion: 1,
    dataset: name,
    trialBalance: await trialBalanceByKey(world.orgId, world.accounts),
    openBalances: await openBalancesByParty(world.orgId, partyIds),
    projects: await projectRollups(world.orgId, projectIds),
    counts: { events: events.length, documents, glOnlyEntries: glOnly },
  };
  return { dataset, golden };
}
