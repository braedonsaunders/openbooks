import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { postDocument } from "./posting-document.ts";
import { projectRetainageHeldSql } from "../projects/construction-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function setPolicy(org: Org, policy: "warn" | "refuse" | null): Promise<void> {
  await db.execute(policy === null
    ? sql`update orgs set settings = settings #- '{ledger,partylessControlPolicy}' where id = ${org.orgId}`
    : sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ledger}',
            coalesce(settings->'ledger', '{}'::jsonb) || jsonb_build_object('partylessControlPolicy', ${policy}::text), true)
          where id = ${org.orgId}`);
}

/** An approved two-line journal: debit `debitAccount`, credit `creditAccount`. */
async function journal(
  org: Org,
  actorId: string,
  number: string,
  lines: { debitAccount: string; creditAccount: string; creditPartyId?: string | null; amount: string },
  kind: "journal" | "deposit" = "journal",
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, subsidiary_id, document_date, currency, fx_rate,
                           status, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${id}, ${org.orgId}, ${kind}, ${number}, ${org.subsidiaryId}, ${org.date}, 'CAD', '1', 'draft',
            ${lines.amount}, '0', ${lines.amount}, ${JSON.stringify(kind === "deposit" ? { controlAccountId: lines.debitAccount } : {})}::jsonb,
            ${actorId}, ${actorId})`);
  if (kind === "journal") {
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount,
                                  tax_input_amount, tax_amount, party_id, created_by, updated_by)
      values (${org.orgId}, ${id}, 1, ${lines.debitAccount}, '1', ${lines.amount}, ${lines.amount}, ${lines.amount}, '0', null, ${actorId}, ${actorId}),
             (${org.orgId}, ${id}, 2, ${lines.creditAccount}, '1', ${`-${lines.amount}`}, ${`-${lines.amount}`}, ${`-${lines.amount}`}, '0',
              ${lines.creditPartyId ?? null}, ${actorId}, ${actorId})`);
  } else {
    // A deposit line names the source account it credits; the bank leg is the header.
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount,
                                  tax_input_amount, tax_amount, party_id, created_by, updated_by)
      values (${org.orgId}, ${id}, 1, ${lines.creditAccount}, '1', ${lines.amount}, ${lines.amount}, ${lines.amount}, '0',
              ${lines.creditPartyId ?? null}, ${actorId}, ${actorId})`);
  }
  await db.execute(sql`update documents set status = 'approved', updated_at = now() where id = ${id}`);
  return id;
}

function post(org: Org, documentId: string): Promise<string> {
  return postDocument(documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
}

async function entries(documentId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where source_document_id = ${documentId}`)).rows[0]!.n;
}

test(
  "a party-less receivable line posts under warn and is refused under refuse with the Receive payment remedy",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        const actorId = await createScratchUser(org.orgId, "Journal clerk", "admin");

        // Absent policy reads as warn: the posting stands (the route reports it).
        await setPolicy(org, null);
        const warned = await journal(org, actorId, "JE-WARN-1", { debitAccount: org.accounts.bank, creditAccount: org.accounts.ar, amount: "50" });
        await post(org, warned);
        assert.equal(await entries(warned), 1);

        await setPolicy(org, "refuse");
        const refusedJournal = await journal(org, actorId, "JE-REFUSE-1", { debitAccount: org.accounts.bank, creditAccount: org.accounts.ar, amount: "50" });
        await assert.rejects(post(org, refusedJournal), (error: unknown) =>
          error instanceof PostingError &&
          /JE-REFUSE-1/.test(error.message) &&
          /receivable account 1100/.test(error.message) &&
          /Receive payment/.test(error.message) &&
          /Control accounts/.test(error.message));
        assert.equal(await entries(refusedJournal), 0);

        const refusedDeposit = await journal(org, actorId, "DEP-REFUSE-1", { debitAccount: org.accounts.bank, creditAccount: org.accounts.ar, amount: "75" }, "deposit");
        await assert.rejects(post(org, refusedDeposit), (error: unknown) =>
          error instanceof PostingError && /DEP-REFUSE-1/.test(error.message) && /Receive payment/.test(error.message));
        assert.equal(await entries(refusedDeposit), 0);

        const payable = await journal(org, actorId, "JE-REFUSE-AP", { debitAccount: org.accounts.ap, creditAccount: org.accounts.bank, amount: "20" });
        await assert.rejects(post(org, payable), (error: unknown) =>
          error instanceof PostingError && /payable account 2000/.test(error.message) && /Pay bills/.test(error.message));

        // Naming the customer makes the line an open item inside the
        // sub-ledger, so the refuse policy does not apply.
        const named = await journal(org, actorId, "JE-NAMED-1", {
          debitAccount: org.accounts.bank, creditAccount: org.accounts.ar, creditPartyId: org.customerId, amount: "50",
        });
        await post(org, named);
        const open = (await db.execute<{ is_open_item: boolean }>(sql`
          select jl.is_open_item from journal_lines jl
            join journal_entries je on je.id = jl.entry_id
           where je.source_document_id = ${named} and jl.account_id = ${org.accounts.ar}`)).rows[0]!;
        assert.equal(open.is_open_item, true);
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an opening retainage journal on the project posts under refuse and counts as held; a customer-named line does not",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        const actorId = await createScratchUser(org.orgId, "Retainage clerk", "admin");
        const retainage = randomUUID();
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                                required_dimensions, custom, subsidiary_include_children)
          values (${retainage}, ${org.orgId}, '1150', 'Retainage Receivable', 'asset_receivable', false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{controlAccounts,retainageReceivable}', to_jsonb(${retainage}::text), true)
           where id = ${org.orgId}`);
        const projectId = randomUUID();
        await db.execute(sql`
          insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
          values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'OPEN-RET', 'Opening retainage', 'active', true, '{}'::jsonb)`);
        await setPolicy(org, "refuse");
        const opening = await journal(org, actorId, "JE-RET-OPEN", { debitAccount: retainage, creditAccount: org.accounts.revenue, amount: "500" });
        await db.execute(sql`update document_lines set project_id = ${projectId} where document_id = ${opening} and line_number = 1`);
        await post(org, opening);
        assert.equal(await entries(opening), 1);
        const held = async () => String((await db.execute<{ held: string }>(
          projectRetainageHeldSql(org.orgId, projectId, retainage))).rows[0]!.held);
        assert.equal(await held(), "500.0000");

        // Naming the customer makes the line a receivable open item, which is
        // collectible AR rather than retainage awaiting release.
        const named = await journal(org, actorId, "JE-RET-NAMED", { debitAccount: retainage, creditAccount: org.accounts.revenue, amount: "70" });
        await db.execute(sql`
          update document_lines set project_id = ${projectId}, party_id = ${org.customerId}
           where document_id = ${named} and line_number = 1`);
        await post(org, named);
        assert.equal(await held(), "500.0000");
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
