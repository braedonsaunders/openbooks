import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '../platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts'
import { receiveInventory } from './movements.ts'
import { buildAssembly, reverseAssemblyBuild } from './assembly.ts'
import { disassembleAssembly, reverseAssemblyDisassembly } from './disassembly.ts'
import { listInventoryOperationOptions } from './operation-options.ts'
import { getOnHand } from './position.ts'
import { writeDownInventoryToNrv } from './nrv.ts'

test('partial physical recovery preserves immutable recipe and cost, replays once and reverses as one unit', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId,'Inventory operator','accountant'))
    await withBypassContext(() => db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values
      (${org.orgId},${actor},'items.post','grant'),(${org.orgId},${actor},'items.reverse','grant')`))
    await withOrgContext(org.orgId,async () => {
      await receiveInventory(org.orgId,actor,{itemId:org.items.component,stockLocationId:org.stockLocationId,quantity:'100',unitCost:'5',subsidiaryId:org.subsidiaryId,offsetAccountId:org.accounts.clearing,date:org.date})
      const built = await buildAssembly(org.orgId,actor,{assemblyItemId:org.items.assembly,quantity:'10',stockLocationId:org.stockLocationId,subsidiaryId:org.subsidiaryId,date:org.date})
      await withBypassContext(() => db.execute(sql`update bom_components set quantity_per='3' where org_id=${org.orgId} and assembly_item_id=${org.items.assembly}`))
      const input = {buildMovementId:built.movementId,quantity:'4',date:org.date,reason:'Recover components for service spares',idempotencyKey:randomUUID()}
      const first = await disassembleAssembly(org.orgId,actor,input)
      assert.equal(first.value.components[0]!.quantity,'8.0000'); assert.equal(first.value.components[0]!.value,'40.0000')
      const components = await getOnHand(org.orgId,org.items.component,org.stockLocationId)
      const assemblies = await getOnHand(org.orgId,org.items.assembly,org.stockLocationId)
      assert.equal(components.quantity,'88.0000'); assert.equal(components.value,'440.0000')
      assert.equal(assemblies.quantity,'6.0000'); assert.equal(assemblies.value,'60.0000')
      const replay = await disassembleAssembly(org.orgId,actor,input)
      assert.equal(replay.replayed,true); assert.deepEqual(replay.value,first.value)
      await assert.rejects(disassembleAssembly(org.orgId,actor,{...input,quantity:'3'}),/different input/)
      await assert.rejects(disassembleAssembly(org.orgId,actor,{...input,quantity:'7',idempotencyKey:randomUUID()}),/exceeds the source build/)
      const next = await disassembleAssembly(org.orgId,actor,{...input,quantity:'2',idempotencyKey:randomUUID()})
      assert.equal(next.value.components[0]!.quantity,'4.0000'); assert.equal(next.value.components[0]!.value,'20.0000')
      const options = await listInventoryOperationOptions(org.orgId,actor,{operation:'reverse',q:'Assembly',limit:1})
      assert.equal(options.options.length,1); assert.ok(options.totalCount>1); assert.ok(options.nextCursor)
      const page = await listInventoryOperationOptions(org.orgId,actor,{operation:'reverse',q:'Assembly',limit:1,cursor:options.nextCursor})
      assert.equal(page.options.length,1); assert.notEqual(page.options[0]!.id,options.options[0]!.id)
      await assert.rejects(reverseAssemblyBuild(org.orgId,actor,{movementId:built.movementId,reversalDate:org.date,reason:'Correct the original build quantity'}),/reverse those disassembly operations/)
      const recovered = first.value.movementIds.find(id=>id!==first.value.movementId)!
      const undo = {movementId:recovered,reversalDate:org.date,reason:'The recorded disassembly did not take place'}
      const reversed = await reverseAssemblyDisassembly(org.orgId,actor,undo)
      assert.equal(reversed.movementIds.length,first.value.movementIds.length)
      assert.equal((await reverseAssemblyDisassembly(org.orgId,actor,undo)).alreadyReversed,true)
      await reverseAssemblyDisassembly(org.orgId,actor,{...undo,movementId:next.value.movementId})
      await reverseAssemblyBuild(org.orgId,actor,{movementId:built.movementId,reversalDate:org.date,reason:'Correct the original build quantity'})
      assert.equal((await getOnHand(org.orgId,org.items.component,org.stockLocationId)).value,'500.0000')
      assert.equal((await getOnHand(org.orgId,org.items.assembly,org.stockLocationId)).quantity,'0.0000')
      await withBypassContext(() => db.execute(sql`update bom_components set quantity_per='2' where org_id=${org.orgId} and assembly_item_id=${org.items.assembly}`))
      const impaired = await buildAssembly(org.orgId,actor,{assemblyItemId:org.items.assembly,quantity:'2',stockLocationId:org.stockLocationId,subsidiaryId:org.subsidiaryId,date:org.date})
      await writeDownInventoryToNrv(org.orgId,actor,{itemId:org.items.assembly,stockLocationId:org.stockLocationId,subsidiaryId:org.subsidiaryId,nrvPerUnit:'6',date:org.date,memo:'Damage reduces recoverable stock value'})
      const recovery = await disassembleAssembly(org.orgId,actor,{...input,buildMovementId:impaired.movementId,quantity:'1',idempotencyKey:randomUUID()})
      assert.equal(recovery.value.value,'6.0000'); assert.equal(recovery.value.components[0]!.value,'6.0000')
      assert.equal(recovery.value.components[0]!.originalCost,'10.0000')
      const layers = (await db.execute<{ value:string }>(sql`select sum(remaining_quantity*unit_cost)::text as value from cost_layers where org_id=${org.orgId}`)).rows[0]!.value
      const ledger = (await db.execute<{ value:string }>(sql`select sum(line.amount)::text as value from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
        where line.org_id=${org.orgId} and line.account_id=${org.accounts.invAsset} and entry.status in ('posted','reversed')`)).rows[0]!.value
      assert.equal(layers,'492.00000000'); assert.equal(ledger,'492.0000')
      await writeDownInventoryToNrv(org.orgId,actor,{itemId:org.items.assembly,stockLocationId:org.stockLocationId,subsidiaryId:org.subsidiaryId,nrvPerUnit:'0',date:org.date,memo:'Remaining damaged assemblies have no recoverable value'})
      const zero = await disassembleAssembly(org.orgId,actor,{...input,buildMovementId:impaired.movementId,quantity:'1',idempotencyKey:randomUUID()})
      assert.equal(zero.value.entryId,null); assert.equal(zero.value.value,'0.0000')
      assert.equal(zero.value.components[0]!.quantity,'2.0000'); assert.equal(zero.value.components[0]!.value,'0.0000')
      const evidence = (await db.execute<{quantity:string;journal_entry_id:string|null}>(sql`select operation.quantity::text,operation.journal_entry_id
        from assembly_disassemblies operation join inventory_movements movement on movement.org_id=operation.org_id and movement.assembly_disassembly_id=operation.id
        where movement.org_id=${org.orgId} and movement.id=${zero.value.movementId}`)).rows[0]!
      assert.equal(evidence.quantity,'1.0000'); assert.equal(evidence.journal_entry_id,null)
      const zeroOptions = await listInventoryOperationOptions(org.orgId,actor,{operation:'reverse',q:'Assembly',limit:100})
      assert.ok(zeroOptions.options.some(option=>option.id===zero.value.movementId))
      const zeroUndo = {movementId:zero.value.movementId,reversalDate:org.date,reason:'Correct the zero-value physical recovery'}
      const zeroReversed = await reverseAssemblyDisassembly(org.orgId,actor,zeroUndo)
      assert.equal(zeroReversed.entryId,null); assert.equal(zeroReversed.movementIds.length,zero.value.movementIds.length)
      assert.equal((await reverseAssemblyDisassembly(org.orgId,actor,zeroUndo)).alreadyReversed,true)
      assert.equal((await getOnHand(org.orgId,org.items.assembly,org.stockLocationId)).quantity,'1.0000')
      assert.equal((await getOnHand(org.orgId,org.items.assembly,org.stockLocationId)).value,'0.0000')
      await withBypassContext(() => db.execute(sql`update user_permission_overrides set effect='deny' where org_id=${org.orgId} and user_id=${actor} and permission='items.post'`))
      await assert.rejects(disassembleAssembly(org.orgId,actor,input),error=>error instanceof Error && 'status' in error && error.status===404)
    })
  } finally {await dropScratchOrg(org.orgId)}
})
