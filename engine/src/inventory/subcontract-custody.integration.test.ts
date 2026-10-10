import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db,withBypassContext } from "../platform/db.ts";
import { createScratchOrg,dropScratchOrg } from "../testing/fixtures.ts";
import { createWorkOperator } from "../testing/manufacturing.ts";
import { assertCostingPolicyChangeAllowed, lockItemInventoryProfile } from "./profile-policy.ts";
import { sum } from "../money/money.ts";
import { receiveInventory,issueInventory } from "./movements.ts";
import { transferInventory,transferInventoryTx } from "./transfers.ts";
import { getOnHandWith } from "./position.ts";
import { ensureLot } from "./tracking.ts";
import { reverseInventoryMovement } from "./reversal.ts";
import { assertSaleableStock } from "./stock-eligibility.ts";
import { validateSubcontractLocationConfiguration } from "./subcontract-custody.ts";

const DB=Boolean(process.env.OPENBOOKS_DB_URL);
const run=<T>(work:()=>Promise<T>)=>withBypassContext(work);

test("vendor custody preserves valued ownership, excludes sale, and refuses dependency and revoked authority without moving stock",{skip:!DB},async()=>{
  const org=await run(()=>createScratchOrg());
  try {
    const actor=await run(()=>createWorkOperator(org.orgId,"Production custodian",["items.post","manufacturing.manage","admin.setup.manage"]));
    const custody=randomUUID();
    const configure=()=>run(()=>db.transaction(tx=>validateSubcontractLocationConfiguration(tx,org.orgId,actor,{kind:"subcontract",custodianPartyId:org.vendorId,inventoryOwnership:"owned"})));
    await assert.rejects(configure(),/Manufacturing Subcontracting/);
    await run(()=>db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true,"manufacturing":true,"manufacturingSubcontract":true}'::jsonb) where id=${org.orgId} returning id`));
    await configure();
    await run(()=>db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,inventory_ownership,custodian_party_id)
      values(${custody},${org.orgId},${org.locationId},'VENDOR-CUSTODY','subcontract','owned',${org.vendorId}) returning id`));
    await assert.rejects(run(()=>db.execute(sql`insert into stock_locations(org_id,location_id,parent_id,code,kind)
      values(${org.orgId},${org.locationId},${custody},'SALEABLE-CHILD','bin')`)),/preserve.*custody/);
    await run(()=>receiveInventory(org.orgId,actor,{itemId:org.items.fifo,stockLocationId:org.stockLocationId,quantity:"4",unitCost:"7.25",subsidiaryId:org.subsidiaryId,date:org.date,offsetAccountId:org.accounts.clearing}));
    const move=(from:string,to:string)=>run(()=>transferInventory(org.orgId,actor,{itemId:org.items.fifo,fromStockLocationId:from,toStockLocationId:to,quantity:"4",subsidiaryId:org.subsidiaryId,date:org.date}));
    const shipped=await move(org.stockLocationId,custody);
    assert.equal(shipped.value,"29.0000");
    const position=()=>run(()=>getOnHandWith(db,org.orgId,org.items.fifo,custody,{subsidiaryId:org.subsidiaryId}));
    assert.equal((await position()).quantity,"4.0000");
    assert.equal((await position()).value,"29.0000");
    assert.equal((await run(()=>getOnHandWith(db,org.orgId,org.items.fifo,custody,{subsidiaryId:org.subsidiaryId,saleableOnly:true}))).quantity,"0.0000");
    await assert.rejects(run(()=>db.transaction(tx=>assertSaleableStock(tx,org.orgId,custody))),/vendor custody/);
    await assert.rejects(run(()=>db.execute(sql`update stock_locations set kind='bin',custodian_party_id=null where org_id=${org.orgId} and id=${custody}`)),/custody identity.*fixed/);
    const movements=()=>run(async()=>Number((await db.execute<{n:string}>(sql`select count(*)::text as n from inventory_movements where org_id=${org.orgId}`)).rows[0]!.n));
    const before=await movements();
    await run(()=>db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,manufacturing}','false'::jsonb,true) where id=${org.orgId} returning id`));
    await assert.rejects(move(custody,org.stockLocationId),/Manufacturing Subcontracting/);
    assert.equal(await movements(),before);
    assert.equal((await position()).value,"29.0000");
    await run(()=>db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,manufacturing}','true'::jsonb,true) where id=${org.orgId} returning id`));
    await run(()=>db.execute(sql`update app_roles set permissions='["items.post"]'::jsonb where org_id=${org.orgId} and id in(select role_id from role_assignments where org_id=${org.orgId} and user_id=${actor}) returning id`));
    await assert.rejects(move(custody,org.stockLocationId),/not found/i);
    assert.equal(await movements(),before);
    await run(()=>db.execute(sql`update app_roles set permissions='["items.post","manufacturing.manage"]'::jsonb where org_id=${org.orgId} and id in(select role_id from role_assignments where org_id=${org.orgId} and user_id=${actor}) returning id`));
    assert.equal((await move(custody,org.stockLocationId)).value,"29.0000");
    assert.equal((await position()).quantity,"0.0000");
    assert.equal((await run(()=>getOnHandWith(db,org.orgId,org.items.fifo,org.stockLocationId,{subsidiaryId:org.subsidiaryId,saleableOnly:true}))).value,"29.0000");
  } finally {await run(()=>dropScratchOrg(org.orgId));}
});


test("untracked moving-average receipts retain quantity, original basis and sources through partial issue and reversal",{skip:!DB},async()=>{
 const org=await run(()=>createScratchOrg());
 try {
  const actor=await run(()=>createWorkOperator(org.orgId,"Inventory operator",["items.post"])),item=org.items.movingAvg;
  const policyState=()=>run(async()=>(await db.execute(sql`select to_jsonb(profile) as profile,
    (select count(*) from inventory_movements where org_id=${org.orgId}) as movements,
    (select count(*) from journal_entries where org_id=${org.orgId}) as entries,
    (select count(*) from audit_log where org_id=${org.orgId}) as audits
    from item_inventory_profiles profile where org_id=${org.orgId} and item_id=${item}`)).rows[0]);
  const before=await policyState();
  await assert.rejects(run(()=>db.transaction(async tx=>{
    const current=await lockItemInventoryProfile(tx,org.orgId,item);
    await assertCostingPolicyChangeAllowed(tx,org.orgId,item,current,{costingMethod:'moving_average',tracking:'lot'},null);
  })),/tracking is incompatible with blended moving-average layers/);
  await assert.rejects(run(()=>db.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${org.orgId} and item_id=${item} returning id`)),
    (error:unknown)=>(error as {cause?:{constraint?:string}}).cause?.constraint==='item_inventory_profiles_tracking_costing');
  assert.deepEqual(await policyState(),before,'unsupported tracked average policy changes no profile, stock, journal or audit');
  const receipt=(quantity:string,unitCost:string)=>run(()=>receiveInventory(org.orgId,actor,{itemId:item,stockLocationId:org.stockLocationId,quantity,unitCost,subsidiaryId:org.subsidiaryId,date:org.date,offsetAccountId:org.accounts.clearing}));
  const first=await receipt('3','1'),second=await receipt('1','7');
  const position=(sourceReceiptMovementId:string)=>run(()=>getOnHandWith(db,org.orgId,item,org.stockLocationId,{subsidiaryId:org.subsidiaryId,sourceReceiptMovementId}));
  assert.equal((await position(first.movementId)).quantity,'3.0000');assert.equal((await position(first.movementId)).value,'7.5000');
  assert.equal((await position(second.movementId)).quantity,'1.0000');assert.equal((await position(second.movementId)).value,'2.5000');
  const issued=await run(()=>issueInventory(org.orgId,actor,{itemId:item,stockLocationId:org.stockLocationId,quantity:'2.5',subsidiaryId:org.subsidiaryId,date:org.date}));
  assert.equal((await position(first.movementId)).quantity,'0.5000');assert.equal((await position(first.movementId)).value,'1.2500');
  const provenance=(await run(()=>db.execute<{source:string;basis:string}>(sql`select layer.source_movement_id as source,consumption.original_cost::text as basis from cost_layer_consumptions consumption join cost_layers layer on layer.org_id=consumption.org_id and layer.id=consumption.cost_layer_id where consumption.org_id=${org.orgId} and consumption.issue_movement_id=${issued.movementId}`))).rows;
  assert(provenance.length>0);assert(provenance.every(row=>row.source===first.movementId));assert.equal(sum(provenance.map(row=>row.basis)),'2.5000');
  await run(()=>reverseInventoryMovement(org.orgId,actor,{movementId:issued.movementId,reversalDate:org.date,reason:'Restore the original untracked withdrawal'}));
  assert.equal((await position(first.movementId)).quantity,'3.0000');assert.equal((await position(first.movementId)).value,'7.5000');
  assert.equal((await position(second.movementId)).value,'2.5000');
 } finally {await run(()=>dropScratchOrg(org.orgId));}
});

test("tracked FIFO receipts retain lot quantity and original receipt basis through partial issue and reversal",{skip:!DB},async()=>{
 const org=await run(()=>createScratchOrg());
 try {
  const actor=await run(()=>createWorkOperator(org.orgId,'Tracked inventory operator',['items.post'])),item=org.items.fifo;
  const changed=await run(()=>db.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${org.orgId} and item_id=${item} returning id`));assert.equal(changed.rows.length,1);
  const firstLot=await run(()=>ensureLot(org.orgId,item,'FIFO-A',null,actor)),secondLot=await run(()=>ensureLot(org.orgId,item,'FIFO-B',null,actor));
  const receipt=(quantity:string,unitCost:string,lotId:string)=>run(()=>receiveInventory(org.orgId,actor,{itemId:item,stockLocationId:org.stockLocationId,quantity,unitCost,lotId,subsidiaryId:org.subsidiaryId,date:org.date,offsetAccountId:org.accounts.clearing}));
  const first=await receipt('3','1',firstLot),second=await receipt('1','7',secondLot);
  const position=(lotId:string,sourceReceiptMovementId:string)=>run(()=>getOnHandWith(db,org.orgId,item,org.stockLocationId,{subsidiaryId:org.subsidiaryId,lotId,sourceReceiptMovementId}));
  assert.equal((await position(firstLot,first.movementId)).value,'3.0000');assert.equal((await position(secondLot,second.movementId)).value,'7.0000');
  const issued=await run(()=>issueInventory(org.orgId,actor,{itemId:item,stockLocationId:org.stockLocationId,quantity:'2.5',lotId:firstLot,subsidiaryId:org.subsidiaryId,date:org.date}));
  assert.equal((await position(firstLot,first.movementId)).quantity,'0.5000');assert.equal((await position(firstLot,first.movementId)).value,'0.5000');
  const provenance=(await run(()=>db.execute<{source:string;basis:string}>(sql`select layer.source_movement_id as source,consumption.original_cost::text as basis from cost_layer_consumptions consumption join cost_layers layer on layer.org_id=consumption.org_id and layer.id=consumption.cost_layer_id where consumption.org_id=${org.orgId} and consumption.issue_movement_id=${issued.movementId}`))).rows;
  assert(provenance.length>0);assert(provenance.every(row=>row.source===first.movementId));assert.equal(sum(provenance.map(row=>row.basis)),'2.5000');
  await run(()=>reverseInventoryMovement(org.orgId,actor,{movementId:issued.movementId,reversalDate:org.date,reason:'Restore the selected lot withdrawal'}));
  assert.equal((await position(firstLot,first.movementId)).quantity,'3.0000');assert.equal((await position(firstLot,first.movementId)).value,'3.0000');
  assert.equal((await position(secondLot,second.movementId)).quantity,'1.0000');assert.equal((await position(secondLot,second.movementId)).value,'7.0000');
 }finally{await run(()=>dropScratchOrg(org.orgId));}
});

test("moving-average vendor custody retains distinct shipment costs and returns the selected original shipment",{skip:!DB},async()=>{
 const org=await run(()=>createScratchOrg());
 try {
  const actor=await run(()=>createWorkOperator(org.orgId,'Vendor custodian',['items.post','manufacturing.manage'])),item=org.items.movingAvg,custody=randomUUID();
  await run(()=>db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true,"manufacturing":true,"manufacturingSubcontract":true}'::jsonb) where id=${org.orgId} returning id`));
  await run(()=>db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,inventory_ownership,custodian_party_id) values(${custody},${org.orgId},${org.locationId},'AVG-VENDOR','subcontract','owned',${org.vendorId}) returning id`));
  const ship=async(unitCost:string)=>{
   await run(()=>receiveInventory(org.orgId,actor,{itemId:item,stockLocationId:org.stockLocationId,quantity:'2',unitCost,subsidiaryId:org.subsidiaryId,date:org.date,offsetAccountId:org.accounts.clearing}));
   return run(()=>transferInventory(org.orgId,actor,{itemId:item,fromStockLocationId:org.stockLocationId,toStockLocationId:custody,quantity:'2',subsidiaryId:org.subsidiaryId,date:org.date}));
  };
  const first=await ship('3'),second=await ship('9');assert.equal(first.value,'6.0000');assert.equal(second.value,'18.0000');
  const source=(id:string)=>run(()=>getOnHandWith(db,org.orgId,item,custody,{subsidiaryId:org.subsidiaryId,sourceReceiptMovementId:id}));
  assert.equal((await source(first.toMovementId)).value,'6.0000');assert.equal((await source(second.toMovementId)).value,'18.0000');
  const returned=await run(()=>db.transaction(tx=>transferInventoryTx(tx,org.orgId,actor,{itemId:item,fromStockLocationId:custody,toStockLocationId:org.stockLocationId,quantity:'2',subsidiaryId:org.subsidiaryId,date:org.date,sourceReceiptMovementId:second.toMovementId,expectedSourceValue:'18'})));
  assert.equal(returned.value,'18.0000');assert.equal((await source(second.toMovementId)).quantity,'0.0000');assert.equal((await source(first.toMovementId)).value,'6.0000');
  await assert.rejects(run(()=>db.transaction(tx=>transferInventoryTx(tx,org.orgId,actor,{itemId:item,fromStockLocationId:custody,toStockLocationId:org.stockLocationId,quantity:'2',subsidiaryId:org.subsidiaryId,date:org.date,sourceReceiptMovementId:second.toMovementId,expectedSourceValue:'18'}))));
  assert.equal((await source(first.toMovementId)).quantity,'2.0000');assert.equal((await source(first.toMovementId)).value,'6.0000');
 } finally {await run(()=>dropScratchOrg(org.orgId));}
});
