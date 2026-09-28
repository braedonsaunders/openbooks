import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const wip = await import('./wip-billing')

/**
 * WIP prebilling is project-scoped work: every read and write must honour the
 * caller's subsidiary scope. A worksheet on a hidden project is invisible in
 * lists and analytics, unreachable by id (404 — the same answer as a missing
 * id), and cannot be created, edited, held, transitioned, or converted.
 */
test('WIP prebilling honours the caller subsidiary scope end to end', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const actors = await seedFlowActors(org.orgId)
      const preparer = actors.adminId, approver = actors.approver1Id
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), other = randomUUID(), project = randomUUID(), employee = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'scratch fixture baseline')`)
      // The project lives in the OTHER subsidiary; the restricted caller sees only the root.
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${other},'WIP','Hidden WIP job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Billable worker',${other})`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
        values (${entry},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)

      const restricted = new Set([org.subsidiaryId])
      const visible = new Set([org.subsidiaryId, other])
      const period = { projectId: project, periodEnd: org.date }
      const notFound = (error: unknown) => error instanceof wip.WipBillingError && error.status === 404

      // Reads
      assert.deepEqual((await wip.listWipProjects(org.orgId, restricted)).map((p) => p.id), [])
      assert.deepEqual((await wip.listWipProjects(org.orgId, visible)).map((p) => p.id), [project])
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, restricted)).aging.current, '0')
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, visible)).aging.current, '200.0000')
      // Create
      await assert.rejects(wip.createPrebill(org.orgId, preparer, period, restricted), notFound)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n, 0)
      const prebill = await wip.createPrebill(org.orgId, preparer, period, visible)
      assert.equal(prebill.sourceCount, 1)
      // Lists and by-id loads
      assert.deepEqual(await wip.listPrebills(org.orgId, undefined, restricted), [])
      assert.deepEqual(await wip.listPrebills(org.orgId, project, restricted), [])
      assert.equal((await wip.listPrebills(org.orgId, undefined, visible)).length, 1)
      assert.equal(await wip.loadPrebill(org.orgId, prebill.id, restricted), null)
      const detail = await wip.loadPrebill(org.orgId, prebill.id, visible)
      assert.equal(detail?.lines.length, 1)
      const lineId = detail!.lines[0]!.id
      // Line edits and holds
      await assert.rejects(wip.updatePrebillLine(org.orgId, preparer, prebill.id, lineId, { proposedBillAmount: '150.0000', adjustmentReason: 'scope', adjustmentEvidence: ['note'] }, restricted, { expectedRevision: detail!.lines[0]!.updatedAt }), notFound)
      await assert.rejects(wip.holdPrebillLine(org.orgId, preparer, prebill.id, lineId, 'Disputed', [], restricted), notFound)
      const hold = await wip.holdPrebillLine(org.orgId, preparer, prebill.id, lineId, 'Disputed', [], visible)
      await assert.rejects(wip.releaseWipHold(org.orgId, preparer, hold.id, 'Resolved', restricted), notFound)
      await wip.releaseWipHold(org.orgId, preparer, hold.id, 'Resolved', visible)
      // Workflow
      await assert.rejects(wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, restricted), notFound)
      await wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, visible)
      await assert.rejects(wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, restricted), notFound)
      await wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, visible)
      // Convert
      await assert.rejects(wip.convertPrebill(org.orgId, preparer, prebill.id, restricted), notFound)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n, 0)
      const converted = await wip.convertPrebill(org.orgId, preparer, prebill.id, visible)
      assert.equal(converted.idempotent, false)
      // The converted worksheet stays hidden too.
      assert.equal(await wip.loadPrebill(org.orgId, prebill.id, restricted), null)
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, restricted)).realization.billed, '0')
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, visible)).realization.billed, '200.0000')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

test('prebill line edits refuse proposed amounts wider than numeric(19,4)', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  // wip_prebill_lines.proposed_bill_amount is numeric(19,4): a pasted
  // 20-digit figure cleared the exact-decimal check and died in the update
  // with a storage error. Fail closed with a named error instead.
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const actors = await seedFlowActors(org.orgId)
      const preparer = actors.adminId
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), project = randomUUID(), employee = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'magnitude fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'WIPMAG','Magnitude WIP job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Magnitude worker',${org.subsidiaryId})`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
        values (${entry},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)
      const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null)
      const loadedLine = (await wip.loadPrebill(org.orgId, prebill.id, null))!.lines[0]!
      const lineId = loadedLine.id
      const revision = { expectedRevision: loadedLine.updatedAt }
      const edit: { adjustmentReason: string; adjustmentEvidence: string[] } = { adjustmentReason: 'magnitude', adjustmentEvidence: ['note'] }
      await assert.rejects(
        wip.updatePrebillLine(org.orgId, preparer, prebill.id, lineId, { proposedBillAmount: '99999999999999999999', ...edit }, null, revision),
        (error: unknown) => error instanceof wip.WipBillingError && /out of range/.test(error.message),
        'an oversized proposed amount should fail closed with a named error',
      )
      const untouched = await wip.loadPrebill(org.orgId, prebill.id, null)
      assert.equal(untouched!.lines[0]!.proposedBillAmount, '200.0000')
      // The column maximum itself still saves with identical read-back.
      await wip.updatePrebillLine(org.orgId, preparer, prebill.id, lineId, { proposedBillAmount: '999999999999999.9999', ...edit }, null, revision)
      const saved = await wip.loadPrebill(org.orgId, prebill.id, null)
      assert.equal(saved!.lines[0]!.proposedBillAmount, '999999999999999.9999')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

/**
 * H-WIP-REHOME: a concurrent project A→B rehome must not let an A-only
 * caller keep reading or writing the worksheet. The project row is locked
 * and scope is rechecked inside every transaction (share for the detail
 * read, update for line/transition/convert writes), so post-rehome calls
 * answer not-found instead of acting on B's data.
 */
test('a project rehome out of scope hides the worksheet from reads and writes', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const actors = await seedFlowActors(org.orgId)
      const preparer = actors.adminId, approver = actors.approver1Id
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), other = randomUUID(), project = randomUUID(), employee = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'rehome fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'WIPRE','Rehome WIP job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Rehome worker',${org.subsidiaryId})`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
        values (${entry},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)

      const restricted = new Set([org.subsidiaryId])
      const both = new Set([org.subsidiaryId, other])
      const notFound = (error: unknown) => error instanceof wip.WipBillingError && error.status === 404
      const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, restricted)
      const lineId = (await wip.loadPrebill(org.orgId, prebill.id, restricted))!.lines[0]!.id
      const deferred = () => {
        let resolve!: () => void
        const promise = new Promise<void>((done) => { resolve = done })
        return { promise, resolve }
      }
      const waitForProjectLock = async () => {
        for (let i = 0; i < 100; i++) {
          const waiting = (await db.execute<{ waiting: boolean }>(sql`
            select exists (
              select 1 from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'
                 and query ilike '%from projects p%' and query ilike '%for update%'
            ) as waiting
          `)).rows[0]!.waiting
          if (waiting) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.fail('WIP hold mutation must wait on the locked project scope row')
      }
      const raceRehome = async (subsidiaryId: string, work: () => Promise<unknown>) => {
        const locked = deferred()
        const resume = deferred()
        const rehome = db.transaction(async (tx) => {
          await tx.execute(sql`update projects set subsidiary_id = ${subsidiaryId} where id = ${project} and org_id = ${org.orgId}`)
          locked.resolve()
          await resume.promise
        })
        await locked.promise
        let finished = false
        const mutation = work().then((value) => ({ value }), (error: unknown) => ({ error })).finally(() => { finished = true })
        try {
          await waitForProjectLock()
          assert.equal(finished, false, 'the scoped mutation cannot pass a concurrent project rehome')
        } finally {
          resume.resolve()
        }
        await rehome
        return mutation
      }
      // Hold creation and release share the project row with rehome. An A-only
      // operation waits, then rechecks and returns the same 404 as an absent
      // project after the project commits into B.
      const createRace = await raceRehome(other, () => wip.holdPrebillLine(org.orgId, preparer, prebill.id, lineId, 'Create race', [], restricted))
      assert.ok('error' in createRace && notFound(createRace.error))
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_holds where org_id = ${org.orgId} and source_id = ${entry} and released_at is null`)).rows[0]!.n, 0)
      await db.execute(sql`update projects set subsidiary_id = ${org.subsidiaryId} where id = ${project} and org_id = ${org.orgId}`)
      const hold = await wip.holdPrebillLine(org.orgId, preparer, prebill.id, lineId, 'Release race', [], restricted)
      const releaseRace = await raceRehome(other, () => wip.releaseWipHold(org.orgId, preparer, hold.id, 'Release race', restricted))
      assert.ok('error' in releaseRace && notFound(releaseRace.error))
      assert.equal((await db.execute<{ released_at: string | null }>(sql`select released_at from wip_holds where org_id = ${org.orgId} and id = ${hold.id}`)).rows[0]!.released_at, null)
      await db.execute(sql`update projects set subsidiary_id = ${org.subsidiaryId} where id = ${project} and org_id = ${org.orgId}`)
      await wip.releaseWipHold(org.orgId, preparer, hold.id, 'Restore test fixture', restricted)
      await wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, restricted)

      // The concurrent rehome commits: the project (and its worksheet) now
      // belongs to the other entity.
      await db.execute(sql`update projects set subsidiary_id = ${other} where id = ${project} and org_id = ${org.orgId}`)

      // Reads recheck under a share lock: the A-only caller sees nothing.
      assert.equal(await wip.loadPrebill(org.orgId, prebill.id, restricted), null)
      assert.deepEqual(await wip.listPrebills(org.orgId, undefined, restricted), [])
      // Writes recheck under an update lock: every path refuses by name and
      // persists nothing.
      const detail = (await wip.loadPrebill(org.orgId, prebill.id, both))!
      await assert.rejects(
        wip.updatePrebillLine(org.orgId, preparer, prebill.id, lineId, { proposedBillAmount: '150.0000', adjustmentReason: 'rehome', adjustmentEvidence: ['note'] }, restricted, { expectedRevision: detail.lines[0]!.updatedAt }),
        notFound,
      )
      await assert.rejects(wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, restricted), notFound)
      await assert.rejects(wip.convertPrebill(org.orgId, preparer, prebill.id, restricted), notFound)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n, 0)
      // The locks do not break the legitimate flow: in-scope callers proceed.
      await wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, both)
      const converted = await wip.convertPrebill(org.orgId, preparer, prebill.id, both)
      assert.equal(converted.idempotent, false)
    } finally { await dropScratchOrg(org.orgId) }
  })
})


const consolidatedRows = [
  { label: "wip contract capacity kinds", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const wip = await import('./wip-billing')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

        /**
         * The NTE capacity query binds the profile's doc/credit kinds as a text[]
         * literal. A kind containing a comma must stay ONE array element: if the
         * literal builder splits it, the capacity counts document kinds the profile
         * never named and the not-to-exceed cap enforces against the wrong set.
         */
        test('contract capacity keeps a comma-bearing doc kind as one array element', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
              const typeId = randomUUID(), project = randomUUID(), doc = randomUUID(), line = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'capacity fixture')`)
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
                values (${project},${org.orgId},${org.subsidiaryId},'WIP-CAP','Capacity job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total)
                values (${doc},${org.orgId},'customer_invoice',${'INV-'+doc},${org.customerId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','1000','0','1000')`)
              await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable,project_id)
                values (${line},${org.orgId},${doc},1,${org.items.service},${org.accounts.cogs},'Billed service',1,'1000','1000',true,${project})`)
              await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${doc}`)

              // Control: the plain kind counts the posted invoice.
              assert.equal(
                await wip.projectContractCapacityUsed(db, org.orgId, project, { docKinds: ['customer_invoice'], creditKinds: [] }),
                '1000.0000',
              )
              // A single kind that merely CONTAINS a comma names no real document
              // kind, so capacity must be zero — not the invoice the split would match.
              assert.equal(
                await wip.projectContractCapacityUsed(db, org.orgId, project, { docKinds: ['customer_invoice,phantom'], creditKinds: [] }),
                '0.0000',
              )
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "wip prebill line revision", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const wip = await import('./wip-billing')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

        /**
         * Two tabs editing the same draft prebill line: the second save carries the
         * revision token it read before the first save committed, so it must fail
         * with a 409 instead of silently overwriting the first tab's billed amount.
         * (Budget worksheet cells mandate expectedRevision; prebill lines are the
         * same worksheet class and must too.)
         */
        test('a stale prebill-line revision refuses instead of overwriting a newer adjustment', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const preparer = (await seedFlowActors(org.orgId)).adminId
              const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
              const typeId = randomUUID(), project = randomUUID(), employee = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'revision fixture')`)
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
                values (${project},${org.orgId},${org.subsidiaryId},'WIP-REV','Revision job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
              await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Revision worker',${org.subsidiaryId})`)
              await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
                values (${randomUUID()},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)

              const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null)
              const first = (await wip.loadPrebill(org.orgId, prebill.id, null))!.lines[0]!
              const staleToken = first.updatedAt

              // Tab A saves with the fresh token.
              const tabA = await wip.updatePrebillLine(org.orgId, preparer, prebill.id, first.id, {
                proposedBillAmount: '250',
                adjustmentReason: 'Write-up for out-of-scope work',
                adjustmentEvidence: ['client email'],
              }, null, { expectedRevision: staleToken })
              assert.equal(tabA.proposedBillAmount, '250.0000')

              // Tab B still holds the pre-A token: it must lose loudly, and the live
              // amount must stay exactly what tab A wrote.
              await assert.rejects(
                wip.updatePrebillLine(org.orgId, preparer, prebill.id, first.id, {
                  proposedBillAmount: '50',
                  adjustmentReason: 'Discount the client insists on',
                  adjustmentEvidence: ['phone call'],
                }, null, { expectedRevision: staleToken }),
                (error: unknown) => error instanceof wip.WipBillingError && (error as { status?: number }).status === 409,
              )
              const live = (await wip.loadPrebill(org.orgId, prebill.id, null))!.lines[0]!
              assert.equal(live.proposedBillAmount, '250.0000')
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "wip billing credits", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const wip = await import('./wip-billing')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

        /**
         * A credit is not prebillable: prebill lines carry a non-negative CHECK, so a
         * credit-only worksheet can never persist. Creation must fail closed with a
         * domain error — not sweep the credit into an INSERT that dies on the schema
         * CHECK and surfaces as a 500.
         */
        test('a credit-only project fails prebill creation with a domain error', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const preparer = (await seedFlowActors(org.orgId)).adminId
              const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
              const financialProfile = {
                ...tm.financialProfile,
                billableValue: { ...tm.financialProfile.billableValue, costSourceKinds: ['vendor_bill', 'vendor_credit'] },
              }
              const typeId = randomUUID(), project = randomUUID(), doc = randomUUID(), line = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(financialProfile)}::jsonb,'credit fixture')`)
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
                values (${project},${org.orgId},${org.subsidiaryId},'WIP-CR','Credit-only job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total)
                values (${doc},${org.orgId},'vendor_credit',${'CR-'+doc},${org.vendorId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','100','0','100')`)
              await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable)
                values (${line},${org.orgId},${doc},1,${org.items.service},${org.accounts.cogs},'Refunded service',1,'100','100',true)`)
              await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${doc}`)

              await assert.rejects(
                wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null),
                (error: unknown) => error instanceof wip.WipBillingError,
              )
              assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n, 0)
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "wip prebill numbering", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const wip = await import('./wip-billing')

        /**
         * Worksheet numbers are unique per ORGANIZATION (wip_prebills_org_number)
         * but createPrebill serialised only per PROJECT
         * (pg_advisory_xact_lock on `wip-prebill:{org}:{project}`). Two reviewers
         * creating worksheets for DIFFERENT projects at the same time both read the
         * same org-wide max()+1 and the loser dies on the unique index (500). The
         * numbering read must serialise org-wide, like billing-request numbers do.
         */
        test('concurrent prebill creates for different projects receive distinct worksheet numbers', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const actors = await seedFlowActors(org.orgId)
              const preparer = actors.adminId
              const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
              const typeId = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'scratch fixture baseline')`)

              // Eight projects, each with its own independent billable hours, so
              // every create has disjoint source work and the ONLY shared state is
              // the org-wide worksheet counter. Each worksheet carries enough lines
              // that the work between the max()+1 read and commit is wide: with no
              // org-wide serialisation, several writers' reads land inside another
              // writer's uncommitted window and collide on wip_prebills_org_number.
              const WRITERS = 8
              const LINES_EACH = 25
              const projectIds: string[] = []
              for (let i = 0; i < WRITERS; i++) {
                const project = randomUUID(), employee = randomUUID()
                await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
                  values (${project},${org.orgId},${org.subsidiaryId},${`WIP-RACE-${i}`},${`Race job ${i}`},${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
                await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee',${`Race worker ${i}`},${org.subsidiaryId})`)
                for (let j = 0; j < LINES_EACH; j++) {
                  await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
                    values (${randomUUID()},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)
                }
                projectIds.push(project)
              }

              const created = await Promise.all(projectIds.map((projectId) =>
                wip.createPrebill(org.orgId, preparer, { projectId, periodEnd: org.date }),
              ))
              assert.equal(created.length, WRITERS)
              for (const prebill of created) assert.equal(prebill.sourceCount, LINES_EACH)
              const numbers = created.map((prebill) => prebill.worksheetNumber).sort()
              assert.deepEqual(numbers, [
                'WIP-00001', 'WIP-00002', 'WIP-00003', 'WIP-00004',
                'WIP-00005', 'WIP-00006', 'WIP-00007', 'WIP-00008',
              ])
              assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n, WRITERS)
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "wip convert rounding", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const wip = await import('./wip-billing')

        /**
         * WIP conversion settles whole minor units by largest remainder: two
         * approved 0.0050 draws must invoice as 0.01 + 0.00 (total 0.01), not as
         * two independently rounded 0.01 lines (total 0.02 — a total nobody
         * approved). The invoice lines sum to the approved total exactly.
         */
        test('convertPrebill allocates the rounded approved total by largest remainder', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const actors = await seedFlowActors(org.orgId)
              const preparer = actors.adminId, approver = actors.approver1Id
              const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
              const typeId = randomUUID(), project = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'rounding fixture')`)
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
                values (${project},${org.orgId},${org.subsidiaryId},'WIPROUND','Rounding WIP job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
              await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${randomUUID()},${org.orgId},'employee','Rounding worker',${org.subsidiaryId})`)
              const worker = (await db.execute<{id:string}>(sql`select id from parties where org_id=${org.orgId} and display_name='Rounding worker'`)).rows[0]!.id
              // Two billable hours pricing just over half a cent each.
              for (let n = 0; n < 2; n++) {
                await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
                  values (${randomUUID()},${org.orgId},${worker},${org.date},'0.0001',${project},${org.items.service},true,'approved','50.0000','CAD')`)
              }
              const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null)
              assert.equal(prebill.sourceCount, 2)
              const detail = await wip.loadPrebill(org.orgId, prebill.id, null)
              assert.equal(detail?.lines.length, 2)
              // Certify the finding's exact shape: two approved 0.0050 draws.
              for (const line of detail!.lines) {
                await wip.updatePrebillLine(
                  org.orgId, preparer, prebill.id, line.id,
                  { proposedBillAmount: '0.0050', adjustmentReason: 'rounding probe', adjustmentEvidence: ['note'] },
                  null, { expectedRevision: line.updatedAt },
                )
              }
              const approved = await wip.loadPrebill(org.orgId, prebill.id, null)
              assert.equal(approved?.proposedBillAmount, '0.0100')
              await wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, null)
              await wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, null)

              const converted = await wip.convertPrebill(org.orgId, preparer, prebill.id, null)
              assert.equal(converted.idempotent, false)
              const invoice = (await db.execute<{ subtotal: string; tax_total: string; total: string }>(sql`
                select subtotal::text as subtotal, tax_total::text as tax_total, total::text as total
                  from documents where org_id = ${org.orgId} and id = ${converted.id}
              `)).rows[0]!
              assert.equal(invoice.total, '0.0100', 'the invoice total equals the approved total')
              assert.equal(invoice.tax_total, '0.0000')
              const lines = (await db.execute<{ amount: string }>(sql`
                select amount::text as amount from document_lines
                 where org_id = ${org.orgId} and document_id = ${converted.id} order by line_number
              `)).rows.map((row) => row.amount)
              assert.deepEqual(lines, ['0.0100', '0.0000'])
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "wip account policy", register: async () => {
        const { db, withBypassContext, withOrg, withOrgTransaction } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const wip = await import('./wip-billing')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
        type Fixture = { org: Awaited<ReturnType<typeof createScratchOrg>>; actor: string; approver: string; project: string; prebill: string; entry: string }

        async function fixture(account: 'missing' | 'revenue' | 'invAsset', run: (f: Fixture) => Promise<void>) {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const actors = await seedFlowActors(org.orgId)
              const profile = BUILTIN_PROJECT_TYPES.find((type) => type.key === 'time_and_materials')!
              const typeId = randomUUID(), project = randomUUID(), employee = randomUUID(), entry = randomUUID()
              const accountId = account === 'missing' ? null : org.accounts[account]
              await db.execute(sql`update items set income_account_id=${accountId} where org_id=${org.orgId} and id=${org.items.service}`)
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values(${typeId},${org.orgId},'wip_account_policy','WIP account policy','time_and_materials',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values(${org.orgId},${typeId},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch WIP account policy')`)
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
                values(${project},${org.orgId},${org.subsidiaryId},'WAC','WIP account job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
              await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
                values(${employee},${org.orgId},'employee','WIP worker',${org.subsidiaryId})`)
              await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
                values(${entry},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.1234','CAD')`)
              const prebill = await wip.createPrebill(org.orgId, actors.adminId, { projectId: project, periodEnd: org.date })
              assert.equal(prebill.sourceCount, 1)
              await wip.transitionPrebill(org.orgId, actors.adminId, prebill.id, 'submit')
              await wip.transitionPrebill(org.orgId, actors.approver1Id, prebill.id, 'approve')
              await run({ org, actor: actors.adminId, approver: actors.approver1Id, project, prebill: prebill.id, entry })
            } finally { await dropScratchOrg(org.orgId) }
          })
        }

        async function snapshot(f: Fixture) {
          return (await db.execute(sql`select
            (select jsonb_agg(to_jsonb(w) order by w.id) from wip_prebills w where w.org_id=${f.org.orgId}) as worksheets,
            (select jsonb_agg(to_jsonb(l) order by l.id) from wip_prebill_lines l where l.org_id=${f.org.orgId}) as source_snapshots,
            (select jsonb_agg(to_jsonb(t) order by t.id) from time_entries t where t.org_id=${f.org.orgId}) as time_sources,
            (select jsonb_agg(to_jsonb(r) order by r.id) from billing_requests r where r.org_id=${f.org.orgId}) as requests,
            (select jsonb_agg(to_jsonb(d) order by d.id) from documents d where d.org_id=${f.org.orgId}) as documents,
            (select jsonb_agg(to_jsonb(l) order by l.id) from document_lines l where l.org_id=${f.org.orgId}) as document_lines,
            (select jsonb_agg(to_jsonb(n) order by n.id) from number_sequences n where n.org_id=${f.org.orgId}) as numbers,
            (select jsonb_agg(to_jsonb(e) order by e.id) from wip_prebill_events e where e.org_id=${f.org.orgId}) as events,
            (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.org_id=${f.org.orgId}) as audit
          `)).rows[0]
        }

        async function refused(f: Fixture, message: RegExp) {
          const before = await snapshot(f)
          await assert.rejects(wip.convertPrebill(f.org.orgId, f.actor, f.prebill), (error: unknown) =>
            error instanceof wip.WipBillingError && message.test(error.message) && /void this prebill.*new prebill for approval/.test(error.message))
          assert.deepEqual(await snapshot(f), before, 'refusal preserves source, numbering, invoice, requests, and audit evidence')
        }

        async function convertedWith(f: Fixture, accountId: string) {
          const converted = await wip.convertPrebill(f.org.orgId, f.actor, f.prebill)
          assert.equal(converted.idempotent, false)
          const lines = (await db.execute(sql`select id, account_id, amount::text, time_entry_id from document_lines
            where org_id=${f.org.orgId} and document_id=${converted.id} order by line_number`)).rows
          assert.equal(lines.length, 1)
          assert.equal(lines[0]!.account_id, accountId)
          assert.equal(lines[0]!.amount, '200.2500')
          assert.equal(lines[0]!.time_entry_id, f.entry)
          assert.deepEqual((await db.execute(sql`select billing_status, invoiced_by_line_id from time_entries
            where org_id=${f.org.orgId} and id=${f.entry}`)).rows[0], { billing_status: 'billed', invoiced_by_line_id: lines[0]!.id })
          const beforeRetry = await snapshot(f)
          assert.deepEqual(await wip.convertPrebill(f.org.orgId, f.actor, f.prebill), { id: converted.id, documentNumber: converted.documentNumber, idempotent: true })
          assert.deepEqual(await snapshot(f), beforeRetry)
        }

        test('WIP conversion refuses missing frozen account despite available chart revenue without writes', enabled, async () => fixture('missing', async (f) => {
          await refused(f, /line 1 has no configured income account/)
          await withBypassContext(() => (db.execute(sql`update items set income_account_id=${f.org.accounts.revenue} where org_id=${f.org.orgId} and id=${f.org.items.service}`)))
          await wip.transitionPrebill(f.org.orgId, f.actor, f.prebill, 'void', 'Correct source accounting configuration')
          const replacement = await wip.createPrebill(f.org.orgId, f.actor, { projectId: f.project, periodEnd: f.org.date })
          await wip.transitionPrebill(f.org.orgId, f.actor, replacement.id, 'submit')
          await wip.transitionPrebill(f.org.orgId, f.approver, replacement.id, 'approve')
          await convertedWith({ ...f, prebill: replacement.id }, f.org.accounts.revenue)
        }))

        for (const kind of ['inactive', 'summary'] as const) {
          test(`WIP conversion refuses ${kind} frozen account without writes`, enabled, async () => fixture('revenue', async (f) => {
            if (kind === 'inactive') await withBypassContext(() => (db.execute(sql`update accounts set is_active=false where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`)))
            else await withBypassContext(() => (db.execute(sql`update accounts set is_summary=true where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`)))
            await refused(f, /line 1 requires an active, non-summary account in this organization/)
          }))
        }

        test('WIP conversion refuses a foreign organization account snapshot without writes', enabled, async () => fixture('revenue', async (f) => {
          const other = await withBypassContext(() => (createScratchOrg()))
          try {
            // Defer the existing FK inside this fixture transaction so the service's
            // independent tenant check is exercised before restoring the valid source.
            await withOrgTransaction(f.org.orgId, async () => {
              await db.execute(sql`set constraints wip_prebill_line_income_org_fk deferred`)
              await withOrg(f.org.orgId, () => db.execute(sql`update wip_prebill_lines set income_account_id=${other.accounts.revenue} where org_id=${f.org.orgId} and prebill_id=${f.prebill}`))
              await refused(f, /line 1 requires an active, non-summary account in this organization/)
              await withOrg(f.org.orgId, () => db.execute(sql`update wip_prebill_lines set income_account_id=${f.org.accounts.revenue} where org_id=${f.org.orgId} and prebill_id=${f.prebill}`))
            })
          } finally { await dropScratchOrg(other.orgId) }
        }))

        test('WIP conversion preserves approved account when source item policy changes and retries idempotently', enabled, async () => fixture('revenue', async (f) => {
          await withBypassContext(() => (db.execute(sql`update items set income_account_id=${f.org.accounts.recognized} where org_id=${f.org.orgId} and id=${f.org.items.service}`)))
          await convertedWith(f, f.org.accounts.revenue)
        }))

        test('WIP conversion preserves explicit non-income account policy', enabled, async () => fixture('invAsset', async (f) => {
          await convertedWith(f, f.org.accounts.invAsset)
        }))
  } },
  { label: "wip billing feature gate", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { createPrebill, WipBillingError } = await import('./wip-billing')

        test('WIP service refuses direct creation when WIP Billing is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = (await seedFlowActors(org.orgId)).adminId
              const profile = BUILTIN_PROJECT_TYPES.find((type) => type.key === 'time_and_materials')!
              const typeId = randomUUID()
              const projectId = randomUUID()
              const employeeId = randomUUID()
              const timeEntryId = randomUUID()
              await db.execute(sql`
                insert into project_types(id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
                values (${typeId}, ${org.orgId}, 'wip_gate', 'WIP gate', 'time_and_materials',
                        ${JSON.stringify(profile.invoicingProfile)}::jsonb, ${JSON.stringify(profile.backupProfile)}::jsonb)
              `)
              await db.execute(sql`
                insert into project_financial_profile_versions(org_id, project_type_id, effective_from, financial_profile, reason)
                values (${org.orgId}, ${typeId}, '2000-01-01', ${JSON.stringify(profile.financialProfile)}::jsonb, 'WIP gate test')
              `)
              await db.execute(sql`
                insert into projects(id, org_id, subsidiary_id, code, name, customer_id, project_type_id, status, is_active, custom)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'WIP-GATE', 'WIP gate project', ${org.customerId}, ${typeId}, 'active', true, '{}'::jsonb)
              `)
              await db.execute(sql`
                insert into parties(id, org_id, kind, display_name, subsidiary_id)
                values (${employeeId}, ${org.orgId}, 'employee', 'WIP gate worker', ${org.subsidiaryId})
              `)
              await db.execute(sql`
                insert into time_entries(id, org_id, employee_party_id, worked_on, hours, project_id, item_id,
                                         is_billable, status, bill_rate, bill_rate_currency)
                values (${timeEntryId}, ${org.orgId}, ${employeeId}, ${org.date}, '2.0000', ${projectId}, ${org.items.service},
                        true, 'approved', '100.0000', 'CAD')
              `)

              await assert.rejects(
                createPrebill(org.orgId, actor, { projectId, periodEnd: org.date }),
                (error: unknown) => error instanceof WipBillingError && error.status === 404 && /wip billing feature is disabled/i.test(error.message),
              )
              assert.equal(
                (await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n,
                0,
              )
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();

const wipNtePolicyCases = [{ label: "wip-nte-policy-switch", register: async () => {
const assert = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const { registerHooks } = await import("node:module");
const test = (await import("node:test")).default;
type SessionUser = import("./auth").SessionUser;
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __wipNteSwitchSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__wipNteSwitchSession.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const wip = await import('./wip-billing')
const headerRoute = await import('../app/api/projects/[id]/route')
const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * The NTE cap must follow the CURRENT policy, not just the creation-time
 * snapshot. A worksheet priced under an open policy, approved, then carried
 * into a not-to-exceed policy by a project-type switch must face the ceiling
 * at conversion — otherwise the switch silently drops the cap the sibling
 * billing path still enforces.
 */
test('converting after a switch to NTE enforces the new ceiling', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const preparer = (await seedFlowActors(org.orgId)).adminId
      const approver = await createScratchUser(org.orgId, 'Billing approver', 'admin')
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key in ('admin','reviewer')`)
      session.user = { id: preparer, orgId: org.orgId, name: 'Preparer', email: 'prep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: preparer }
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const nte = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'not_to_exceed')!
      const tmType = randomUUID(), nteType = randomUUID(), project = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${tmType},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${nteType},${org.orgId},'not_to_exceed','Not-to-Exceed','time_and_materials',${JSON.stringify(nte.invoicingProfile)}::jsonb,${JSON.stringify(nte.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${tmType},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'nte switch fixture'),
              (${org.orgId},${nteType},'2000-01-01',${JSON.stringify(nte.financialProfile)}::jsonb,'nte switch fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'NTE-SW','NTE switch job',${org.customerId},${tmType},'100.0000','active',true,'{}'::jsonb)`)
      const employee = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values (${employee},${org.orgId},'employee','Switch Hand',${org.subsidiaryId},true,'{}'::jsonb)`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,bill_rate,project_id,item_id)
        values (${entry},${org.orgId},${employee},${org.date},'8','approved',true,'unbilled','100',${project},${org.items.service})`)
      // The ceiling is already fully claimed by a prior draft invoice.
      const doc = randomUUID(), line = randomUUID()
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,currency,status,subtotal,tax_total,total)
        values (${doc},${org.orgId},'customer_invoice',${'INV-'+doc},${org.customerId},${org.subsidiaryId},${project},${org.date},'CAD','draft','100','0','100')`)
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,is_billable,project_id)
        values (${line},${org.orgId},${doc},1,${org.accounts.revenue},'Billed',1,'100','100',true,${project})`)

      // Priced and approved under the open policy, where no cap applies.
      const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null)
      await wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, null)
      await wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, null)

      // The job moves under the NTE policy with zero remaining capacity.
      const switched = await withOrgContext(org.orgId, () => headerRoute.PATCH(
        new Request('http://audit.local/api', { method: 'PATCH', body: JSON.stringify({ projectTypeId: nteType }) }),
        { params: Promise.resolve({ id: project }) },
      ))
      assert.equal(switched.status, 200)

      const invoicesBefore = (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n
      await assert.rejects(
        wip.convertPrebill(org.orgId, approver, prebill.id, null),
        /remaining not-to-exceed capacity/,
      )
      const invoicesAfter = (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n
      assert.equal(invoicesAfter, invoicesBefore)
    } finally { session.user = null; await dropScratchOrg(org.orgId) }
  })
})

const consolidatedRows = [
  { label: "wip nte zero contract", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const wip = await import('./wip-billing')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

        /**
         * An NTE job whose contract ceiling was never entered has an UNKNOWN cap, not
         * a zero cap. Billing-request invoicing and Financials both read it that way
         * (no ceiling ⇒ no cap); WIP prebilling must agree instead of refusing every
         * worksheet while a real ceiling blocks nothing elsewhere. A consumed ceiling
         * still blocks.
         */
        test('NTE prebilling treats an unset contract ceiling as no cap', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const preparer = (await seedFlowActors(org.orgId)).adminId
              const nte = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'not_to_exceed')!
              const typeId = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'not_to_exceed','Not-to-Exceed','time_and_materials',${JSON.stringify(nte.invoicingProfile)}::jsonb,${JSON.stringify(nte.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(nte.financialProfile)}::jsonb,'nte cap fixture')`)
              const employee = randomUUID()
              await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
                values (${employee},${org.orgId},'employee','Cap Hand',${org.subsidiaryId},true,'{}'::jsonb)`)
              const setup = async (code: string, contractValue: string | null) => {
                const project = randomUUID(), entry = randomUUID()
                await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
                  values (${project},${org.orgId},${org.subsidiaryId},${code},${code},${org.customerId},${typeId},${contractValue},'active',true,'{}'::jsonb)`)
                await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,bill_rate,project_id)
                  values (${entry},${org.orgId},${employee},${org.date},'8','approved',true,'unbilled','100',${project})`)
                return project
              }

              // No ceiling entered: the unbilled time prebills like any uncapped job.
              const open = await setup('NTE-OPEN', null)
              const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: open, periodEnd: org.date }, null)
              assert.ok(prebill.id)
              assert.equal(prebill.sourceCount, 1)

              // A consumed ceiling still blocks: 100 of contract, 100 already invoiced.
              const capped = await setup('NTE-CAPPED', '100.0000')
              const doc = randomUUID(), line = randomUUID()
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,currency,status,subtotal,tax_total,total)
                values (${doc},${org.orgId},'customer_invoice',${'INV-'+doc},${org.customerId},${org.subsidiaryId},${capped},${org.date},'CAD','draft','100','0','100')`)
              await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,is_billable,project_id)
                values (${line},${org.orgId},${doc},1,${org.accounts.revenue},'Billed',1,'100','100',true,${capped})`)
              await assert.rejects(
                wip.createPrebill(org.orgId, preparer, { projectId: capped, periodEnd: org.date }, null),
                /not-to-exceed contract cap/,
              )
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
}}] as const; for (const row of wipNtePolicyCases) await row.register();
