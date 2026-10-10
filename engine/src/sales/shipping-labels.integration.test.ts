import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { createPickList, createShipment, releasePickList } from "./fulfillment.ts";
import { createWarehouseOperator, confirmFixturePick, packFixtureShipment } from "../testing/warehouse-execution.ts";
import { moveHandlingUnit } from "./handling-units.ts";
import { sealJson } from "../platform/secrets.ts";
import {
  buyShipmentLabel,
  getShipmentRates,
  handleTrackerDelivery,
  rotateShippingRelaySecret,
  sealAccountSecrets,
  ShippingRefusal,
  voidShipmentLabel,
} from "./shipping-labels.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const SHIPMENT_ID = "shp_9f3c2a1e4b5d6f7890abcdef12";
const RATE_GROUND = "rate_ground_123";
const RATE_PRIORITY = "rate_priority_456";
const RATE_EXPRESS = "rate_express_789";
const TRACKING = "1Z9999999999999999";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function fakeEasyPost(labelPdf: Buffer): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const json = (value: unknown): void => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (req.method === "POST" && req.url === "/v2/shipments") {
        json({
          id: SHIPMENT_ID,
          rates: [
            { id: RATE_GROUND, carrier: "UPS", service: "Ground", rate: "9.87", currency: "CAD", delivery_days: 4, delivery_date: "2026-10-09T20:00:00Z" },
            { id: RATE_PRIORITY, carrier: "USPS", service: "Priority", rate: "12.34", currency: "CAD", delivery_days: 2, delivery_date: "2026-10-07T20:00:00Z" },
            { id: RATE_EXPRESS, carrier: "FedEx", service: "Overnight", rate: "38.00", currency: "CAD", delivery_days: 1, delivery_date: "2026-10-06T20:00:00Z" },
          ],
        });
        return;
      }
      if (req.method === "POST" && req.url === `/v2/shipments/${SHIPMENT_ID}/buy`) {
        const wanted = (JSON.parse(body) as { rate?: { id?: string } }).rate?.id;
        const catalog: Record<string, { carrier: string; service: string; rate: string }> = {
          [RATE_GROUND]: { carrier: "UPS", service: "Ground", rate: "9.87" },
          [RATE_PRIORITY]: { carrier: "USPS", service: "Priority", rate: "12.34" },
          [RATE_EXPRESS]: { carrier: "FedEx", service: "Overnight", rate: "38.00" },
        };
        const chosen = wanted ? catalog[wanted] : undefined;
        if (!chosen) {
          res.statusCode = 422;
          json({ error: { message: "unknown rate" } });
          return;
        }
        const host = `http://127.0.0.1:${(req.socket.localPort ?? 0).toString()}`;
        json({
          id: SHIPMENT_ID,
          tracking_code: TRACKING,
          selected_rate: { ...chosen, currency: "CAD" },
          postage_label: { id: "pl_test123", label_pdf_url: `${host}/label.pdf` },
        });
        return;
      }
      if (req.method === "GET" && req.url === "/label.pdf") {
        res.setHeader("content-type", "application/pdf");
        res.setHeader("content-length", String(labelPdf.length));
        res.end(labelPdf);
        return;
      }
      if (req.method === "POST" && req.url === `/v2/shipments/${SHIPMENT_ID}/refund`) {
        json({ id: SHIPMENT_ID, status: "refunded" });
        return;
      }
      const refreshTracker = req.method === "POST" && req.url === "/v2/trackers";
      if (refreshTracker) {
        const tracker = (JSON.parse(body) as { tracker?: { tracking_code?: string; carrier?: string } }).tracker;
        if (tracker?.tracking_code !== TRACKING || tracker.carrier !== "UPS") {
          res.statusCode = 422;
          json({ error: { message: "unknown carrier tracking reference" } });
          return;
        }
      }
      if (refreshTracker || (req.method === "GET" && req.url === "/v2/trackers/trk_test123")) {
        json({
          id: "trk_test123",
          carrier: "UPS",
          tracking_code: TRACKING,
          shipment_id: SHIPMENT_ID,
          status: "delivered",
          tracking_details: [
            { status: "in_transit", message: "Departed facility", datetime: "2026-10-04T10:00:00Z" },
            { status: "delivered", message: "Delivered", datetime: "2026-10-05T11:00:00Z" },
          ],
        });
        return;
      }
      res.statusCode = 404;
      json({ error: { message: `unexpected ${req.method} ${req.url}` } });
    });
  });
}

async function enableShipping(orgId: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
           || '{"orders": true, "warehousing": true, "fulfillment": true, "shippingHub": true}'::jsonb)
     where id = ${orgId}`));
}

async function seedAccount(org: ScratchOrg, relaySecret: string | null): Promise<string> {
  const accountId = randomUUID();
  const sealed = sealAccountSecrets(org.orgId, "test-key");
  // Seal the KNOWN test secret (not a fresh mint) so the test can sign with it.
  const webhookSealed = relaySecret ? sealRelayForTest(org.orgId, relaySecret) : null;
  await withBypassContext(() => db.execute(sql`
    insert into shipping_accounts (id, org_id, name, provider, mode, status, is_default, secrets, webhook_secret)
    values (${accountId}, ${org.orgId}, 'Test aggregator', 'easypost', 'test', 'active', true, ${sealed}, ${webhookSealed})`));
  await withBypassContext(() => db.execute(sql`
    insert into shipping_settings (org_id, shipping_expense_account_id, carrier_payable_account_id, default_account_id)
    values (${org.orgId}, ${org.accounts.freight}, ${org.accounts.ap}, ${accountId})
    on conflict (org_id) do update set shipping_expense_account_id = excluded.shipping_expense_account_id,
      carrier_payable_account_id = excluded.carrier_payable_account_id, default_account_id = excluded.default_account_id`));
  return accountId;
}

function sealRelayForTest(orgId: string, plain: string): string {
  return sealJson({ relaySecret: plain }, { orgId, purpose: "shipping.account.secrets" });
}

/** An issued sales order with one stock line shipping from MAIN. */
async function issuedOrder(org: ScratchOrg, userId: string, number: string, itemId: string) {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status,
                             subsidiary_id, subtotal, tax_total, total, created_by)
      values (${orderId}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId}, ${org.date}, 'CAD', 'draft',
              ${org.subsidiaryId}, '0', '0', '0', ${userId})`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description,
                                  quantity, unit, unit_price, amount, tax_amount, stock_location_id)
      values (${lineId}, ${org.orgId}, ${orderId}, 1, ${itemId}, ${org.accounts.revenue}, 'Widget',
              '2', 'ea', '10', '20', '0', ${org.stockLocationId})`);
    await db.execute(sql`
      update documents set status = 'approved', subtotal = '20', total = '20'
       where id = ${orderId} and org_id = ${org.orgId}`);
  });
  return { orderId, lineId };
}

async function draftShipment(org: ScratchOrg, userId: string, number: string, itemId: string): Promise<string> {
  const { orderId, lineId } = await issuedOrder(org, userId, number, itemId);
  const bin = org.stockLocationId;
  const pick = await withOrg(org.orgId, () => db.transaction((tx) => createPickList(tx, org.orgId, userId, {
    salesOrderId: orderId, lines: [{ salesOrderLineId: lineId, binId: bin, quantity: "2" }], allowedSubsidiaryIds: null,
  })));
  await releasePickList(org.orgId, userId, { pickListId: pick.id, allowedSubsidiaryIds: null });
  await confirmFixturePick(org.orgId, userId, pick.id);
  const shipment = await withOrg(org.orgId, () => db.transaction((tx) => createShipment(tx, org.orgId, userId, {
    pickListId: pick.id, allowedSubsidiaryIds: null,
  })));
  await withBypassContext(() => db.execute(sql`
    update fulfillment_documents set ship_to_address = ${JSON.stringify({
      label: "Customer",
      line1: "417 Montgomery St",
      line2: null,
      city: "San Francisco",
      region: "CA",
      postalCode: "94104",
      country: "US",
    })}::jsonb where org_id = ${org.orgId} and document_id = ${shipment.id}`));
  await withBypassContext(() => db.execute(sql`
    update warehouses set address_line1 = '228 Park Ave S', city = 'New York',
      region = 'NY', postal_code = '10003', country = 'US'
     where org_id = ${org.orgId}`));
  shipmentUnits.set(shipment.id,await packFixtureShipment(org.orgId,userId,shipment.id,bin));
  return shipment.id;
}

const shipmentUnits = new Map<string,string>();
const callOpts = (baseUrl: string,shipmentId?:string) => ({ allowedSubsidiaryIds: null, transport: fetch, baseUrl,
  ...(shipmentId?{handlingUnitId:shipmentUnits.get(shipmentId)!}:{}) });

test("rate shopping ranks live rates and buying is idempotent with a balanced cost journal", { skip: !DB }, async () => {
  const server = fakeEasyPost(Buffer.from("%PDF-1.4 test label", "utf8"));
  const baseUrl = await listen(server);
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enableShipping(org.orgId);
    const userId = await withBypassContext(() => createWarehouseOperator(org.orgId, "Shipper"));
    await withBypassContext(() => receiveInventory(org.orgId, userId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    await withBypassContext(() => db.execute(sql`
      update items set weight = '0.5', weight_unit = 'kg' where org_id = ${org.orgId} and id = ${org.items.fifo}`));
    const accountId = await seedAccount(org, null);
    const shipmentId = await draftShipment(org, userId, "SO-SHIP-1", org.items.fifo);

    const quote = await withOrg(org.orgId, () => db.transaction((tx) =>
      getShipmentRates(tx, org.orgId, userId, { shipmentId, accountId, ...callOpts(baseUrl,shipmentId) })));
    assert.equal(quote.cached, false);
    assert.equal(quote.rates.length, 3);
    const [ground, priority, express] = quote.rates as unknown as [
      { providerRateId: string; badges: string[] },
      { providerRateId: string; badges: string[] },
      { providerRateId: string; badges: string[] },
    ];
    assert.deepEqual(
      [ground!.providerRateId, priority!.providerRateId, express!.providerRateId],
      [RATE_GROUND, RATE_PRIORITY, RATE_EXPRESS],
    );
    assert.deepEqual(ground!.badges, ["cheapest"]);
    assert.deepEqual(priority!.badges, ["best_value"]);
    assert.deepEqual(express!.badges, ["fastest"]);
    const repeat = await withOrg(org.orgId, () => db.transaction((tx) =>
      getShipmentRates(tx, org.orgId, userId, { shipmentId, accountId, ...callOpts(baseUrl,shipmentId) })));
    assert.equal(repeat.cached, true);

    const dock = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into stock_locations(id,org_id,location_id,parent_id,code,kind,is_active)
      values(${dock},${org.orgId},${org.locationId},${org.stockLocationId},'LABEL-DOCK','bin',true)`));
    const unitId = shipmentUnits.get(shipmentId)!;
    await moveHandlingUnit(org.orgId,userId,{unitId,toBinId:dock,date:org.date,
      reason:'Move packed carton to dispatch dock',commandKey:randomUUID()});
    let purchases = 0;
    const transport:typeof fetch = async (...args) => { purchases++; return fetch(...args); };
    await assert.rejects(withOrg(org.orgId,()=>db.transaction(tx=>buyShipmentLabel(tx,org.orgId,userId,{
      shipmentId,providerRateId:RATE_GROUND,accountId,...callOpts(baseUrl,shipmentId),transport,
    }))), (error:unknown) => error instanceof ShippingRefusal && error.code==='quote_expired');
    assert.equal(purchases,0,'a changed handling-unit version cannot reach the carrier with an old quote');
    const untouched = await withBypassContext(()=>db.execute(sql`
      select id from shipment_labels where org_id=${org.orgId}`));
    assert.equal(untouched.rows.length,0);
    const refreshed = await withOrg(org.orgId,()=>db.transaction(tx=>getShipmentRates(tx,org.orgId,userId,{
      shipmentId,accountId,...callOpts(baseUrl,shipmentId),
    })));
    assert.equal(refreshed.cached,false);

    const buy = () => withOrg(org.orgId, () => db.transaction((tx) =>
      buyShipmentLabel(tx, org.orgId, userId, { shipmentId, providerRateId: RATE_GROUND, accountId, ...callOpts(baseUrl,shipmentId) })));
    const bought = await withSimClock(org.date, buy);
    assert.equal(bought.duplicate, false);
    assert.equal(bought.trackingNumber, TRACKING);
    assert.equal(bought.amountMinor, 987n);
    assert.ok(bought.costEntryId);

    const again = await withSimClock(org.date, buy);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, bought.id);
    await assert.rejects(moveHandlingUnit(org.orgId,userId,{
      unitId,toBinId:org.stockLocationId,date:org.date,reason:'Return carton to packing bin',commandKey:randomUUID(),
    }), /Void.*label/i);
    const physical = await withBypassContext(()=>db.execute<{current_stock_location_id:string}>(sql`
      select current_stock_location_id from handling_units where org_id=${org.orgId} and id=${unitId}`));
    assert.equal(physical.rows[0]!.current_stock_location_id,dock);

    // One balanced cost journal: DR freight 9.87, CR payables 9.87.
    const entries = await withBypassContext(() => db.execute<{ id: string; status: string }>(sql`
      select id, status from journal_entries
       where org_id = ${org.orgId} and origin = 'shipping_label'`));
    assert.equal(entries.rows.length, 1);
    const lines = await withBypassContext(() => db.execute<{ account_id: string; amount: string }>(sql`
      select account_id, amount::text as amount from journal_lines
       where org_id = ${org.orgId} and entry_id = ${entries.rows[0]!.id} order by amount desc`));
    assert.deepEqual(
      lines.rows.map((line) => [line.account_id, line.amount]),
      [[org.accounts.freight, "9.8700"], [org.accounts.ap, "-9.8700"]],
    );
    // The label PDF landed in the file cabinet.
    const files = await withBypassContext(() => db.execute<{ id: string }>(sql`
      select f.id from files f join file_attachments fa on fa.file_id = f.id
       where fa.org_id = ${org.orgId} and fa.target_table = 'shipment_labels'`));
    assert.equal(files.rows.length, 1);
  } finally {
    await close(server);
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("voiding a label reverses its cost journal", { skip: !DB }, async () => {
  const server = fakeEasyPost(Buffer.from("%PDF-1.4 test label", "utf8"));
  const baseUrl = await listen(server);
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enableShipping(org.orgId);
    const userId = await withBypassContext(() => createWarehouseOperator(org.orgId, "Shipper"));
    await withBypassContext(() => receiveInventory(org.orgId, userId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    await withBypassContext(() => db.execute(sql`
      update items set weight = '0.5', weight_unit = 'kg' where org_id = ${org.orgId} and id = ${org.items.fifo}`));
    const accountId = await seedAccount(org, null);
    const shipmentId = await draftShipment(org, userId, "SO-SHIP-2", org.items.fifo);
    await withOrg(org.orgId, () => db.transaction((tx) =>
      getShipmentRates(tx, org.orgId, userId, { shipmentId, accountId, ...callOpts(baseUrl,shipmentId) })));
    const buy = () => withOrg(org.orgId, () => db.transaction((tx) =>
      buyShipmentLabel(tx, org.orgId, userId, { shipmentId, providerRateId: RATE_GROUND, accountId, ...callOpts(baseUrl,shipmentId) })));
    const bought = await withSimClock(org.date, buy);

    const voided = await withSimClock(org.date, () => withOrg(org.orgId, () => db.transaction((tx) =>
      voidShipmentLabel(tx, org.orgId, userId, { labelId: bought.id, reason: "customer cancelled the order", ...callOpts(baseUrl) }))));
    assert.ok(voided.reversalEntryId);

    const entries = await withBypassContext(() => db.execute<{ entry_number: string; status: string }>(sql`
      select entry_number, status from journal_entries
       where org_id = ${org.orgId} and origin = 'shipping_label' order by created_at`));
    assert.deepEqual(entries.rows.map((row) => row.status), ["reversed", "posted"]);
  } finally {
    await close(server);
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a tracker delivery with a bad signature is refused and changes nothing", { skip: !DB }, async () => {
  const server = fakeEasyPost(Buffer.from("%PDF-1.4 test label", "utf8"));
  const baseUrl = await listen(server);
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enableShipping(org.orgId);
    const userId = await withBypassContext(() => createWarehouseOperator(org.orgId, "Shipper"));
    await withBypassContext(() => receiveInventory(org.orgId, userId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    await withBypassContext(() => db.execute(sql`
      update items set weight = '0.5', weight_unit = 'kg' where org_id = ${org.orgId} and id = ${org.items.fifo}`));
    const relaySecret = "test-relay-secret";
    const accountId = await seedAccount(org, relaySecret);
    const shipmentId = await draftShipment(org, userId, "SO-SHIP-3", org.items.fifo);
    await withOrg(org.orgId, () => db.transaction((tx) =>
      getShipmentRates(tx, org.orgId, userId, { shipmentId, accountId, ...callOpts(baseUrl,shipmentId) })));
    const buy = () => withOrg(org.orgId, () => db.transaction((tx) =>
      buyShipmentLabel(tx, org.orgId, userId, { shipmentId, providerRateId: RATE_GROUND, accountId, ...callOpts(baseUrl,shipmentId) })));
    const bought = await withSimClock(org.date, buy);

    const rawBody = JSON.stringify({
      id: "evt_attacker",
      object: "Event",
      description: "tracker.updated",
      result: { id: "trk_test123", carrier: "UPS", tracking_code: TRACKING, status: "delivered", shipment_id: SHIPMENT_ID },
    });
    const t = String(Math.floor(Date.now() / 1000));
    const badSignature = `t=${t},v1=${createHmac("sha256", "wrong-secret").update(`${t}.${rawBody}`, "utf8").digest("hex")}`;
    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) =>
        handleTrackerDelivery(tx, org.orgId, userId, {
          provider: "easypost",
          headers: { "openbooks-signature": badSignature },
          rawBody,
          ...callOpts(baseUrl),
        }))),
      (error: unknown) => {
        assert.ok(error instanceof ShippingRefusal);
        assert.equal(error.code, "signature_invalid");
        assert.equal(error.status, 401);
        return true;
      },
    );
    const untouched = await withBypassContext(() => db.execute<{ tracking_status: string }>(sql`
      select tracking_status from shipment_labels where org_id = ${org.orgId} and id = ${bought.id}`));
    assert.equal(untouched.rows[0]!.tracking_status, "pre_transit");

    const goodSignature = `t=${t},v1=${createHmac("sha256", relaySecret).update(`${t}.${rawBody}`, "utf8").digest("hex")}`;
    const delivered = await withOrg(org.orgId, () => db.transaction((tx) =>
      handleTrackerDelivery(tx, org.orgId, userId, {
        provider: "easypost",
        headers: { "openbooks-signature": goodSignature },
        rawBody,
        ...callOpts(baseUrl),
      })));
    assert.equal(delivered.status, "ok");
    if (delivered.status === "ok") assert.equal(delivered.trackingStatus, "delivered");

    // Rotation retires the old secret at once; the new one verifies.
    const rotated = await withOrg(org.orgId, () => db.transaction((tx) =>
      rotateShippingRelaySecret(tx, org.orgId, userId, accountId)));
    assert.notEqual(rotated.relaySecret, relaySecret);
    const deliver = (headers: Record<string, string>) => withOrg(org.orgId, () => db.transaction((tx) =>
      handleTrackerDelivery(tx, org.orgId, userId, { provider: "easypost", headers, rawBody, ...callOpts(baseUrl) })));
    await assert.rejects(deliver({ "openbooks-signature": goodSignature }), (error: unknown) =>
      error instanceof ShippingRefusal && error.code === "signature_invalid");
    const rotatedSignature = `t=${t},v1=${createHmac("sha256", rotated.relaySecret).update(`${t}.${rawBody}`, "utf8").digest("hex")}`;
    assert.equal((await deliver({ "openbooks-signature": rotatedSignature })).status, "ok");

    // An account with no relay secret refuses every delivery, signed or not.
    await withBypassContext(() => db.execute(sql`
      update shipping_accounts set webhook_secret = null where org_id = ${org.orgId} and id = ${accountId}`));
    await assert.rejects(deliver({}), (error: unknown) =>
      error instanceof ShippingRefusal && error.code === "signature_required" && error.status === 401
        && /Generate a relay secret/.test(error.remedy ?? ""));
  } finally {
    await close(server);
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("rating refuses by name when an item has no weight", { skip: !DB }, async () => {
  const server = fakeEasyPost(Buffer.from("%PDF-1.4 test label", "utf8"));
  const baseUrl = await listen(server);
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enableShipping(org.orgId);
    const userId = await withBypassContext(() => createWarehouseOperator(org.orgId, "Shipper"));
    const lightItem = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into items (id, org_id, kind, code, name, income_account_id, created_by)
      values (${lightItem}, ${org.orgId}, 'inventory', 'WIDGET-LIGHT', 'Feather widget', ${org.accounts.revenue}, ${userId})`));
    await withBypassContext(() => db.execute(sql`
      insert into item_inventory_profiles
        (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
         variance_account_id, received_not_billed_account_id, base_unit, unit_conversions)
      values (${randomUUID()}, ${org.orgId}, ${lightItem}, 'fifo', 'none', ${org.accounts.invAsset}, ${org.accounts.cogs},
              ${org.accounts.adjustment}, ${org.accounts.adjustment}, ${org.accounts.clearing}, 'ea', '{}'::jsonb)`));
    await withBypassContext(() => receiveInventory(org.orgId, userId, {
      itemId: lightItem, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    const accountId = await seedAccount(org, null);
    // The weightless item ships through a non-stock line on its own order.
    const orderId = randomUUID();
    const lineId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status,
                               subsidiary_id, subtotal, tax_total, total, created_by)
        values (${orderId}, ${org.orgId}, 'sales_order', 'SO-LIGHT-1', ${org.customerId}, ${org.date}, 'CAD', 'draft',
                ${org.subsidiaryId}, '0', '0', '0', ${userId})`);
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description,
                                    quantity, unit, unit_price, amount, tax_amount, stock_location_id)
        values (${lineId}, ${org.orgId}, ${orderId}, 1, ${lightItem}, ${org.accounts.revenue}, 'Feather',
                '1', 'ea', '20', '20', '0', ${org.stockLocationId})`);
      await db.execute(sql`
        update documents set status = 'approved', subtotal = '20', total = '20'
         where id = ${orderId} and org_id = ${org.orgId}`);
    });
    const pick = await withOrg(org.orgId, () => db.transaction((tx) => createPickList(tx, org.orgId, userId, {
      salesOrderId: orderId, lines: [{ salesOrderLineId: lineId, binId: org.stockLocationId, quantity: "1" }],
      allowedSubsidiaryIds: null,
    })));
    await releasePickList(org.orgId, userId, { pickListId: pick.id, allowedSubsidiaryIds: null });
    await confirmFixturePick(org.orgId, userId, pick.id);
    const shipment = await withOrg(org.orgId, () => db.transaction((tx) => createShipment(tx, org.orgId, userId, {
      pickListId: pick.id, allowedSubsidiaryIds: null,
    })));
    await withBypassContext(() => db.execute(sql`
      update fulfillment_documents set ship_to_address = ${JSON.stringify({
        label: "Customer", line1: "417 Montgomery St", line2: null, city: "San Francisco",
        region: "CA", postalCode: "94104", country: "US",
      })}::jsonb where org_id = ${org.orgId} and document_id = ${shipment.id}`));
    await withBypassContext(() => db.execute(sql`
      update warehouses set address_line1 = '228 Park Ave S', city = 'New York',
        region = 'NY', postal_code = '10003', country = 'US' where org_id = ${org.orgId}`));

    shipmentUnits.set(shipment.id,await packFixtureShipment(org.orgId,userId,shipment.id,org.stockLocationId));

    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) =>
        getShipmentRates(tx, org.orgId, userId, { shipmentId: shipment.id, accountId, ...callOpts(baseUrl,shipment.id) }))),
      (error: unknown) => {
        assert.ok(error instanceof ShippingRefusal);
        assert.equal(error.code, "weight_missing");
        assert.match(error.message, /Set a weight on item WIDGET-LIGHT \(Feather widget\) or choose a package preset/);
        assert.match(error.remedy ?? "", /Enter the weight on WIDGET-LIGHT/);
        return true;
      },
    );
  } finally {
    await close(server);
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
