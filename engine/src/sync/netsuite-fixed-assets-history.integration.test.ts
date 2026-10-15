import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { postEntry } from "../journal/post-entry.ts";
import { syncNetSuiteFixedAssets } from "./netsuite-fixed-assets.ts";
import type { NetSuiteSource, NetSuiteFixedAssetSnapshot } from "./netsuite-source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const REF_KEY = "nsFamHistoryTest";

type Row = Record<string, unknown>;

function stubSource(snapshot: NetSuiteFixedAssetSnapshot): NetSuiteSource {
  return {
    name: "netsuite",
    refKey: REF_KEY,
    baseCurrency: "CAD",
    fixedAssets: async () => snapshot,
    fixedAssetTransactionIds: async () => [],
    fixedAssetAccountBalances: async () => new Map(),
    nativeTransactionsByIds: async () => ({
      documents: [],
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-16T00:00:00.000Z"),
      unbuildable: [],
    }),
  } as unknown as NetSuiteSource;
}

async function createConnection(orgId: string): Promise<string> {
  const id = randomUUID();
  const saved = (await db.execute<{ id: string }>(sql`
    insert into connections(id, org_id, source, display_name)
    values(${id}, ${orgId}, 'netsuite', ${`Fixed assets source ${id}`}) returning id`)).rows[0];
  if (!saved) throw new Error("The fixed assets connection fixture was not saved");
  return saved.id;
}

async function prepareOrg(org: ScratchOrg): Promise<{ connectionId: string; actorId: string }> {
  const actorId = await createScratchUser(org.orgId, "Migration operator", "admin");
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings -> 'features', '{}'::jsonb) || '{"fixedAssets": true}'::jsonb)
     where id = ${org.orgId}`);
  for (const [ref, id] of [["FA-COST", org.accounts.invAsset], ["FA-ACCUM", org.accounts.adjustment], ["FA-EXP", org.accounts.cogs]] as const) {
    await db.execute(sql`
      update accounts set custom = custom || jsonb_build_object('nsId', ${ref}::text, ${REF_KEY}::text, ${ref}::text)
       where id = ${id} and org_id = ${org.orgId}`);
  }
  await db.execute(sql`
    update subsidiaries set custom = coalesce(custom, '{}'::jsonb) || '{"nsId":"SUB"}'::jsonb
     where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  return { connectionId: await createConnection(org.orgId), actorId };
}

const assetTypeRow: Row = {
  id: "7",
  name: "Equipment",
  custrecord_assettypeassetacc: "FA-COST",
  custrecord_assettypedepracc: "FA-ACCUM",
  custrecord_assettypedeprchargeacc: "FA-EXP",
};

function assetRow(sourceId: string, cost: string, overrides: Row = {}): Row {
  return {
    id: sourceId,
    name: `Asset ${sourceId}`,
    custrecord_assettype: "7",
    custrecord_assetsubsidiary: "SUB",
    custrecord_assetcost: cost,
    custrecord_assetcurrentcost: cost,
    custrecord_assetmainacc: "FA-COST",
    custrecord_assetdepracc: "FA-ACCUM",
    custrecord_assetdeprchargeacc: "FA-EXP",
    custrecord_assetpurchasedate: "07/01/2026",
    custrecord_assetdeprstartdate: "07/01/2026",
    ...overrides,
  };
}

function historyRow(id: string, assetRef: string, label: string, amount: string, overrides: Row = {}): Row {
  return {
    id,
    custrecord_deprhistasset: assetRef,
    fam_history_type_label: label,
    custrecord_deprhistdate: "07/15/2026",
    custrecord_deprhistamount: amount,
    ...overrides,
  };
}

function snapshot(overrides: Partial<NetSuiteFixedAssetSnapshot> = {}): NetSuiteFixedAssetSnapshot {
  return {
    extractedAt: "2026-07-16T00:00:00.000Z",
    sourceAccount: "stub",
    bridgeVersion: "stub",
    assets: [assetRow("A1", "12000")],
    assetTypes: [assetTypeRow],
    depreciationHistory: [
      historyRow("H1", "A1", "Acquisition", "12000", { custrecord_deprhistdate: "07/01/2026" }),
      historyRow("H2", "A1", "Depreciation", "100"),
    ],
    assetValues: [{ id: "V1", custrecord_slaveparentasset: "A1", custrecord_slavebookvalue: "11900" }],
    depreciationMethods: [],
    alternateMethods: [],
    alternateDepreciation: [],
    alternateDefinitions: [],
    assetLifetimes: [],
    ...overrides,
  };
}

async function famEvents(orgId: string, sourceAssetId: string) {
  return (await db.execute<{
    id: string; asset_id: string; kind: string; amount: string | null;
    memo: string | null; journal_entry_id: string | null; created_at: string;
  }>(sql`
    select e.id, e.asset_id, e.kind, e.amount::text as amount, e.memo,
           e.journal_entry_id, e.created_at::text as created_at
      from asset_events e
      join fixed_assets a on a.id = e.asset_id and a.org_id = e.org_id
     where e.org_id = ${orgId} and a.custom->'netsuiteFam'->>'sourceId' = ${sourceAssetId}
     order by e.id`)).rows;
}

async function assetFacts(orgId: string, sourceAssetId: string) {
  return (await db.execute<{ id: string; acquisition_cost: string; name: string }>(sql`
    select id, acquisition_cost::text as acquisition_cost, name from fixed_assets
     where org_id = ${orgId} and custom->'netsuiteFam'->>'sourceId' = ${sourceAssetId}`)).rows[0] ?? null;
}

test("exact FAM replay reuses the admitted acquisition event and audits admission once", { skip: !DB, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  try {
    const { connectionId, actorId } = await prepareOrg(org);
    const options = { orgId: org.orgId, connectionId, actorId };
    await syncNetSuiteFixedAssets(stubSource(snapshot()), options);
    const first = await famEvents(org.orgId, "A1");
    assert.equal(first.length, 1);
    assert.equal(first[0]!.memo, "[NetSuite FAM history H1]");
    assert.equal(first[0]!.amount, "12000.0000");

    const audits = (await db.execute<{ actor_id: string | null; source_history_id: string | null }>(sql`
      select actor_id, changes->>'sourceHistoryId' as source_history_id from audit_log
       where org_id = ${org.orgId} and table_name = 'asset_events' and row_id = ${first[0]!.id}`)).rows;
    assert.deepEqual(audits, [{ actor_id: actorId, source_history_id: "H1" }]);

    // Replay twice more, the second pair concurrently: the admitted event is
    // never deleted and reinserted, so id, creation time, and audit stand.
    await syncNetSuiteFixedAssets(stubSource(snapshot()), options);
    await Promise.all([
      syncNetSuiteFixedAssets(stubSource(snapshot()), options),
      syncNetSuiteFixedAssets(stubSource(snapshot()), options),
    ]);
    assert.deepEqual(await famEvents(org.orgId, "A1"), first);
    const auditCount = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${org.orgId} and table_name = 'asset_events'`)).rows[0]!;
    assert.equal(auditCount.n, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("changed or vanished FAM acquisition history refuses atomically, asset row included", { skip: !DB, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  try {
    const { connectionId, actorId } = await prepareOrg(org);
    const options = { orgId: org.orgId, connectionId, actorId };
    await syncNetSuiteFixedAssets(stubSource(snapshot()), options);
    const admitted = await famEvents(org.orgId, "A1");
    const assetBefore = await assetFacts(org.orgId, "A1");

    const changed = snapshot({
      assets: [assetRow("A1", "12001", { altname: "Renamed asset" })],
      depreciationHistory: [
        historyRow("H1", "A1", "Acquisition", "12001", { custrecord_deprhistdate: "07/01/2026" }),
        historyRow("H2", "A1", "Depreciation", "100"),
      ],
      assetValues: [{ id: "V1", custrecord_slaveparentasset: "A1", custrecord_slavebookvalue: "11901" }],
    });
    await assert.rejects(
      syncNetSuiteFixedAssets(stubSource(changed), options),
      /append-only and has been preserved/,
    );
    assert.deepEqual(await famEvents(org.orgId, "A1"), admitted);
    assert.deepEqual(await assetFacts(org.orgId, "A1"), assetBefore);

    const vanished = snapshot({
      depreciationHistory: [historyRow("H2", "A1", "Depreciation", "100")],
    });
    await assert.rejects(
      syncNetSuiteFixedAssets(stubSource(vanished), options),
      /absent from the full source snapshot/,
    );
    assert.deepEqual(await famEvents(org.orgId, "A1"), admitted);
    assert.deepEqual(await assetFacts(org.orgId, "A1"), assetBefore);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("missing or duplicate FAM history identity admits nothing", { skip: !DB, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  try {
    const { connectionId, actorId } = await prepareOrg(org);
    const options = { orgId: org.orgId, connectionId, actorId };
    const missing = snapshot({
      depreciationHistory: [
        historyRow("", "A1", "Acquisition", "12000", { custrecord_deprhistdate: "07/01/2026" }),
        historyRow("H2", "A1", "Depreciation", "100"),
      ],
    });
    await assert.rejects(
      syncNetSuiteFixedAssets(stubSource(missing), options),
      /without a stable source history id/,
    );
    const duplicate = snapshot({
      depreciationHistory: [
        historyRow("H1", "A1", "Acquisition", "12000", { custrecord_deprhistdate: "07/01/2026" }),
        historyRow("H1", "A1", "Depreciation", "100"),
      ],
    });
    await assert.rejects(
      syncNetSuiteFixedAssets(stubSource(duplicate), options),
      /repeats source history id H1/,
    );
    assert.equal(await assetFacts(org.orgId, "A1"), null);
    const events = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from asset_events where org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(events.n, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("FAM history reconciliation stays within its own asset and tenant", { skip: !DB, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const { connectionId, actorId } = await prepareOrg(org);
    const options = { orgId: org.orgId, connectionId, actorId };
    const twoAssets = snapshot({
      assets: [assetRow("A1", "12000"), assetRow("A2", "3000")],
      depreciationHistory: [
        historyRow("H1", "A1", "Acquisition", "12000", { custrecord_deprhistdate: "07/01/2026" }),
        historyRow("H2", "A1", "Depreciation", "100"),
        historyRow("H3", "A2", "Acquisition", "3000", { custrecord_deprhistdate: "07/01/2026" }),
      ],
      assetValues: [
        { id: "V1", custrecord_slaveparentasset: "A1", custrecord_slavebookvalue: "11900" },
        { id: "V2", custrecord_slaveparentasset: "A2", custrecord_slavebookvalue: "3000" },
      ],
    });
    await syncNetSuiteFixedAssets(stubSource(twoAssets), options);
    const firstAssetEvents = await famEvents(org.orgId, "A1");
    const secondAssetEvents = await famEvents(org.orgId, "A2");
    assert.equal(firstAssetEvents.length, 1);
    assert.equal(secondAssetEvents.length, 1);

    const secondChanged = snapshot({
      assets: [assetRow("A1", "12000"), assetRow("A2", "3001")],
      depreciationHistory: [
        historyRow("H1", "A1", "Acquisition", "12000", { custrecord_deprhistdate: "07/01/2026" }),
        historyRow("H2", "A1", "Depreciation", "100"),
        historyRow("H3", "A2", "Acquisition", "3001", { custrecord_deprhistdate: "07/01/2026" }),
      ],
      assetValues: [
        { id: "V1", custrecord_slaveparentasset: "A1", custrecord_slavebookvalue: "11900" },
        { id: "V2", custrecord_slaveparentasset: "A2", custrecord_slavebookvalue: "3001" },
      ],
    });
    await assert.rejects(
      syncNetSuiteFixedAssets(stubSource(secondChanged), options),
      /FAM history H3 for asset A2/,
    );
    assert.deepEqual(await famEvents(org.orgId, "A1"), firstAssetEvents);
    assert.deepEqual(await famEvents(org.orgId, "A2"), secondAssetEvents);

    // The same source ids in another tenant admit independently.
    const otherPrepared = await prepareOrg(other);
    await syncNetSuiteFixedAssets(stubSource(snapshot()), {
      orgId: other.orgId,
      connectionId: otherPrepared.connectionId,
      actorId: otherPrepared.actorId,
    });
    const otherEvents = await famEvents(other.orgId, "A1");
    assert.equal(otherEvents.length, 1);
    assert.notEqual(otherEvents[0]!.id, firstAssetEvents[0]!.id);
    assert.deepEqual(await famEvents(org.orgId, "A1"), firstAssetEvents);
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});

test("native and posted asset history is never rewritten by FAM replay", { skip: !DB, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  try {
    const { connectionId, actorId } = await prepareOrg(org);
    const options = { orgId: org.orgId, connectionId, actorId };
    await syncNetSuiteFixedAssets(stubSource(snapshot()), options);
    const asset = await assetFacts(org.orgId, "A1");
    assert.ok(asset);

    const native = (await db.execute<{ id: string }>(sql`
      insert into asset_events(org_id, asset_id, kind, occurred_on, amount, memo, created_by, updated_by)
      values(${org.orgId}, ${asset.id}, 'acquired', '2026-07-02', '12000', 'Native acquisition evidence', ${actorId}, ${actorId})
      returning id`)).rows[0]!;
    await syncNetSuiteFixedAssets(stubSource(snapshot()), options);
    const afterReplay = await famEvents(org.orgId, "A1");
    assert.equal(afterReplay.length, 2);
    assert.ok(afterReplay.some((event) => event.id === native.id && event.memo === "Native acquisition evidence"));

    // A posted, journal-linked event carrying a source marker is a native
    // representation the import must refuse to reinterpret, not overwrite.
    const { entryId } = await postEntry(db, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
      entryNumber: "FA-POSTED-1", postingDate: org.date, periodId: org.periodId,
      origin: "migration", currency: "CAD",
      lines: [{ accountId: org.accounts.bank, amount: "50" }, { accountId: org.accounts.clearing, amount: "-50" }],
    });
    const posted = (await db.execute<{ id: string }>(sql`
      insert into asset_events(org_id, asset_id, kind, occurred_on, amount, memo, journal_entry_id, created_by, updated_by)
      values(${org.orgId}, ${asset.id}, 'acquired', '2026-07-03', '50', '[NetSuite FAM history H9]', ${entryId}, ${actorId}, ${actorId})
      returning id`)).rows[0]!;
    const conflicting = snapshot({
      depreciationHistory: [
        historyRow("H1", "A1", "Acquisition", "12000", { custrecord_deprhistdate: "07/01/2026" }),
        historyRow("H2", "A1", "Depreciation", "100"),
        historyRow("H9", "A1", "Acquisition", "50", { custrecord_deprhistdate: "07/03/2026" }),
      ],
    });
    await assert.rejects(
      syncNetSuiteFixedAssets(stubSource(conflicting), options),
      /conflicts with the admitted native representation/,
    );
    const postedAfter = (await db.execute<{ journal_entry_id: string | null; amount: string }>(sql`
      select journal_entry_id, amount::text as amount from asset_events
       where org_id = ${org.orgId} and id = ${posted.id}`)).rows[0]!;
    assert.deepEqual(postedAfter, { journal_entry_id: entryId, amount: "50.0000" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
