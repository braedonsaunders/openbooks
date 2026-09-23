import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url';

// C6: Closed summed posted customer_invoice documents.total (tax included)
// and ignored credits, so a $100 sale with $13 tax showed as $113 closed
// and a later $100 credit never reduced it. Closed is now the net revenue
// basis — invoice subtotals minus posted customer credits attributable to
// the same revenue. Real calculation, real database; only module resolution
// is scripted.
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  const app = resolveAppModule(specifier, context, next, root);
  if (app) return app;
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { calculateForecast } = await import('./crm');

const DB = !!process.env.OPENBOOKS_DB_URL;
const PERIOD = { periodStart: '2026-07-01', periodEnd: '2026-07-31' } as const;

// Posted documents must carry their posting references
// (documents_posted_requires_posting_refs), so fixtures post through real
// balanced journal entries: draft document, draft entry plus lines, entry
// marked posted, document flipped to posted with its refs.
async function postDocument(org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; accounts: { revenue: string; ar: string } }, opts: {
  kind: 'customer_invoice' | 'customer_credit'; number: string; date: string;
  partyId: string; subtotal: string; taxTotal: string; total: string;
}) {
  const doc = randomUUID(), entry = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, party_id, subsidiary_id, currency, subtotal, tax_total, total)
      values (${doc}, ${org.orgId}, ${opts.kind}, ${opts.number}, ${opts.date}, ${opts.date}, ${opts.date}, ${opts.partyId}, ${org.subsidiaryId}, 'CAD', ${opts.subtotal}, ${opts.taxTotal}, ${opts.total})`);
    // Invoices credit revenue and debit AR; credits mirror the entry.
    const revenueSigned = opts.kind === 'customer_invoice' ? `-${opts.subtotal}` : opts.subtotal;
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entry}, ${opts.date}, ${org.periodId}, 'draft', 'manual', ${doc})`);
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${org.accounts.revenue}, ${org.subsidiaryId}, ${opts.partyId}, ${revenueSigned}, 'CAD', ${revenueSigned}, 1),
             (${org.orgId}, ${entry}, 2, ${org.accounts.ar}, ${org.subsidiaryId}, ${opts.partyId}, -${revenueSigned}::numeric, 'CAD', -${revenueSigned}::numeric, 1)`);
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
    await db.execute(sql`update documents set status='posted', posted_entry_id=${entry}, posting_period_id=${org.periodId} where id=${doc}`);
  });
  return doc;
}
async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Seller', 'owner'));
  await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`insert into crm_account_profiles (org_id, party_id, owner_user_id) values (${org.orgId}, ${org.customerId}, ${actor})`);
  });
  await postDocument(org, { kind: 'customer_invoice', number: 'INV-C6', date: '2026-07-15', partyId: org.customerId, subtotal: '100.0000', taxTotal: '13.0000', total: '113.0000' });
  return { org, actor };
}
async function postCredit(org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; accounts: { revenue: string; ar: string } }, partyId: string, number: string, subtotal: string) {
  await postDocument(org, { kind: 'customer_credit', number, date: '2026-07-20', partyId, subtotal, taxTotal: '0.0000', total: subtotal });
}
async function closed(orgId: string, ownerUserId?: string) {
  const rows = await calculateForecast({ orgId, ...PERIOD, ownerUserId }) as { currency: string; closed_amount: string }[];
  return rows.find((row) => row.currency === 'CAD')?.closed_amount;
}

test('a taxed invoice closes at its net subtotal, not its total', { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    assert.equal(await closed(org.orgId), '100.0000');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('a full credit against the sale closes it to zero', { skip: !DB }, async () => {
  const { org, actor } = await fixture();
  try {
    await postCredit(org, org.customerId, 'CR-C6', '100.0000');
    assert.equal(await closed(org.orgId), '0.0000');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unrelated credit does not move the owner's closed figure", { skip: !DB }, async () => {
  const { org, actor } = await fixture();
  try {
    const stranger = await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name, is_active, custom)
      values (${org.orgId}, 'customer', 'Stranger Co', true, '{}'::jsonb) returning id`)).then((r) => r.rows[0]!.id);
    await postCredit(org, stranger, 'CR-C6-X', '50.0000');
    assert.equal(await closed(org.orgId, actor), '100.0000');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
