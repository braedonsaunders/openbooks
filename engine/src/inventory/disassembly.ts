import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '../platform/db.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { assertPeriodModulesOpen, CloseError } from '../periods/period-policy.ts'
import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts'
import { loadSubsidiaryContext } from '../organization/subsidiaries.ts'
import { add, cmp, fromUnits, isZero, neg, roundDiv, sum, toUnits } from '../money/money.ts'
import type { AssemblyBomRevisionEvidence } from '@openbooks/schema'
import { InventoryError, type InventoryProfile } from './contracts.ts'
import { executeIdempotentInventoryAction, inventoryRequestHash } from './action-idempotency.ts'
import { assertInventoryFeature, assertStockLocationAdmitsSubsidiary, resolveProfile } from './profile-policy.ts'
import { assertItemsActive } from './item-active.ts'
import { assertInventoryDate, getOnHandWith, lockInventoryPosition, periodForDate, persistReceiptMoney, subsidiaryCurrency } from './position.ts'
import { consumeLayers, recordConsumptions, addLayerAtCost } from './cost-layers.ts'
import { extendCost, unitCostPerQuantity } from './costing.ts'
import { postInventoryEntry, stockLocationDim, type JournalLineInput } from './journal.ts'
import { removeInboundLayer, restoreIssueLayers, reverseInventoryJournal, type ReversibleMovement, type ReverseInventoryInput, type ReverseInventoryResult } from './reversal.ts'

export interface DisassemblyInput {
  buildMovementId: string
  quantity: string
  date: string
  reason: string
  idempotencyKey: string
}
export interface DisassemblyResult {
  movementId: string
  movementIds: string[]
  entryId: string | null
  value: string
  components: { itemId: string; quantity: string; value: string; originalCost: string }[]
}

type OperationMovement = ReversibleMovement & { assembly_disassembly_id: string | null }
const movementColumns = sql`id,org_id,subsidiary_id,item_id,kind,moved_at::text,stock_location_id,lot_id,serial_id,
  quantity,unit_cost,total_value,journal_entry_id,paired_movement_id,status,assembly_disassembly_id`
async function sourceMovement(orgId: string, id: string) {
  const row = (await db.execute<OperationMovement>(sql`select ${movementColumns} from inventory_movements where org_id=${orgId} and id=${id}`)).rows[0]
  if (!row) throw new ScopeNotFoundError()
  return row
}
async function lockPositions(rows: ReversibleMovement[]) {
  const keys = [...new Set(rows.map(row => `${row.item_id}:${row.stock_location_id}`))].sort()
  for (const key of keys) {
    const separator = key.indexOf(':')
    await lockInventoryPosition(db, key.slice(0, separator), key.slice(separator + 1))
  }
}
async function operationRows(orgId: string, entryId: string, locked = false) {
  return (await db.execute<OperationMovement>(sql`select ${movementColumns} from inventory_movements
    where org_id=${orgId} and journal_entry_id=${entryId} order by id ${locked ? sql`for update` : sql``}`)).rows
}
async function disassemblyRows(orgId: string, id: string, locked = false) {
  return (await db.execute<OperationMovement>(sql`select ${movementColumns} from inventory_movements
    where org_id=${orgId} and assembly_disassembly_id=${id} and kind in ('assembly_disassembly','assembly_recovery')
    order by id ${locked ? sql`for update` : sql``}`)).rows
}
async function openPeriod(orgId: string, bookId: string, subsidiaryId: string, date: string) {
  const periodId = await periodForDate(orgId,date)
  if (!periodId) throw new InventoryError(`Create an open accounting period covering ${date} before changing inventory`)
  if (!(await db.execute(sql`select id from accounting_books where org_id=${orgId} and id=${bookId} and is_active and posts_gl for share`)).rows.length)
    throw new InventoryError('The original accounting book must be active for controlled inventory operations')
  try { await assertPeriodModulesOpen(db,{orgId,periodId,bookId,subsidiaryIds:[subsidiaryId],modules:[]}) }
  catch (error) { if (error instanceof CloseError) throw new InventoryError(`${error.message} — use an open operation date or the controlled reopen workflow in Accounting → Close`); throw error }
  return periodId
}
async function assertUnreversed(orgId: string, rows: ReversibleMovement[]) {
  if (rows.some(row => row.status !== 'posted')) throw new InventoryError('The source operation must be fully posted')
  const ids = rows.map(row => row.id)
  if ((await db.execute(sql`select id from inventory_movements where org_id=${orgId}
    and reverses_movement_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) limit 1`)).rows.length)
    throw new InventoryError('This source build has been reversed — select a posted build that has not been reversed')
}
function reason(value: string) {
  if (typeof value !== 'string' || value.trim().length < 5 || value.trim().length > 500)
    throw new InventoryError('Record a disassembly reason using 5–500 characters')
  return value.trim()
}

/** A physical disassembly is a new operation, not an edit or a partial journal
 * reversal. It uses the immutable build recipe and consumed component costs.
 * Cumulative allocations own rounding residuals, so repeated partial operations
 * cannot create quantity or original cost. Tracked stock requires the allocation
 * evidence that the light-assembly build itself does not accept. */
export async function disassembleAssembly(orgId: string, actorId: string, input: DisassemblyInput) {
  const quantity = persistReceiptMoney(input.quantity, 'Disassembly quantity')
  if (cmp(quantity, '0') <= 0) throw new InventoryError('Disassembly quantity must be positive')
  assertInventoryDate(input.date, 'Disassembly date')
  const explanation = reason(input.reason)
  // Replays still consult current authority before the key can reveal evidence.
  await withOrgTransaction(orgId, async () => {
    const source = await sourceMovement(orgId, input.buildMovementId)
    await lockActorCommandAuthority(db, orgId, actorId, source.subsidiary_id, 'items.post')
    await assertInventoryFeature(db, orgId)
  })
  return executeIdempotentInventoryAction(orgId, actorId, {
    operation: 'inventory.disassemble', idempotencyKey: input.idempotencyKey,
    request: { buildMovementId: input.buildMovementId, quantity, date: input.date, reason: explanation },
    execute: async (): Promise<DisassemblyResult> => {
      const peek = await sourceMovement(orgId, input.buildMovementId)
      if (peek.kind !== 'assembly_build' || !peek.journal_entry_id) throw new InventoryError('Select the finished-good movement of the original assembly build')
      await lockActorCommandAuthority(db, orgId, actorId, peek.subsidiary_id, 'items.post')
      await assertInventoryFeature(db, orgId)
      await lockPositions(await operationRows(orgId, peek.journal_entry_id))
      const sources = await operationRows(orgId, peek.journal_entry_id, true)
      const build = sources.find(row => row.id === input.buildMovementId)
      if (!build || sources.filter(row => row.kind === 'assembly_build').length !== 1 || !sources.some(row => row.kind === 'assembly_consume')
          || sources.some(row => !['assembly_build', 'assembly_consume'].includes(row.kind) || row.subsidiary_id !== build.subsidiary_id || row.stock_location_id !== build.stock_location_id))
        throw new InventoryError('The source journal does not contain one complete light-assembly build')
      await assertUnreversed(orgId, sources)
      const journal = (await db.execute<{ book_id: string; custom: { assemblyBuild?: AssemblyBomRevisionEvidence }; origin: string }>(sql`
        select book_id,custom,origin from journal_entries where org_id=${orgId} and id=${build.journal_entry_id} and status='posted' for share`)).rows[0]
      const evidence = journal?.custom.assemblyBuild
      if (journal?.origin !== 'inventory' || !evidence || evidence.format !== 'openbooks.inventory-bom.v1' || evidence.assemblyItemId !== build.item_id
          || evidence.revision !== `sha256:${inventoryRequestHash({ format: evidence.format, assemblyItemId: evidence.assemblyItemId, components: evidence.components })}`)
        throw new InventoryError('The build lacks a complete immutable recipe — disassembly cannot infer a recipe from current configuration')
      if (input.date < build.moved_at.slice(0, 10)) throw new InventoryError('Disassembly date cannot precede the source build')
      const profiles = new Map<string, InventoryProfile>()
      for (const id of [...new Set(sources.map(row => row.item_id))].sort()) profiles.set(id, await resolveProfile(orgId, id, db, true))
      if ([...profiles.values()].some(profile => profile.tracking !== 'none') || sources.some(row => row.lot_id || row.serial_id))
        throw new InventoryError('This light-assembly operation requires untracked stock; tracked builds need explicit serial or lot recovery allocations')
      await assertItemsActive(db, orgId, [...profiles.keys()], { inactiveRemedy: 'reactivate the stock item before performing a physical disassembly',
        outsideOrganization: 'The source build references a stock item outside this organization' })
      const context = await loadSubsidiaryContext(db, orgId)
      await assertStockLocationAdmitsSubsidiary(db, orgId, context, build.stock_location_id, build.subsidiary_id, 'inbound')
      const periodId = await openPeriod(orgId,journal.book_id,build.subsidiary_id,input.date)
      const prior = (await db.execute<{ item_id: string; kind: string; quantity: string; total_value: string }>(sql`
        select move.item_id,move.kind,move.quantity::text,move.total_value::text from inventory_movements move
          join assembly_disassemblies operation on operation.org_id=move.org_id and operation.id=move.assembly_disassembly_id
        where move.org_id=${orgId} and operation.build_movement_id=${build.id}
          and move.kind in ('assembly_disassembly','assembly_recovery') and move.status='posted'
          and not exists(select 1 from inventory_movements rev where rev.org_id=move.org_id and rev.reverses_movement_id=move.id)`)).rows
      const previouslyDisassembled = neg(sum(prior.filter(row => row.kind === 'assembly_disassembly').map(row => row.quantity)))
      const cumulativeQuantity = add(previouslyDisassembled, quantity)
      if (cmp(cumulativeQuantity, build.quantity) > 0) throw new InventoryError('Disassembly exceeds the source build quantity remaining after its earlier disassemblies')
      const assembly = profiles.get(build.item_id)!
      const onHand = await getOnHandWith(db, orgId, build.item_id, build.stock_location_id, { subsidiaryId: build.subsidiary_id })
      const withdrawal = await consumeLayers(db, orgId, assembly, build.item_id, build.stock_location_id, quantity, onHand, undefined,
        { sourceReceiptMovementId: build.id }, build.subsidiary_id, actorId)
      if (!isZero(withdrawal.shortfallQuantity))
        throw new InventoryError('The original build no longer has enough identifiable stock at this location — reverse its downstream issues or transfers before disassembly')
      const components: DisassemblyResult['components'] = []
      for (const itemId of [...new Set(sources.filter(row => row.kind === 'assembly_consume').map(row => row.item_id))].sort()) {
        const consumed = sources.filter(row => row.kind === 'assembly_consume' && row.item_id === itemId)
        if (consumed.some(row => row.total_value === null || cmp(row.quantity, '0') >= 0 || cmp(row.total_value!, '0') > 0))
          throw new InventoryError('The build component cost evidence is incomplete — physical recovery cannot invent the missing cost')
        const recipe = evidence.components.filter(row => row.componentItemId === itemId)
        if (!recipe.length) throw new InventoryError('The consumed components do not match the immutable build recipe')
        const totalConsumedQuantity = neg(sum(consumed.map(row => row.quantity)))
        const totalConsumedCost = neg(sum(consumed.map(row => row.total_value!)))
        // Normal recipe scrap was consumed but is not recoverable material.
        const nominalQuantity = fromUnits(roundDiv(toUnits(sum(recipe.map(row => row.quantityPer))) * toUnits(cumulativeQuantity), 10000n))
        const previous = prior.filter(row => row.kind === 'assembly_recovery' && row.item_id === itemId)
        const recoveredQuantity = add(nominalQuantity, neg(sum(previous.map(row => row.quantity))))
        if (cmp(nominalQuantity, totalConsumedQuantity) > 0 || cmp(recoveredQuantity, '0') <= 0)
          throw new InventoryError('The requested partial recovery is outside the recorded component quantity precision — increase the disassembly quantity')
        const originalTotal = fromUnits(roundDiv(toUnits(totalConsumedCost) * toUnits(nominalQuantity), toUnits(totalConsumedQuantity)))
        const priorOriginal = (await db.execute<{ amount: string }>(sql`select coalesce(sum((component->>'originalCost')::numeric),0)::text as amount
          from assembly_disassemblies operation cross join lateral jsonb_array_elements(operation.components) component
          where operation.org_id=${orgId} and operation.build_movement_id=${build.id} and component->>'itemId'=${itemId}
            and exists(select 1 from inventory_movements move where move.org_id=operation.org_id and move.assembly_disassembly_id=operation.id
              and move.kind='assembly_disassembly' and not exists(select 1 from inventory_movements rev where rev.org_id=move.org_id and rev.reverses_movement_id=move.id))`)).rows[0]!.amount
        const originalCost = add(originalTotal, neg(priorOriginal))
        if (cmp(originalCost, '0') < 0) throw new InventoryError('The recorded recovery cost exceeds the cumulative build allocation — reconcile the disassembly history before continuing')
        const profile = profiles.get(itemId)!
        if (profile.costingMethod === 'standard' && profile.standardCost === null)
          throw new InventoryError('Configure the component standard cost before recovering stock under standard costing')
        const value = profile.costingMethod === 'standard' ? extendCost(recoveredQuantity, profile.standardCost!) : originalCost
        components.push({ itemId, quantity: recoveredQuantity, value, originalCost })
      }
      // A physical recovery does not reverse a prior inventory write-down.
      // Cap non-standard material cost by the withdrawn carrying value; the
      // last component owns the allocation residual. Standard-cost differences
      // use the configured production variance policy instead.
      const standardValue = sum(components.filter(component => profiles.get(component.itemId)!.costingMethod === 'standard').map(component => component.value))
      const variable = components.filter(component => profiles.get(component.itemId)!.costingMethod !== 'standard')
      let availableCost = add(withdrawal.cost, neg(standardValue))
      if (cmp(availableCost, '0') < 0) availableCost = '0.0000'
      let variableBasis = sum(variable.map(component => component.value))
      if (cmp(variableBasis, availableCost) > 0) {
        for (const component of variable) {
          if (isZero(component.value)) continue
          const cost = fromUnits(roundDiv(toUnits(availableCost) * toUnits(component.value), toUnits(variableBasis)))
          availableCost = add(availableCost, neg(cost)); variableBasis = add(variableBasis, neg(component.value)); component.value = cost
        }
      }
      const locationId = await stockLocationDim(db, orgId, build.stock_location_id, null)
      const lines: JournalLineInput[] = [{ accountId: assembly.assetAccountId, amount: neg(withdrawal.cost), locationId },
        ...components.map(component => ({ accountId: profiles.get(component.itemId)!.assetAccountId, amount: component.value, locationId }))]
      const difference = add(withdrawal.cost, neg(sum(components.map(component => component.value))))
      if (!isZero(difference)) {
        const accountId = assembly.costingMethod === 'standard' ? assembly.varianceAccountId : assembly.adjustmentAccountId
        if (!accountId || lines.some(line => line.accountId === accountId)) throw new InventoryError('Configure a distinct assembly variance or inventory adjustment account for disassembly cost differences')
        lines.push({ accountId, amount: difference, locationId, memo: 'Disassembly cost difference' })
      }
      const currency = await subsidiaryCurrency(orgId, build.subsidiary_id)
      const operationId = randomUUID()
      const valuedLines = lines.filter(line => !isZero(line.amount))
      const entryId = valuedLines.length ? await postInventoryEntry(db, { orgId, bookId: journal.book_id, subsidiaryId: build.subsidiary_id, actorId, currency,
        periodId, date: input.date, entryNumber: `INV-DISASSEMBLE-${randomUUID()}`, memo: explanation, lines: valuedLines,
        custom: { assemblyDisassembly: { operationId, buildMovementId: build.id, bomRevision: evidence.revision, quantity, previouslyDisassembled, components, reason: explanation } } }) : null
      const recorded = await db.execute(sql`insert into assembly_disassemblies
        (id,org_id,subsidiary_id,book_id,build_movement_id,quantity,withdrawn_value,moved_on,reason,components,journal_entry_id,created_by)
        values (${operationId},${orgId},${build.subsidiary_id},${journal.book_id},${build.id},${quantity},${withdrawal.cost},${input.date},
          ${explanation},${JSON.stringify(components)}::jsonb,${entryId},${actorId}) returning id`)
      if (recorded.rows.length !== 1) throw new InventoryError('The immutable disassembly evidence could not be recorded')
      const movementIds: string[] = []
      const movementId = randomUUID(); movementIds.push(movementId)
      const inserted = await db.execute(sql`insert into inventory_movements
        (id,org_id,subsidiary_id,item_id,kind,moved_at,stock_location_id,quantity,unit_cost,total_value,journal_entry_id,assembly_disassembly_id,status,memo,created_by,updated_by)
        values (${movementId},${orgId},${build.subsidiary_id},${build.item_id},'assembly_disassembly',${input.date},${build.stock_location_id},
          ${neg(quantity)},${withdrawal.unitCost},${neg(withdrawal.cost)},${entryId},${operationId},'posted',${explanation},${actorId},${actorId}) returning id`)
      if (inserted.rows.length !== 1) throw new InventoryError('The disassembly movement could not be recorded')
      await recordConsumptions(db, orgId, build.subsidiary_id, withdrawal.consumptions, movementId, actorId)
      for (const component of components) {
        const id = randomUUID(); movementIds.push(id)
        const unitCost = unitCostPerQuantity(component.value, component.quantity)!
        const created = await db.execute(sql`insert into inventory_movements
          (id,org_id,subsidiary_id,item_id,kind,moved_at,stock_location_id,quantity,unit_cost,total_value,journal_entry_id,assembly_disassembly_id,status,memo,created_by,updated_by)
          values (${id},${orgId},${build.subsidiary_id},${component.itemId},'assembly_recovery',${input.date},${build.stock_location_id},
            ${component.quantity},${unitCost},${component.value},${entryId},${operationId},'posted',${explanation},${actorId},${actorId}) returning id`)
        if (created.rows.length !== 1) throw new InventoryError('The recovered component movement could not be recorded')
        await addLayerAtCost(db, orgId, build.subsidiary_id, component.itemId, build.stock_location_id, component.quantity, component.value,
          profiles.get(component.itemId)!.costingMethod, id, input.date, actorId, unitCost, component.originalCost)
      }
      await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
        values (${orgId},'inventory_movements',${movementId},'insert',${JSON.stringify({ sourceBuildMovementId: build.id, quantity, components, entryId, reason: explanation })}::jsonb,${actorId})`)
      return { movementId, movementIds, entryId, value: withdrawal.cost, components }
    },
  })
}

/** Restore a disassembly as one controlled unit. Returned components must
 * remain unconsumed and identifiable; otherwise reverse downstream activity
 * first. No child movement can reverse independently. */
export async function reverseAssemblyDisassembly(orgId: string, actorId: string, input: ReverseInventoryInput): Promise<ReverseInventoryResult> {
  const explanation = reason(input.reason)
  assertInventoryDate(input.reversalDate, 'Reversal date')
  return withOrgTransaction(orgId, async () => {
    const source = await sourceMovement(orgId, input.movementId)
    await lockActorCommandAuthority(db, orgId, actorId, source.subsidiary_id, 'items.reverse')
    await assertInventoryFeature(db, orgId)
    if (!['assembly_disassembly', 'assembly_recovery'].includes(source.kind) || !source.assembly_disassembly_id)
      throw new InventoryError('Select a movement belonging to the disassembly operation')
    const operation = (await db.execute<{ book_id: string; journal_entry_id: string | null }>(sql`select book_id,journal_entry_id from assembly_disassemblies
      where org_id=${orgId} and id=${source.assembly_disassembly_id} for share`)).rows[0]
    if (!operation) throw new InventoryError('The disassembly operation evidence is unavailable')
    await lockPositions(await disassemblyRows(orgId, source.assembly_disassembly_id))
    const sources = await disassemblyRows(orgId, source.assembly_disassembly_id, true)
    if (sources.filter(row => row.kind === 'assembly_disassembly').length !== 1 || !sources.some(row => row.kind === 'assembly_recovery')
        || sources.some(row => !['assembly_disassembly', 'assembly_recovery'].includes(row.kind) || row.subsidiary_id !== source.subsidiary_id || row.stock_location_id !== source.stock_location_id || row.status !== 'posted'))
      throw new InventoryError('The source journal does not contain one complete disassembly operation')
    const prior = (await db.execute<{ id: string; journal_entry_id: string | null }>(sql`select id,journal_entry_id from inventory_movements where org_id=${orgId}
      and reverses_movement_id in (${sql.join(sources.map(row => sql`${row.id}`), sql`, `)}) order by id`)).rows
    if (prior.length) {
      if (prior.length !== sources.length) throw new InventoryError('The disassembly reversal evidence is incomplete')
      return { movementIds: prior.map(row => row.id), entryId: prior[0]!.journal_entry_id, alreadyReversed: true }
    }
    if (sources.some(row => input.reversalDate < row.moved_at.slice(0, 10))) throw new InventoryError('Reversal date cannot precede the disassembly')
    await openPeriod(orgId,operation.book_id,source.subsidiary_id,input.reversalDate)
    for (const row of sources.filter(row => row.kind === 'assembly_recovery')) await removeInboundLayer(db, orgId, row, actorId)
    await restoreIssueLayers(db, orgId, sources.find(row => row.kind === 'assembly_disassembly')!, actorId)
    const entryId = operation.journal_entry_id ? await reverseInventoryJournal(db, orgId, actorId, operation.journal_entry_id, input.reversalDate, explanation) : null
    const ids: string[] = []
    for (const row of sources) {
      const id = randomUUID(); ids.push(id)
      const inserted = await db.execute(sql`insert into inventory_movements
        (id,org_id,subsidiary_id,item_id,kind,moved_at,stock_location_id,quantity,unit_cost,total_value,journal_entry_id,assembly_disassembly_id,reverses_movement_id,reversal_reason,status,memo,created_by,updated_by)
        values (${id},${orgId},${row.subsidiary_id},${row.item_id},'return',${input.reversalDate},${row.stock_location_id},${neg(row.quantity)},${row.unit_cost},
          ${row.total_value === null ? null : neg(row.total_value)},${entryId},${source.assembly_disassembly_id},${row.id},${explanation},'posted',${explanation},${actorId},${actorId}) returning id`)
      if (inserted.rows.length !== 1) throw new InventoryError('The disassembly reversal could not be recorded')
      await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
        values (${orgId},'inventory_movements',${row.id},'void',${JSON.stringify({ reversalMovementId: id, entryId, reason: explanation })}::jsonb,${actorId})`)
    }
    return { movementIds: ids.sort(), entryId, alreadyReversed: false }
  })
}
