import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createInventoryOperator } from "../testing/inventory-counts.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";
import { receiveInventory, issueInventory } from "./movements.ts";
import { moveConsignment } from "./consignment.ts";
import { ensureLot, ensureSerial } from "./tracking.ts";
import { createStockCount, startStockCount, recordCountedQuantity, submitStockCountForReview, postStockCount } from "./stock-counts.ts";
import { recordSecondCount } from "./second-count.ts";
import { getStockCountDetail } from "./stock-count-queries.ts";
import { guardRefusalMessage } from "../platform/database-refusal.ts";

const run = <T>(work: () => Promise<T>) => withBypassContext(work);
test("full and masked clones preserve retired ownership, historical issues and the exact current missing-count link", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await run(() => createScratchOrg());
  let actor: string | undefined;
  let scenarioFailure:unknown;
  try {
    actor = await run(() => createInventoryOperator(org.orgId,"History operator"));
    const poster = actor;
    await run(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"inventory":true,"consignment":true}'::jsonb) where id=${org.orgId}`));
    await run(() => db.execute(sql`update item_inventory_profiles set tracking='lot_serial'
      where org_id=${org.orgId} and item_id=${org.items.fifo}`));
    const external = randomUUID();
    assert.equal((await run(() => db.execute(sql`insert into stock_locations
      (id,org_id,location_id,code,kind,inventory_ownership,owner_party_id)
      values(${external},${org.orgId},${org.locationId},'HISTORY-CUSTODY','bin','vendor',${org.vendorId}) returning id`))).rows.length,1);
    const lot = await run(() => ensureLot(org.orgId,org.items.fifo,"HISTORY-LOT",null,poster));
    const serials = await run(async () => Promise.all(["OLD-OWNED","ACQUIRED","MISSING"].map(
      code => ensureSerial(org.orgId,org.items.fifo,code,null,poster))));
    const receiveOwned = (serialId: string) => run(() => receiveInventory(org.orgId,poster,{
      itemId:org.items.fifo,subsidiaryId:org.subsidiaryId,stockLocationId:org.stockLocationId,
      quantity:"1",unitCost:"3",offsetAccountId:org.accounts.clearing,date:org.date,lotId:lot,serialId,
    }));
    const receiveCustody = (serialId: string) => run(() => moveConsignment(org.orgId,poster,{
      action:"receive",itemId:org.items.fifo,subsidiaryId:org.subsidiaryId,stockLocationId:external,
      quantity:"1",date:org.date,reason:"Vendor retained ownership",lotId:lot,serialId,
    }));
    await receiveOwned(serials[0]!);
    await run(() => issueInventory(org.orgId,poster,{itemId:org.items.fifo,subsidiaryId:org.subsidiaryId,
      stockLocationId:org.stockLocationId,quantity:"1",date:org.date,lotId:lot,serialId:serials[0]}));
    await receiveCustody(serials[0]!);
    const retired = await receiveCustody(serials[1]!);
    await run(() => moveConsignment(org.orgId,poster,{action:"take_ownership",stockId:retired.stockId,
      quantity:"1",toStockLocationId:org.stockLocationId,date:org.date,unitCost:"3",
      offsetAccountId:org.accounts.clearing,reason:"Ownership accepted by receiver"}));
    await receiveOwned(serials[2]!);

    async function countSerial(tenant: string, user: string, subject: { item: string; location: string; business: string; entity: string; lot: string; serial: string }, quantity: string) {
      const count = await run(() => createStockCount(tenant,user,{locationId:subject.business,subsidiaryId:subject.entity,
        countedOn:org.date,lines:[{itemId:subject.item,stockLocationId:subject.location,lotId:subject.lot,serialId:subject.serial}]}));
      await run(() => startStockCount(tenant,user,count.id));
      const line = (await run(() => getStockCountDetail(tenant,count.id,null))).lines[0]!;
      await run(() => recordCountedQuantity(tenant,user,{countId:count.id,lineId:line.id,countedQuantity:quantity}));
      await run(() => recordSecondCount(tenant,user,{countId:count.id,lineId:line.id,countedQuantity:quantity}));
      await run(() => submitStockCountForReview(tenant,user,count.id));
      await run(() => withOrgTransaction(tenant,() => postStockCount(tenant,user,count.id,{foundUnitCosts:{[line.id]:"3"}})));
    }
    await countSerial(org.orgId,poster,{item:org.items.fifo,location:org.stockLocationId,business:org.locationId,
      entity:org.subsidiaryId,lot,serial:serials[2]!},"0");

    const shape = (tenant: string) => run(async () => {
      const rows = (await db.execute(sql`select serial.serial_number,serial.status,
        coalesce((select sum(layer.remaining_quantity) from cost_layers layer join inventory_movements source
          on source.org_id=layer.org_id and source.id=layer.source_movement_id
          where layer.org_id=serial.org_id and source.serial_id=serial.id),0)::text as valued,
        coalesce((select sum(stock.remaining_quantity) from consignment_stock stock
          where stock.org_id=serial.org_id and stock.serial_id=serial.id),0)::text as custody,
        (select count(*) from inventory_movements movement where movement.org_id=serial.org_id and movement.serial_id=serial.id) as history,
        (serial.current_missing_count_movement_id is not null) as missing
        from serials serial where serial.org_id=${tenant} order by serial.serial_number`)).rows;
      return rows;
    });
    const expected = await shape(org.orgId);
    assert.equal(expected.length,3);
    await assert.rejects(receiveCustody(serials[1]!),/already exists in stock/);
    // Storage protects actual current overlap even if a caller bypasses receipt validation.
    await assert.rejects(run(() => db.execute(sql`insert into consignment_stock
      (org_id,subsidiary_id,item_id,stock_location_id,owner_party_id,owner_kind,lot_id,serial_id,
       received_on,original_quantity,remaining_quantity,reason,created_by,updated_by)
      values(${org.orgId},${org.subsidiaryId},${org.items.fifo},${external},${org.vendorId},'vendor',${lot},${serials[1]},
        ${org.date},1,1,'Current overlap refusal',${poster},${poster})`)),error => /already valued stock/.test(
        guardRefusalMessage(error,{includeRaisedCheckViolations:true}) ?? String(error)));
    await assert.rejects(run(() => db.execute(sql`update consignment_stock set remaining_quantity=1
      where org_id=${org.orgId} and id=${retired.stockId}`)),error => /immutable/.test(
        guardRefusalMessage(error,{includeRaisedCheckViolations:true}) ?? String(error)));
    for (const masked of [false,true]) {
      const name = `Inventory history ${randomUUID()}`;
      let failure: unknown;
      try {
        const clone = await run(() => createSandbox({productionOrgId:org.orgId,name,tier:masked?"masked":"full",masked,createdBy:poster}));
        const control = (await run(() => db.execute<{ status: string; sandbox_seed: string }>(sql`
          select control.status,target.sandbox_seed from sandboxes control join orgs target on target.id=control.org_id
          where control.id=${clone.sandboxId} and control.org_id=${clone.sandboxOrgId}`))).rows[0]!;
        assert.equal(control.status,"ready");
        assert.deepEqual(await shape(clone.sandboxOrgId),expected);
        const copied = (await run(() => db.execute<{ item: string; location: string; business: string; entity: string; lot: string; serial: string; pointer: string; expected_pointer: string }>(sql`
          select serial.item_id as item,line.stock_location_id as location,count.location_id as business,
            count.subsidiary_id as entity,serial.lot_id as lot,serial.id as serial,serial.current_missing_count_movement_id as pointer,
            ob_rebase(original.current_missing_count_movement_id,${control.sandbox_seed}::uuid) as expected_pointer
          from serials serial join stock_count_lines line on line.org_id=serial.org_id and line.serial_id=serial.id
            and line.adjustment_movement_id=serial.current_missing_count_movement_id
          join stock_counts count on count.org_id=line.org_id and count.id=line.stock_count_id
          join serials original on original.org_id=${org.orgId} and original.id=${serials[2]}
          where serial.org_id=${clone.sandboxOrgId}`))).rows[0]!;
        assert.ok(copied);
        assert.equal(copied.pointer,copied.expected_pointer);
        const provenance=(await run(()=>db.execute<{
          expected_actor:string;movement_actor:string;entry_poster:string;line_poster:string;count_poster:string;
          first_observer:string;second_observer:string;actor_org:string|null;historical_proof:boolean;
        }>(sql`select ob_rebase(${poster}::uuid,${control.sandbox_seed}::uuid) as expected_actor,
          movement.created_by as movement_actor,entry.posted_by as entry_poster,line.updated_by as line_poster,
          count.updated_by as count_poster,line.first_counted_by as first_observer,line.second_counted_by as second_observer,
          actor.org_id as actor_org,public.inventory_serial_count_line_matches(line.org_id,line.id,movement.id,true) as historical_proof
          from stock_count_lines line join stock_counts count on count.org_id=line.org_id and count.id=line.stock_count_id
          join inventory_movements movement on movement.org_id=line.org_id and movement.id=line.adjustment_movement_id
          join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
          left join users actor on actor.id=movement.created_by and actor.org_id=movement.org_id
          where line.org_id=${clone.sandboxOrgId} and movement.id=${copied.pointer}`))).rows[0];
        assert.ok(provenance,"copied missing-count evidence must resolve its complete posted graph");
        assert.equal(provenance.actor_org,clone.sandboxOrgId,"historical poster must resolve in the copied tenant");
        for(const actual of [provenance.movement_actor,provenance.entry_poster,provenance.line_poster,
          provenance.count_poster,provenance.first_observer,provenance.second_observer])
          assert.equal(actual,provenance.expected_actor,"copied poster and observer identities must use the same native counterpart");
        assert.equal(provenance.historical_proof,true,"historical missing count must satisfy the unchanged posted-evidence proof before recovery");
        assert.equal((await run(() => db.execute(sql`select id from audit_log where org_id=${clone.sandboxOrgId}
          and table_name='stock_counts' and changes->>'operation'='post'`))).rows.length,0,"cloning must not invent a historical post audit");
        const clonedPoster = await run(() => createInventoryOperator(clone.sandboxOrgId,"Sandbox counter"));
        await countSerial(clone.sandboxOrgId,clonedPoster,copied,"1");
        assert.equal((await run(() => db.execute(sql`select current_missing_count_movement_id from serials
          where org_id=${clone.sandboxOrgId} and id=${copied.serial}`))).rows[0]!.current_missing_count_movement_id,null);
        assert.deepEqual(await shape(org.orgId),expected,"sandbox recovery must preserve the source tenant history");
      } catch(error) { failure=error; throw error; }
      finally {
        try {
          await run(async () => {
            const shells=(await db.execute<{id:string}>(sql`select id from sandboxes where production_org_id=${org.orgId} and name=${name}`)).rows;
            for(const shell of shells) await deleteSandbox(shell.id,{actorId:poster});
          });
        } catch(cleanupError) {
          if(failure)throw new AggregateError([failure,cleanupError],"Inventory history clone and native cleanup failed",{cause:failure});
          throw cleanupError;
        }
      }
    }
  } catch(error) { scenarioFailure=error;throw error; }
  finally {
    try { await run(() => dropScratchOrg(org.orgId)); }
    catch(cleanupError) {
      if(scenarioFailure)throw new AggregateError([scenarioFailure,cleanupError],"Stock history scenario and scratch cleanup failed",{cause:scenarioFailure});
      throw cleanupError;
    }
  }
});
