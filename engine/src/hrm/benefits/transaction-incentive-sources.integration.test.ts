import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { setupHarness, setFeatures, withHarness } from "../../testing/hrm-harness.ts";
import { measureTransactionIncentiveSources as measure, type TransactionIncentiveSourceQuery } from "./transaction-incentive-sources.ts";

const SPEC = { users: [
  { key: "reader", name: "Transaction Benefits Reader", handle: "transaction_benefits_reader", permissions: ["hrm.benefits.read", "ar.read"], link: true },
  { key: "hrOnly", name: "Benefits Only Reader", handle: "benefits_only_reader", permissions: ["hrm.benefits.read"], link: true },
] } as const;
type Harness = Awaited<ReturnType<typeof setupHarness<typeof SPEC>>>;
const DB = !!process.env.OPENBOOKS_DB_URL;

async function sources(h: Harness, opts: { nullOverride?: boolean; draft?: boolean } = {}) {
  const document = randomUUID(), first = randomUUID(), second = randomUUID(), segment = randomUUID(), header = randomUUID(), override = randomUUID();
  const key = `service_zone_${segment.slice(0, 8)}`;
  await setFeatures(h.org.orgId, { orders: true });
  await db.execute(sql`insert into segment_definitions (id, org_id, key, name, plural_name, source_kind)
    values (${segment}, ${h.org.orgId}, ${key}, 'Service zone', 'Service zones', 'custom')`);
  for (const [id, name] of [[header, "North"], [override, "South"]]) await db.execute(sql`
    insert into segment_values (id, org_id, segment_id, name) values (${id}, ${h.org.orgId}, ${segment}, ${name})`);
  await db.execute(sql`insert into documents (id, org_id, subsidiary_id, kind, document_number, document_date, currency, extra_dims)
    values (${document}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'sales_order', ${document}, '2026-07-09', 'USD', ${JSON.stringify({ [key]: header })}::jsonb)`);
  for (const [index, id] of [first, second].entries()) await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, quantity, unit_price, amount, extra_dims)
    values (${id}, ${h.org.orgId}, ${document}, ${index + 1}, ${h.org.items.service}, '2.00200001', '10', '20.0200',
      ${JSON.stringify(index === 1 ? { [key]: opts.nullOverride ? null : override } : {})}::jsonb)`);
  if (!opts.draft) await db.execute(sql`update documents set status = 'approved' where org_id = ${h.org.orgId} and id = ${document}`);
  const query: TransactionIncentiveSourceQuery = { orgId: h.org.orgId, actorId: h.reader, legalEntityId: h.org.subsidiaryId,
    currency: "USD", documentKind: "sales_order", itemIds: [h.org.items.service], lineIds: [first, second], groupingSegmentId: segment };
  return { document, first, second, segment, header, override, query };
}

test("transaction incentives preserve exact native quantities and custom dimension overrides with deterministic source evidence", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SPEC), async h => {
    const s = await sources(h), snapshot = await measure(s.query);
    assert.equal(snapshot.lines.length, 2);
    assert.deepEqual(snapshot.lines.map(r => r.quantity), ["2.00200001", "2.00200001"]);
    assert.equal(snapshot.lines.find(r => r.sourceId === s.first)?.groupId, s.header);
    assert.equal(snapshot.lines.find(r => r.sourceId === s.second)?.groupId, s.override);
    assert.deepEqual(snapshot.lines.map(r => r.amount), ["20.0200", "20.0200"]);
    assert.ok(snapshot.lines.every(r => r.documentDate === "2026-07-09" && r.documentId === s.document && r.status === "approved"));
    assert.equal((await measure({ ...s.query, lineIds: [...s.query.lineIds].reverse() })).digest, snapshot.digest);
    await db.execute(sql`update segment_values set is_active = false where org_id = ${h.org.orgId} and id = ${s.override}`);
    assert.equal((await measure(s.query)).digest, snapshot.digest, "retiring an editor choice must not erase its historical grouping");
    const company = await measure({ ...s.query, groupingSegmentId: null });
    assert.ok(company.lines.every(r => r.groupId === h.org.subsidiaryId));
    assert.notEqual(company.digest, snapshot.digest, "the selected grouping is part of evidence");
  });
});

test("transaction incentive source admission refuses unavailable authority, identity, lifecycle, item, currency and dimension decisions", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SPEC), async h => {
    const s = await sources(h);
    for (const [change, reason] of [
      [{ actorId: h.hrOnly }, /ar.read/], [{ lineIds: [s.first, s.first] }, /duplicate/], [{ lineIds: ["not-a-uuid"] }, /native record UUID/],
      [{ lineIds: [randomUUID()] }, /missing or outside/], [{ legalEntityId: randomUUID() }, /not visible/],
      [{ documentKind: "quote" }, /missing or outside/], [{ itemIds: [h.org.items.fifo] }, /selected items/],
      [{ itemIds: [randomUUID()] }, /not available/], [{ currency: "CAD" }, /USD, not CAD/],
      [{ groupingSegmentId: randomUUID() }, /dimension is not available/],
    ] as const) await assert.rejects(() => measure({ ...s.query, ...change }), reason);
    await setFeatures(h.org.orgId, { orders: false });
    await assert.rejects(() => measure(s.query), /orders is off/);
    await setFeatures(h.org.orgId, { orders: true });
    const draft = await sources(h, { draft: true });
    await assert.rejects(() => measure(draft.query), /draft.*approved/);
    const missing = await sources(h, { nullOverride: true });
    await assert.rejects(() => measure(missing.query), /no valid service_zone_.* assignment/, "an explicit null line dimension must not fall back to the header group");
  });
});
