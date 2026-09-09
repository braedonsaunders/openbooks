import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, pool, withOrgTransaction } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';
import { postDocument } from '@openbooks/engine/src/posting.ts';
import { createTransferOrder, receiveInventory, receiveTransferOrder, shipTransferOrder } from '@openbooks/engine/src/inventory.ts';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  return next(specifier, context);
} });
const { saveSetupBook } = await import('./setup/books.ts');
const { SETUP_ENTITY_BY_KEY } = await import('./setup/registry.ts');
const { createPaymentDocument, updateDraftPayment, postPaymentWithApplications, sameCurrencyAllocation } = await import('@openbooks/engine/src/payments.ts');
const routeAuth = { user: { orgId: '', id: '' }, allowedSubsidiaryIds: null };
Object.assign(globalThis, { __primaryBookRouteAuth: routeAuth });
const authHooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../../../../lib/authz' || specifier === '@/lib/authz') return { shortCircuit: true,
    url: 'data:text/javascript,export async function getAuthz(){return globalThis.__primaryBookRouteAuth};export function can(){return true};export function guardSubsidiaryScope(){return null}' };
  return next(specifier, context);
} });
const { POST: postPaymentRoute } = await import('../app/api/payments/post-with-applications/route.ts');
authHooks.deregister();
const entity = SETUP_ENTITY_BY_KEY.get('accounting-books')!;
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const historyError = /controlled book conversion/;
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.message} ${error.cause ? errorText(error.cause) : ''}`;
}
async function fixture(run: (org: ScratchOrg, actor: string, nextBook: string) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const nextBook = randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary) values(${nextBook},${org.orgId},'NEXT','Next',false)`);
    await run(org, actor, nextBook);
  } finally { await dropScratchOrgReporting(org.orgId); }
}
async function promote(org: ScratchOrg, actor: string, id: string) {
  return withOrgTransaction(org.orgId, async () => {
    // Same feature fence held by the interactive/import route before its helper.
    await db.execute(sql`select id from orgs where id=${org.orgId} for share`);
    return saveSetupBook(entity, org.orgId, actor, { name: 'Promoted', isPrimary: true, isActive: true }, db, { id });
  });
}
async function bill(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total)
    values(${id},${org.orgId},'vendor_bill',${`BOOK-${id}`},${org.vendorId},${org.subsidiaryId},${org.date},${org.date},'CAD',1,'draft',100,0,100)`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
    values(${org.orgId},${id},1,${org.accounts.cogs},1,100,100,0)`);
  await db.execute(sql`update documents set status='approved' where id=${id}`);
  return id;
}
function post(org: ScratchOrg, id: string) {
  return postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }, { deferEffects: true });
}
async function entryBook(org: ScratchOrg, id: string) {
  return (await db.execute<{ book_id: string }>(sql`select book_id from journal_entries where org_id=${org.orgId} and id=${id}`)).rows[0]!.book_id;
}
async function waitBlocked(pid: number) {
  for (let n = 0; n < 500; n++) {
    if ((await pool.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))', [pid])).rows[0]!.n) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`no writer blocked by ${pid}`);
}

test('primary book reassignment refuses posted history but preserves harmless metadata', enabled, async () => fixture(async (org, actor, next) => {
  await post(org, await bill(org));
  await assert.rejects(promote(org, actor, next), error => historyError.test(errorText(error)));
  await withOrgTransaction(org.orgId, () => saveSetupBook(entity, org.orgId, actor,
    { name: 'Renamed primary', isPrimary: true, isActive: true }, db, { id: org.bookId }));
  assert.equal((await db.execute(sql`select name from accounting_books where id=${org.bookId}`)).rows[0]!.name, 'Renamed primary');
  assert.equal((await db.execute(sql`select id from accounting_books where org_id=${org.orgId} and is_primary`)).rows[0]!.id, org.bookId);
}));

for (const mutation of ['demote', 'promote', 'delete', 'rehome'] as const) {
  test(`SQL primary ${mutation} refuses journal history`, enabled, async () => fixture(async (org, _actor, next) => {
    await post(org, await bill(org));
    const change = mutation === 'demote' ? sql`update accounting_books set is_primary=false where id=${org.bookId}`
      : mutation === 'promote' ? sql`update accounting_books set is_primary=true where id=${next}`
      : mutation === 'delete' ? sql`delete from accounting_books where id=${org.bookId}`
      : sql`update accounting_books set org_id=${randomUUID()} where id=${org.bookId}`;
    await assert.rejects(db.execute(change), error => historyError.test(errorText(error)));
  }));
}

test('empty organization can select a different primary before its first post', enabled, async () => fixture(async (org, actor, next) => {
  await promote(org, actor, next);
  assert.equal(await entryBook(org, await post(org, await bill(org))), next);
}));

for (const flag of ['is_active', 'posts_gl'] as const) {
  test(`generic posting refuses primary ${flag}=false without recording history`, enabled, async () => fixture(async (org) => {
    const id = await bill(org);
    await db.execute(sql`update accounting_books set ${sql.raw(flag)}=false where id=${org.bookId}`);
    await assert.rejects(post(org, id), /active primary posting book/);
    assert.equal((await db.execute(sql`select id from journal_entries where org_id=${org.orgId}`)).rows.length, 0);
    assert.equal((await db.execute(sql`select status from documents where id=${id}`)).rows[0]!.status, 'approved');
  }));
}

test('setup first: a waiting first post resolves the newly committed primary', enabled, async () => fixture(async (org, actor, next) => {
  const id = await bill(org);
  let release!: () => void;
  let entered!: (pid: number) => void;
  const enteredPromise = new Promise<number>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const editing = withOrgTransaction(org.orgId, async () => {
    await promote(org, actor, next);
    entered((await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
    await gate;
  });
  let posting: ReturnType<typeof post> | undefined;
  try {
    const pid = await enteredPromise;
    posting = post(org, id);
    await waitBlocked(pid);
    release();
    await editing;
    assert.equal(await entryBook(org, await posting), next);
  } finally { release(); await editing; await posting?.catch(() => {}); }
}));

test('post first: primary reassignment waits and refuses the newly committed history', enabled, async () => fixture(async (org, actor, next) => {
  const id = await bill(org);
  const suffix = randomUUID().replaceAll('-', '');
  const name = `book_history_barrier_${suffix}`;
  const blocker = await pool.connect();
  const key = Math.floor(Math.random() * 1_000_000_000);
  let posting: ReturnType<typeof post> | undefined;
  let editing: Promise<PromiseSettledResult<string | null>> | undefined;
  try {
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock($1)', [key]);
    const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin if NEW.org_id='${org.orgId}'::uuid then perform pg_advisory_xact_lock(${key}); end if; return NEW; end $$`));
    await db.execute(sql.raw(`create trigger ${name} before insert on journal_entries for each row execute function ${name}()`));
    posting = post(org, id);
    await waitBlocked(pid);
    const posterPid = (await pool.query<{ pid: number }>('select pid from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))', [pid])).rows[0]!.pid;
    editing = promote(org, actor, next).then(value => ({ status: 'fulfilled', value }), (reason: unknown) => ({ status: 'rejected', reason }));
    await waitBlocked(posterPid);
    await blocker.query('commit');
    assert.equal(await entryBook(org, await posting), org.bookId);
    const result = await editing;
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(errorText(result.reason), historyError);
  } finally {
    await blocker.query('rollback'); blocker.release();
    await posting?.catch(() => {}); await editing;
    await db.execute(sql.raw(`drop trigger if exists ${name} on journal_entries`));
    await db.execute(sql.raw(`drop function if exists ${name}()`));
  }
}));

test('in-transit inventory cannot switch accounting representations between ship and receive', enabled, async () => fixture(async (org, actor, next) => {
  await receiveInventory(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: '5', unitCost: '10', subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date });
  await db.execute(sql`insert into stock_locations(org_id,location_id,code,kind,is_active) values(${org.orgId},${org.locationId},'TRANSIT','transit',true)`);
  const transfer = await createTransferOrder(org.orgId, actor, { fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2, subsidiaryId: org.subsidiaryId, orderedOn: org.date, inTransitAccountId: org.accounts.clearing, lines: [{ itemId: org.items.fifo, quantity: '2' }] });
  const shipped = await shipTransferOrder(org.orgId, actor, transfer.id, org.date);
  await assert.rejects(promote(org, actor, next), error => historyError.test(errorText(error)));
  const received = await receiveTransferOrder(org.orgId, actor, transfer.id, org.date);
  assert.ok(shipped.entryId); assert.ok(received.entryId);
  assert.equal(await entryBook(org, shipped.entryId), org.bookId);
  assert.equal(await entryBook(org, received.entryId), org.bookId);
  assert.equal((await db.execute<{ amount: string }>(sql`select sum(amount)::text as amount from journal_lines where org_id=${org.orgId} and account_id=${org.accounts.clearing} and entry_id in (${shipped.entryId},${received.entryId})`)).rows[0]!.amount, '0.0000');
}));

test('direct secondary-book first journal fences a concurrent primary reassignment', enabled, async () => fixture(async (org, _actor, next) => {
  const writer = await pool.connect();
  let change: Promise<PromiseSettledResult<unknown>> | undefined;
  try {
    await writer.query('begin');
    await writer.query("select set_config('app.bypass_rls','on',true)");
    const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await writer.query(`insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values($1,$2,$3,'FIRST-SECONDARY',$4,$5,'draft','manual')`, [org.orgId, next, org.subsidiaryId, org.date, org.periodId]);
    change = db.execute(sql`update accounting_books set is_primary=false where id=${org.bookId}`)
      .then(value => ({ status: 'fulfilled', value }), (reason: unknown) => ({ status: 'rejected', reason }));
    await waitBlocked(pid);
    await writer.query('commit');
    const result = await change;
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(errorText(result.reason), historyError);
  } finally { await writer.query('rollback'); writer.release(); await change; }
}));

test('trusted migration retains its explicit book-copy exemption', enabled, async () => fixture(async (org, _actor, next) => {
  await post(org, await bill(org));
  await db.transaction(async tx => {
    await tx.execute(sql`set local openbooks.migration=on`);
    await tx.execute(sql`update accounting_books set is_primary=(id=${next}) where org_id=${org.orgId}`);
  });
  assert.equal((await db.execute(sql`select id from accounting_books where org_id=${org.orgId} and is_primary`)).rows[0]!.id, next);
}));

for (const path of ['service', 'HTTP draft'] as const) test(`${path} payment posting waits before its book lock so setup cannot deadlock the org fence`, enabled, async () => fixture(async (org, actor, next) => {
  const billId = await bill(org);
  const entry = await post(org, billId);
  const lineId = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id=${entry} and is_open_item`)).rows[0]!.id;
  const payment = await withOrgTransaction(org.orgId, () => createPaymentDocument({ orgId: org.orgId, kind: 'vendor_payment', createdBy: actor,
    partyId: org.vendorId, bankAccountId: org.accounts.bank, subsidiaryId: org.subsidiaryId, documentDate: org.date, currency: 'CAD' }));
  if (path === 'service') {
    await updateDraftPayment(payment.id, { allocations: [sameCurrencyAllocation(lineId, '100')] }, actor, org.orgId);
    await db.execute(sql`update documents set status='approved' where id=${payment.id}`);
  }
  routeAuth.user = { orgId: org.orgId, id: actor };

  let entered!: (pid: number) => void;
  let release!: () => void;
  const enteredPromise = new Promise<number>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const editing = withOrgTransaction(org.orgId, async () => {
    await db.execute(sql`select id from orgs where id=${org.orgId} for share`);
    entered((await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
    await gate;
    return saveSetupBook(entity, org.orgId, actor, { name: 'Promoted', isPrimary: true, isActive: true }, db, { id: next });
  }).then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }));
  let posting: ReturnType<typeof postPaymentWithApplications> | undefined;
  try {
    const pid = await enteredPromise;
    posting = path === 'service' ? postPaymentWithApplications(payment.id, undefined, actor, 'ui', { deferEffects: true })
      : postPaymentRoute(new Request('http://audit.local/api/payments/post-with-applications', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: payment.id, allocations: [sameCurrencyAllocation(lineId, '100')] }) }))
        .then(async response => { const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body as { entryId: string }; });
    await waitBlocked(pid);
    release();
    const result = await editing;
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(errorText(result.reason), historyError);
    assert.equal(await entryBook(org, (await posting).entryId), org.bookId);
  } finally { release(); await editing; await posting?.catch(() => {}); }
}));

test('secondary first journal between its authority fence and FK does not deadlock setup promotion', enabled, async () => fixture(async (org, actor, next) => {
  const suffix = randomUUID().replaceAll('-', '');
  const name = `zz_book_secondary_barrier_${suffix}`;
  const key = Math.floor(Math.random() * 1_000_000_000);
  const blocker = await pool.connect();
  const writer = await pool.connect();
  let inserting: Promise<unknown> | undefined;
  let editing: Promise<PromiseSettledResult<string | null>> | undefined;
  try {
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock($1)', [key]);
    const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin if NEW.org_id='${org.orgId}'::uuid then perform pg_advisory_xact_lock(${key}); end if; return NEW; end $$`));
    await db.execute(sql.raw(`create trigger ${name} before insert on journal_entries for each row execute function ${name}()`));
    await writer.query('begin');
    await writer.query("select set_config('app.bypass_rls','on',true)");
    const writerPid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    inserting = writer.query(`insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values($1,$2,$3,'SECONDARY-FK-RACE',$4,$5,'draft','manual')`, [org.orgId, next, org.subsidiaryId, org.date, org.periodId]);
    await waitBlocked(blockerPid);
    editing = promote(org, actor, next).then(value => ({ status: 'fulfilled', value }), (reason: unknown) => ({ status: 'rejected', reason }));
    await waitBlocked(writerPid);
    await blocker.query('commit');
    await inserting;
    await writer.query('commit');
    const result = await editing;
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(errorText(result.reason), historyError);
  } finally {
    await blocker.query('rollback'); blocker.release();
    await inserting?.catch(() => {}); await writer.query('rollback'); writer.release();
    await editing;
    await db.execute(sql.raw(`drop trigger if exists ${name} on journal_entries`));
    await db.execute(sql.raw(`drop function if exists ${name}()`));
  }
}));

test('SQL secondary promotion fails closed while first journal history is uncommitted', enabled, async () => fixture(async (org, _actor, next) => {
  const writer = await pool.connect();
  try {
    await writer.query('begin');
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query(`insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values($1,$2,$3,'SQL-FIRST-RACE',$4,$5,'draft','manual')`, [org.orgId, next, org.subsidiaryId, org.date, org.periodId]);
    await assert.rejects(db.execute(sql`update accounting_books set is_primary=true where id=${next}`), error => /could not obtain lock/.test(errorText(error)));
    await writer.query('commit');
    await assert.rejects(db.execute(sql`update accounting_books set is_primary=true where id=${next}`), error => historyError.test(errorText(error)));
  } finally { await writer.query('rollback'); writer.release(); }
}));

test('stale REPEATABLE READ snapshots cannot bypass primary history immutability', enabled, async () => fixture(async (org, _actor, next) => {
  const writer = await pool.connect();
  try {
    await writer.query('begin isolation level repeatable read');
    await writer.query("select set_config('app.bypass_rls','on',true)");
    assert.equal((await writer.query<{ n: number }>('select count(*)::int as n from journal_entries where org_id=$1', [org.orgId])).rows[0]!.n, 0);
    await post(org, await bill(org));
    // The transaction still sees zero history even after the real post commits.
    assert.equal((await writer.query<{ n: number }>('select count(*)::int as n from journal_entries where org_id=$1', [org.orgId])).rows[0]!.n, 0);
    await writer.query("update accounting_books set name='Harmless metadata' where id=$1", [org.bookId]);
    await assert.rejects(writer.query('update accounting_books set is_primary=true where id=$1', [next]), /READ COMMITTED/);
  } finally { await writer.query('rollback'); writer.release(); }
}));

test('SQL primary reassignment cannot pass an uncommitted first reconciliation', enabled, async () => fixture(async (org, _actor, next) => {
  const writer = await pool.connect();
  try {
    await writer.query('begin');
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query(`insert into reconciliations(org_id,account_id,through_date,statement_balance,currency)
      values($1,$2,$3,0,'CAD')`, [org.orgId, org.accounts.bank, org.date]);
    await assert.rejects(db.execute(sql`update accounting_books set is_primary=true where id=${next}`), error => /could not obtain lock/.test(errorText(error)));
    await writer.query('commit');
    await assert.rejects(db.execute(sql`update accounting_books set is_primary=true where id=${next}`), error => historyError.test(errorText(error)));
  } finally { await writer.query('rollback'); writer.release(); }
}));
