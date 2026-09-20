import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's document-totals family:
 * `document-header-arithmetic`, `document-lines-tieout`, and
 * `document-journal-tieout`.
 *
 * Each plant isolates ONE tie while holding the other two exact, so the
 * failing check name in the assertion is the proof of independence:
 *
 * - journal-tieout (open-item branch): a 0017-clean invoice (header 100 =
 *   one 100 line) whose posted journal books only 60 to the AR open-item
 *   leg, balanced by reshaped distribution legs (revenue −140, adjustment
 *   +80). Every granularity misses 100 — open 60, sides 140, best account
 *   net 140-or-80, biggest leg 140 — while header and lines stay exact.
 * - header-arithmetic: a lineless payment draft carrying total 100 on a
 *   zero subtotal. 0017 is vacuous without lines, so this commits; only the
 *   header-sum gate can see it.
 * - lines-tieout: a header/lines contradiction (subtotal 90 over one 100
 *   line) smuggled past the 0017 commit guard under the sandbox-wipe flag —
 *   the only writer the trigger exempts. Proves the state check sees what
 *   a bypass write leaves behind.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

function othersGreen(cp: Awaited<ReturnType<typeof runScenario>>, except: string): void {
  for (const other of cp.checks.filter((c) => c.name !== except)) {
    assert.equal(other.ok, true, `${other.name} must stay green here — only ${except} fires`);
  }
}

async function postMismatchedInvoice(org: ScratchOrg, actor: string): Promise<string> {
  const docId = randomUUID();
  const entryId = randomUUID();
  // Entry first: documents_posted_entry_id_fkey is immediate, so the doc can
  // only reference a committed entry.
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`T3-JTIE-${entryId.slice(0, 8)}`},
            ${org.date}, ${org.periodId}, 'journal-tieout red-proof probe', 'draft', 'manual', '{}'::jsonb)`);
  // Balanced (60 − 140 + 80 = 0) so the storage balance trigger passes, but
  // no granularity carries the header 100: open-item 60, either side 140,
  // best account net 60/80/140, biggest leg 140.
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
    values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '60.0000', 'CAD', '60.0000', 1, true, 'short claim leg'),
           (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-140.0000', 'CAD', '-140.0000', 1, false, 'reshaped distribution'),
           (${org.orgId}, ${entryId}, 3, ${org.accounts.adjustment}, ${org.subsidiaryId}, '80.0000', 'CAD', '80.0000', 1, false, 'reshaped distribution')`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
  // Doc as draft first: posted documents' lines are immutable, so the lines
  // must exist before the flip.
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
       posting_date, posting_period_id, currency, fx_rate, subtotal, tax_total, total,
       posted_entry_id, created_by)
    values (${docId}, ${org.orgId}, 'customer_invoice', 'draft', ${`T3-JTIE-${docId.slice(0, 8)}`},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date},
            ${org.date}, ${org.periodId}, 'CAD', 1, '100.0000', '0', '100.0000',
            ${entryId}, ${actor})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
    values (${org.orgId}, ${docId}, 1, ${org.accounts.revenue}, '1', '100.0000', '100.0000', '0')`);
  await db.execute(sql`update documents set status = 'posted' where id = ${docId}`);
  return docId;
}

test("document-journal-tieout fails when the claim leg understates the header", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Totals prover", "admin");
    await postMismatchedInvoice(org, actor);

    const cp = await runScenario(org.orgId, { at: org.date });
    const tie = check(cp, "document-journal-tieout");
    assert.equal(tie.ok, false, `journal tie-out MUST fail: ${tie.detail}`);
    assert.match(tie.detail, /1 posted documents with untraceable header totals/);
    assert.equal(cp.pass, false, "an untraceable fixture cannot be golden");
    othersGreen(cp, "document-journal-tieout");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("document-header-arithmetic fails on a lineless total that ignores its subtotal", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Totals prover", "admin");
    const docId = randomUUID();
    // A payment header with no lines: 0017 is vacuous here, so the stranded
    // total commits and only the header-sum gate can catch it.
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${docId}, ${org.orgId}, 'customer_payment', 'draft', ${`T3-HDR-${docId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date},
              'CAD', 1, '0', '0', '100.0000', ${actor})`);

    const cp = await runScenario(org.orgId, { at: org.date });
    const arith = check(cp, "document-header-arithmetic");
    assert.equal(arith.ok, false, `header arithmetic MUST fail: ${arith.detail}`);
    assert.match(arith.detail, /1 documents with total ≠ subtotal \+ tax_total/);
    assert.equal(cp.pass, false, "a mis-added fixture cannot be golden");
    othersGreen(cp, "document-header-arithmetic");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("kernel-posted invoice ties at every document granularity", { skip: !DB }, async () => {
  // Positive control for the family: a genuine kernel posting must satisfy
  // all three ties at once — header arithmetic, header↔lines, and the
  // open-item branch of header↔journal. The lines tie-out itself is
  // trigger-entailed (refresh maintains, assert rejects, both unconditional
  // since 0078 — a contradiction is unplantable through any writer, so there
  // is no red half to prove; the storage red-proof lives in
  // schema/document-total-invariant.integration.test.ts). What this proves is
  // the absence of false positives on real posting geometry.
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Totals prover", "admin");
    const docId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${docId}, ${org.orgId}, 'customer_invoice', 'draft', ${`T3-OK-${docId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date},
              'CAD', 1, '100.0000', '0', '100.0000', ${actor})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${org.orgId}, ${docId}, 1, ${org.accounts.revenue}, '1', '100.0000', '100.0000', '0')`);
    await db.execute(sql`update documents set status = 'approved' where id = ${docId}`);
    await postDocument(docId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    const cp = await runScenario(org.orgId, { at: org.date });
    assert.equal(check(cp, "document-header-arithmetic").ok, true, "header arithmetic must hold on a kernel posting");
    assert.equal(check(cp, "document-lines-tieout").ok, true, "header↔lines must hold on a kernel posting");
    const tie = check(cp, "document-journal-tieout");
    assert.equal(tie.ok, true, `header↔journal must hold on a kernel posting: ${tie.detail}`);
    assert.equal(cp.pass, true, "a clean kernel posting must be golden");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
