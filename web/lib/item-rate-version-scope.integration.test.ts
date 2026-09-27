import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { resolveItemRate, snapshotTimeBillRates } = await import('./item-rates')
const { resolveRateAdjustments } = await import('./rate-adjustments')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/** Rate cards honor work dimensions and preserve one agreement across pricing and surcharges. */
test('version scopes gate rate resolution, not just surcharges', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const deptParent = randomUUID(), deptA = randomUUID(), deptB = randomUUID()
      await db.execute(sql`insert into departments (id, org_id, name, is_active) values (${deptParent}, ${org.orgId}, 'Scoped parent', true)`)
      await db.execute(sql`insert into departments (id, org_id, parent_id, name, is_active) values (${deptA}, ${org.orgId}, ${deptParent}, 'Scoped child', true)`)
      await db.execute(sql`insert into departments (id, org_id, name, is_active) values (${deptB}, ${org.orgId}, 'Other', true)`)
      const employee = randomUUID(), project = randomUUID(), book = randomUUID(), version = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employee}, ${org.orgId}, 'employee', 'Scoped worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`update items set default_rate = '50.0000' where id = ${org.items.service} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', true)`)
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'SCOPED', 'Scoped rates job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${book}, ${org.orgId}, 'SCOPED-RATES', 'Scoped rates book', 'CAD', false, true)`)
      await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
        values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft', '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
        values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 100, 200)`)
      await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id, include_children)
        values (${org.orgId}, ${version}, 'department', ${deptParent}, true)`)
      await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
        values (${org.orgId}, ${book}, 'usage_date', true)`)
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, item_id, project_id,
                              department_id, status, is_billable, billing_status, custom, created_by, updated_by)
        values (${entry}, ${org.orgId}, ${employee}, ${org.date}, '2.0000', ${org.items.service}, ${project},
                ${deptB}, 'approved', true, 'unbilled', '{}'::jsonb, ${org.orgId}, ${org.orgId})`)

      const scoped = await resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, departmentId: deptA, baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date })
      assert.equal(scoped?.bill.amount, '200.0000')
      assert.equal(await resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, departmentId: deptB, baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date }), null)
      assert.equal((await snapshotTimeBillRates(org.orgId, [entry], { dryRun: true })).get(entry), '50.0000')
      const subsidiaryB = randomUUID(), unit = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${subsidiaryB},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
      await db.execute(sql`insert into equipment_units(id,org_id,subsidiary_id,unit_number,name,status,purchase_price) values (${unit},${org.orgId},${subsidiaryB},'B-UNIT','B unit','draft','100.0000')`)
      await assert.rejects(resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, equipmentUnitId: unit, allowedSubsidiaryIds: new Set([org.subsidiaryId, subsidiaryB]), baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date }), /not found/)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

test('project assignments keep scoped item rates aligned with surcharges', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const deptA = randomUUID(), deptB = randomUUID()
      for (const [id, name] of [[deptA, 'Project scoped'], [deptB, 'Other project dept']] as const) {
        await db.execute(sql`insert into departments (id, org_id, name, is_active) values (${id}, ${org.orgId}, ${name}, true)`)
      }
      const employee = randomUUID(), project = randomUUID(), book = randomUUID(), version = randomUUID(), entry = randomUUID(), adjustment = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employee}, ${org.orgId}, 'employee', 'Project scoped worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`update items set default_rate = '50.0000' where id = ${org.items.service} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', true)`)
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'PROJECT-SCOPED', 'Project-scoped rates job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${book}, ${org.orgId}, 'PROJECT-SCOPED-RATES', 'Project-scoped rates book', 'CAD', false, true)`)
      await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
        values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft', '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
        values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 100, 200)`)
      await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id, include_children)
        values (${org.orgId}, ${version}, 'department', ${deptA}, true)`)
      await db.execute(sql`insert into labor_rate_adjustments (id, org_id, version_id, code, name, category, calculation, value, presentation)
        values (${adjustment}, ${org.orgId}, ${version}, 'PROJECT-FUEL', 'Project fuel', 'surcharge', 'percent', 10, 'separate')`)
      await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, rate_version_id, project_id, date_basis, is_active)
        values (${org.orgId}, ${book}, ${version}, ${project}, 'usage_date', true)`)
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, item_id, project_id,
                              department_id, status, is_billable, billing_status, custom, created_by, updated_by)
        values (${entry}, ${org.orgId}, ${employee}, ${org.date}, '2.0000', ${org.items.service}, ${project},
                ${deptB}, 'approved', true, 'unbilled', '{}'::jsonb, ${org.orgId}, ${org.orgId})`)

      // A project assignment is an explicit card selection. The surcharge
      // resolver deliberately lets it override the version's narrower scope;
      // item-rate and snapshot resolution must make the same choice.
      const itemRate = await resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, departmentId: deptB, baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date })
      const adjustments = await resolveRateAdjustments({ orgId: org.orgId, projectId: project, departmentId: deptB, onDate: org.date })
      assert.equal(adjustments.length, 1)
      assert.equal(itemRate?.bill.amount, '200.0000')
      assert.equal((await snapshotTimeBillRates(org.orgId, [entry], { dryRun: true })).get(entry), '200.0000')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})


const consolidatedRows = [
  { label: "item rate fx refusal", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { resolveItemRate } = await import('./item-rates')
        
        const DB = !!process.env.OPENBOOKS_DB_URL
        
        /**
         * A selected rate card without FX coverage must refuse — never fall through
         * to a lower-priority card. Project EUR card + default CAD card, no
         * EUR→CAD spot: the old resolver billed the CAD card and reported success.
         */
        test('missing FX on the selected card refuses instead of billing a lower card', { skip: !DB }, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const project = randomUUID()
              const eurBook = randomUUID(), eurVersion = randomUUID()
              const cadBook = randomUUID(), cadVersion = randomUUID()
              await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
                values (${org.orgId}, ${org.items.service}, 'hour', true)`)
              await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'FXJOB', 'FX job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
              await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
                values (${eurBook}, ${org.orgId}, 'EUR-CARD', 'Project euro card', 'EUR', false, true),
                       (${cadBook}, ${org.orgId}, 'CAD-DEFAULT', 'Default card', 'CAD', true, true)`)
              await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
                values (${eurVersion}, ${org.orgId}, ${eurBook}, '2020-01-01', 'draft', '{}'::jsonb),
                       (${cadVersion}, ${org.orgId}, ${cadBook}, '2020-01-01', 'draft', '{}'::jsonb)`)
              await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
                values (${org.orgId}, ${eurVersion}, ${org.items.service}, 'hour', 'Hour', 1, 100, 200),
                       (${org.orgId}, ${cadVersion}, ${org.items.service}, 'hour', 'Hour', 1, 10, 20)`)
              await db.execute(sql`update item_rate_versions set status = 'active'
                where id = any(${`{${eurVersion},${cadVersion}}`}::uuid[]) and org_id = ${org.orgId}`)
              await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, rate_version_id, project_id, date_basis, is_active)
                values (${org.orgId}, ${eurBook}, ${eurVersion}, ${project}, 'usage_date', true)`)
        
              await assert.rejects(
                () => resolveItemRate({
                  orgId: org.orgId, projectId: project, itemId: org.items.service,
                  baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date,
                }),
                /No spot rate for EUR→CAD on or before 2026-07-15/,
              )
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * Absence of an item/version still falls through: a project card that does
         * not cover the item bills the default card (same currency, no FX needed).
         */
        test('a card without the item still falls through to the default card', { skip: !DB }, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const project = randomUUID()
              const cadBook = randomUUID(), cadVersion = randomUUID()
              const defaultBook = randomUUID(), defaultVersion = randomUUID()
              await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
                values (${org.orgId}, ${org.items.service}, 'hour', true)`)
              await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'FALLJOB', 'Fall-through job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
              await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
                values (${cadBook}, ${org.orgId}, 'CAD-PROJECT', 'Project card', 'CAD', false, true),
                       (${defaultBook}, ${org.orgId}, 'CAD-DEFAULT', 'Default card', 'CAD', true, true)`)
              // The project card covers the date but carries no line for the item.
              await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
                values (${cadVersion}, ${org.orgId}, ${cadBook}, '2020-01-01', 'draft', '{}'::jsonb),
                       (${defaultVersion}, ${org.orgId}, ${defaultBook}, '2020-01-01', 'draft', '{}'::jsonb)`)
              await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
                values (${org.orgId}, ${defaultVersion}, ${org.items.service}, 'hour', 'Hour', 1, 10, 20)`)
              await db.execute(sql`update item_rate_versions set status = 'active'
                where id = any(${`{${cadVersion},${defaultVersion}}`}::uuid[]) and org_id = ${org.orgId}`)
              await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, rate_version_id, project_id, date_basis, is_active)
                values (${org.orgId}, ${cadBook}, ${cadVersion}, ${project}, 'usage_date', true)`)
        
              const resolved = await resolveItemRate({
                orgId: org.orgId, projectId: project, itemId: org.items.service,
                baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date,
              })
              assert.equal(resolved?.bill.amount, '20.0000')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
  { label: "item rate legacy provenance", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { resolveItemRate } = await import('./item-rates')
        
        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
        
        /**
         * U9: a January version priced under capped_ladder, whose profile changed to
         * lowest_cost in February before the upgrade, gets pinned lowest_cost by the
         * 0298 backfill — so a late January entry after the upgrade would use
         * February's policy while the version looks historically authoritative.
         *
         * The backfilled pin is legacy (0326): retrospective pricing still prices
         * (field work must bill), but the resolution carries an explicit 'inferred'
         * provenance the UI shows, instead of presenting February's policy as
         * January's record. Writer pins stay 'pinned'; versions without a pin read
         * the live profile as 'live'.
         */
        test('a late entry on a legacy pin prices on with inferred provenance', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const project = randomUUID(), book = randomUUID()
              const vJan = randomUUID(), vFeb = randomUUID(), vMar = randomUUID()
              await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'LEGACY-PIN', 'Legacy pin job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
              await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
                values (${book}, ${org.orgId}, 'LEGACY-PIN', 'Legacy pin book', 'CAD', false, true)`)
              await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
                values (${org.orgId}, ${book}, 'usage_date', true)`)
              // The live profile carries February's policy (the edit before upgrade).
              await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, pricing_policy, invoice_presentation, is_active)
                values (${org.orgId}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components', true)`)
              for (const [version, from, to] of [[vJan, '2026-01-01', '2026-01-31'], [vFeb, '2026-02-01', '2026-02-28'], [vMar, '2026-03-01', null]] as const) {
                await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, effective_to, status, custom)
                  values (${version}, ${org.orgId}, ${book}, ${from}, ${to}, 'draft', '{}'::jsonb)`)
                await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
                  values (${org.orgId}, ${version}, ${org.items.service}, 'one', 'One', 1, 10, 10),
                         (${org.orgId}, ${version}, ${org.items.service}, 'four', 'Four', 4, 30, 30),
                         (${org.orgId}, ${version}, ${org.items.service}, 'six', 'Six', 6, 50, 50)`)
              }
              await db.execute(sql`update item_rate_versions set status = 'active' where org_id = ${org.orgId} and rate_book_id = ${book}`)
              // January's pin holds January's policy; February's holds February's.
              // March has no pin (a labor-style version resolving live).
              const janPin = randomUUID()
              await db.execute(sql`insert into item_rate_version_profiles (id, org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation)
                values (${janPin}, ${org.orgId}, ${vJan}, ${org.items.service}, 'day', 'capped_ladder', 'summary'),
                       (${randomUUID()}, ${org.orgId}, ${vFeb}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components')`)
              // The upgrade marks January's pin: the backfill copied the live
              // profile, so its capped_ladder value is inferred, not recorded.
              await db.execute(sql`insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
                values (${org.orgId}, '0298_item_rate_version_profile_pins', 'item_rate_version_profiles', ${janPin}, 'test mark')`)
        
              const base = { orgId: org.orgId, projectId: project, itemId: org.items.service, baseQuantity: '8' } as const
              const january = await resolveItemRate({ ...base, onDate: '2026-01-15' })
              assert.equal(january?.bill.amount, '70.0000')
              assert.equal(january?.policy, 'capped_ladder')
              assert.equal(january?.policyProvenance, 'inferred')
        
              const february = await resolveItemRate({ ...base, onDate: '2026-02-15' })
              assert.equal(february?.bill.amount, '60.0000')
              assert.equal(february?.policy, 'lowest_cost')
              assert.equal(february?.policyProvenance, 'pinned')
        
              const march = await resolveItemRate({ ...base, onDate: '2026-03-15' })
              assert.equal(march?.policy, 'lowest_cost')
              assert.equal(march?.policyProvenance, 'live')
            } finally {
              await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`)
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
  { label: "item rate location scope", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { resolveItemRate } = await import('./item-rates.ts')
        const { resolveRateAdjustments, findLapsedRateCard } = await import('./rate-adjustments.ts')
        
        test('item rates honor location-scoped version cards', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await createScratchOrg()
          try {
            const location = randomUUID()
            const project = randomUUID()
            const book = randomUUID()
            const version = randomUUID()
            await db.execute(sql`insert into locations (id, org_id, name, is_active) values (${location}, ${org.orgId}, 'Field location', true)`)
            await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
              values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'LOC-RATE', 'Location rate project', ${org.customerId}, 'active', true)`)
            await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
              values (${org.orgId}, ${org.items.service}, 'hour', true)`)
            await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_active)
              values (${book}, ${org.orgId}, 'LOCATION-RATES', 'Location rates', 'CAD', true)`)
            await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status)
              values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft')`)
            await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
              values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 40, 140)`)
            await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id)
              values (${org.orgId}, ${version}, 'location', ${location})`)
            await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
            await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, location_id, date_basis, is_active)
              values (${org.orgId}, ${book}, ${location}, 'usage_date', true)`)
        
            const resolved = await resolveItemRate({
              orgId: org.orgId,
              projectId: project,
              itemId: org.items.service,
              locationId: location,
              onDate: org.date,
              baseQuantity: '1',
              rateUnitCode: 'hour',
            })
            assert.equal(resolved?.bill.amount, '140.0000')
          } finally { await dropScratchOrg(org.orgId) }
        })
        
        test('child locations inherit version-scoped rates and adjustments when enabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await createScratchOrg()
          try {
            const parent = randomUUID(), child = randomUUID()
            await db.execute(sql`insert into locations (id, org_id, name, is_active) values (${parent}, ${org.orgId}, 'Region', true)`)
            await db.execute(sql`insert into locations (id, org_id, parent_id, name, is_active) values (${child}, ${org.orgId}, ${parent}, 'Site', true)`)
            const project = randomUUID(), book = randomUUID(), version = randomUUID()
            await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
              values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'LOC-CHILD', 'Child location project', ${org.customerId}, 'active', true)`)
            await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
              values (${org.orgId}, ${org.items.service}, 'hour', true)`)
            await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_active)
              values (${book}, ${org.orgId}, 'LOCATION-CHILD-RATES', 'Child location rates', 'CAD', true)`)
            await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status)
              values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft')`)
            await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
              values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 45, 145)`)
            await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id, include_children)
              values (${org.orgId}, ${version}, 'location', ${parent}, true)`)
            await db.execute(sql`insert into labor_rate_adjustments (org_id, version_id, code, name, category, calculation, value, presentation)
              values (${org.orgId}, ${version}, 'SITE', 'Site premium', 'surcharge', 'percent', 5, 'separate')`)
            await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
            await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
              values (${org.orgId}, ${book}, 'usage_date', true)`)
        
            const resolved = await resolveItemRate({
              orgId: org.orgId, projectId: project, itemId: org.items.service,
              locationId: child, onDate: org.date, baseQuantity: '1', rateUnitCode: 'hour',
            })
            assert.equal(resolved?.bill.amount, '145.0000')
            const adjustments = await resolveRateAdjustments({ orgId: org.orgId, projectId: project, locationId: child, onDate: org.date })
            assert.deepEqual(adjustments.map((row) => ({ code: row.code, value: row.value })), [{ code: 'SITE', value: '5.0000000000' }])
            assert.equal(await findLapsedRateCard({ orgId: org.orgId, projectId: project, onDate: org.date }), null)
          } finally { await dropScratchOrg(org.orgId) }
        })
  } },
  { label: "item rate version pinning", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { resolveItemRate } = await import('./item-rates')
        
        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
        
        /**
         * PRC1: the pricing policy is current state, but rate lines are
         * effective-dated. Switching the policy for next month must not reprice a
         * late entry dated in the old month: resolution reads the SELECTED version's
         * pinned policy, base unit and presentation — never the live profile.
         *
         * Tiers 1/$10, 4/$30, 6/$50 price 8 units at $70 under capped_ladder and at
         * $60 (two 4-packs) under lowest_cost. The profile holds the NEW policy
         * (lowest_cost); the January version pins the OLD one (capped_ladder).
         */
        test('a late entry in the old month prices under the old pinned policy', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const project = randomUUID(), book = randomUUID(), v1 = randomUUID(), v2 = randomUUID()
              await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'PINNED', 'Pinned policy job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
              await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
                values (${book}, ${org.orgId}, 'PINNED-RATES', 'Pinned rates book', 'CAD', false, true)`)
              await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
                values (${org.orgId}, ${book}, 'usage_date', true)`)
              // The live profile already carries the NEW month's policy.
              await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, pricing_policy, invoice_presentation, is_active)
                values (${org.orgId}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components', true)`)
              for (const [version, from, to] of [[v1, '2026-01-01', '2026-01-31'], [v2, '2026-02-01', null]] as const) {
                await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, effective_to, status, custom)
                  values (${version}, ${org.orgId}, ${book}, ${from}, ${to}, 'draft', '{}'::jsonb)`)
                await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
                  values (${org.orgId}, ${version}, ${org.items.service}, 'one', 'One', 1, 10, 10),
                         (${org.orgId}, ${version}, ${org.items.service}, 'four', 'Four', 4, 30, 30),
                         (${org.orgId}, ${version}, ${org.items.service}, 'six', 'Six', 6, 50, 50)`)
              }
              // Each version pins what was in force when it was saved.
              await db.execute(sql`insert into item_rate_version_profiles (org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation)
                values (${org.orgId}, ${v1}, ${org.items.service}, 'day', 'capped_ladder', 'summary'),
                       (${org.orgId}, ${v2}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components')`)
              await db.execute(sql`update item_rate_versions set status = 'active' where org_id = ${org.orgId} and rate_book_id = ${book}`)
        
              const january = await resolveItemRate({
                orgId: org.orgId, projectId: project, itemId: org.items.service,
                onDate: '2026-01-15', baseQuantity: '8',
              })
              assert.equal(january?.bill.amount, '70.0000')
              assert.equal(january?.policy, 'capped_ladder')
              assert.equal(january?.baseUnit, 'day')
              assert.equal(january?.invoicePresentation, 'summary')
        
              const february = await resolveItemRate({
                orgId: org.orgId, projectId: project, itemId: org.items.service,
                onDate: '2026-02-15', baseQuantity: '8',
              })
              assert.equal(february?.bill.amount, '60.0000')
              assert.equal(february?.policy, 'lowest_cost')
              assert.equal(february?.baseUnit, 'hour')
              assert.equal(february?.invoicePresentation, 'rate_components')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();


const itemPricingAsOfRows = [
  { label: "item pricing asof", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { resolveItemPrice } = await import('./item-pricing')
        
        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
        
        /**
         * PRC15: Gold is assigned January 1 with a January Gold price of $100; the
         * admin deactivates the Gold assignment in March. A legitimate late January
         * 15 transaction must still price at the Gold price in force that day —
         * membership is the effective-dated window, never current activation — while
         * current dates price off the live hierarchy.
         */
        test('a late January entry prices Gold after the assignment is deactivated', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const customerId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
                values (${org.orgId}, ${customerId}, true)`)
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD', 'Gold price', 'explicit', false, true)`)
              const baseId = (await db.execute<{ id: string }>(sql`
                select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
              await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
                values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', true)`)
              const goldSchedule = randomUUID()
              const baseSchedule = randomUUID()
              await db.execute(sql`insert into item_price_schedules
                  (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
                values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', '2026-01-31', true),
                       (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
              for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
                await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
                  values (${org.orgId}, ${schedule}, '1', ${price})`)
              }
        
              const input = {
                orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
              } as const
              const january = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
              assert.equal(january?.unitPrice, '100.0000')
              assert.equal(january?.source, 'customer_level')
        
              // March: the admin deactivates the Gold assignment. End-dated
              // membership keeps January covered instead of flipping a flag.
              await db.execute(sql`update customer_price_level_assignments set is_active = false
               where org_id = ${org.orgId} and customer_id = ${customerId}`)
              const membership = (await db.execute<{ is_active: boolean; effective_to: string | null }>(sql`
                select is_active, effective_to::text as effective_to from customer_price_level_assignments
                 where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!
              assert.equal(membership.is_active, false)
              assert.ok(membership.effective_to !== null && membership.effective_to < '2026-01-15' === false,
                `deactivation must end-date, not erase, the window (got ${membership.effective_to})`)
        
              const late = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
              assert.equal(late?.unitPrice, '100.0000')
              assert.equal(late?.source, 'customer_level')
        
              // Current dates follow the live hierarchy: no Gold membership, so the
              // base price — never a resurrected assignment.
              const today = new Date().toISOString().slice(0, 10)
              const now = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(now?.unitPrice, '80.0000')
              assert.equal(now?.source, 'base_level')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * PRC15b: the customer's assignment stays effective but the LEVEL is
         * deactivated, so no joined level row survives the activation predicate and
         * the Gold price must not win for dates when Gold is dark — the base price
         * applies instead, while dates inside the level's active window still read
         * Gold. Fixture shape is pre-0244 legacy (the level guard refuses new
         * writes of this shape, so it is disabled for the single statement that
         * builds the legacy row, then re-enabled): an effective assignment plus an
         * active schedule on a dead level.
         */
        test('a deactivated level stops pricing while the assignment stays effective', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const customerId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
                values (${org.orgId}, ${customerId}, true)`)
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD3', 'Gold price', 'explicit', false, true)`)
              const baseId = (await db.execute<{ id: string }>(sql`
                select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
              await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
                values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', true)`)
              const goldSchedule = randomUUID()
              const baseSchedule = randomUUID()
              await db.execute(sql`insert into item_price_schedules
                  (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
                values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
                       (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
              for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
                await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
                  values (${org.orgId}, ${schedule}, '1', ${price})`)
              }
        
              const input = {
                orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
              } as const
              const january = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
              assert.equal(january?.unitPrice, '100.0000')
              assert.equal(january?.source, 'customer_level')
        
              // Legacy shape: the level dies while the assignment and its schedule
              // stay live. The guard is re-enabled immediately afterwards.
              await db.execute(sql`alter table price_levels disable trigger price_level_base_guard`)
              try {
                await db.execute(sql`update price_levels set is_active = false where org_id = ${org.orgId} and id = ${goldId}`)
              } finally {
                await db.execute(sql`alter table price_levels enable trigger price_level_base_guard`)
              }
              const assignment = (await db.execute<{ is_active: boolean; effective_to: string | null }>(sql`
                select is_active, effective_to::text as effective_to from customer_price_level_assignments
                 where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!
              assert.equal(assignment.is_active, true)
              assert.equal(assignment.effective_to, null)
        
              // Today the level is dark: the base price, never the dead Gold price.
              const today = new Date().toISOString().slice(0, 10)
              const now = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(now?.unitPrice, '80.0000')
              assert.equal(now?.source, 'base_level')
        
              // History preserved: January was inside the level's active window.
              const late = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
              assert.equal(late?.unitPrice, '100.0000')
              assert.equal(late?.source, 'customer_level')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * PRC15b historical window: the level died and was later reactivated, so a
         * past date in the dark gap prices base while dates on either side of the
         * gap still read the Gold price that was offered then.
         */
        test('a historical inactive gap prices base while both active windows price Gold', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const customerId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
                values (${org.orgId}, ${customerId}, true)`)
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD4', 'Gold price', 'explicit', false, true)`)
              const baseId = (await db.execute<{ id: string }>(sql`
                select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
              await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
                values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', true)`)
              const goldSchedule = randomUUID()
              const baseSchedule = randomUUID()
              await db.execute(sql`insert into item_price_schedules
                  (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
                values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
                       (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
              for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
                await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
                  values (${org.orgId}, ${schedule}, '1', ${price})`)
              }
        
              const input = {
                orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
              } as const
              // Legacy deactivation, then a reactivation; the history rows are then
              // shaped into a March-to-June dark gap (the resolver's source of truth
              // for past dates is the history table, however its rows arose).
              await db.execute(sql`alter table price_levels disable trigger price_level_base_guard`)
              try {
                await db.execute(sql`update price_levels set is_active = false where org_id = ${org.orgId} and id = ${goldId}`)
              } finally {
                await db.execute(sql`alter table price_levels enable trigger price_level_base_guard`)
              }
              await db.execute(sql`update price_levels set is_active = true where org_id = ${org.orgId} and id = ${goldId}`)
              await db.execute(sql`update price_level_activation_history set active_to = '2026-03-01'
                where org_id = ${org.orgId} and price_level_id = ${goldId} and active_to is not null`)
              await db.execute(sql`update price_level_activation_history set active_from = '2026-06-01'
                where org_id = ${org.orgId} and price_level_id = ${goldId} and active_to is null`)
        
              const gap = await resolveItemPrice({ ...input, onDate: '2026-04-15' })
              assert.equal(gap?.unitPrice, '80.0000')
              assert.equal(gap?.source, 'base_level')
        
              const before = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
              assert.equal(before?.unitPrice, '100.0000')
              assert.equal(before?.source, 'customer_level')
        
              const today = new Date().toISOString().slice(0, 10)
              const now = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(now?.unitPrice, '100.0000')
              assert.equal(now?.source, 'customer_level')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * RESIDUAL (Sol): revoking an assignment that starts today KEEPS the row and
         * stamps the revoke instant instead of removing it — the assignment may
         * already have priced intraday transactions whose recorded basis points at
         * this row. Lookups at or after the instant fall through to the base price
         * while the live level and schedule stay untouched; lookups predating the
         * instant still resolve what was offered then.
         */
        test('revoking a same-day assignment keeps the row and ends pricing at its instant', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const customerId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
                values (${org.orgId}, ${customerId}, true)`)
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD5', 'Gold price', 'explicit', false, true)`)
              const baseId = (await db.execute<{ id: string }>(sql`
                select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
              const today = new Date().toISOString().slice(0, 10)
              await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
                values (${org.orgId}, ${customerId}, ${goldId}, ${today}, true)`)
              const goldSchedule = randomUUID()
              const baseSchedule = randomUUID()
              await db.execute(sql`insert into item_price_schedules
                  (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
                values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
                       (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
              for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
                await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
                  values (${org.orgId}, ${schedule}, '1', ${price})`)
              }
        
              const input = {
                orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
              } as const
              const before = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(before?.unitPrice, '100.0000')
              assert.equal(before?.source, 'customer_level')
        
              // The mistaken assignment is revoked the day it starts: no error, and
              // the row stays with its revoke instant stamped — priced lineage must
              // survive the revoke.
              await db.execute(sql`update customer_price_level_assignments set is_active = false
               where org_id = ${org.orgId} and customer_id = ${customerId}`)
              const membership = (await db.execute<{ is_active: boolean; revoked_epoch: number | null }>(sql`
                select is_active, extract(epoch from revoked_at)::float8 as revoked_epoch from customer_price_level_assignments
                 where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!
              assert.equal(membership.is_active, false)
              assert.ok(membership.revoked_epoch, 'the revoke instant must be stamped')
              const revokedAt = Math.round(membership.revoked_epoch! * 1000)
              assert.ok(Number.isFinite(revokedAt))
        
              // Level and schedule were never touched.
              const level = (await db.execute<{ is_active: boolean }>(sql`
                select is_active from price_levels where org_id = ${org.orgId} and id = ${goldId}`)).rows[0]!
              assert.equal(level.is_active, true)
        
              // A lookup running now (at or after the revoke) falls to the base.
              const now = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(now?.unitPrice, '80.0000')
              assert.equal(now?.source, 'base_level')
        
              // A lookup as of an instant before the revoke still resolves the Gold
              // that was offered then; at or after it, the base.
              const beforeRevoke = new Date(revokedAt - 3600000).toISOString()
              const offered = await resolveItemPrice({ ...input, onDate: today, asOf: beforeRevoke })
              assert.equal(offered?.unitPrice, '100.0000')
              assert.equal(offered?.source, 'customer_level')
              const afterRevoke = new Date(revokedAt + 1000).toISOString()
              const dark = await resolveItemPrice({ ...input, onDate: today, asOf: afterRevoke })
              assert.equal(dark?.unitPrice, '80.0000')
              assert.equal(dark?.source, 'base_level')
        
              // Re-offering clears the stamp: the row prices again.
              await db.execute(sql`update customer_price_level_assignments set is_active = true
               where org_id = ${org.orgId} and customer_id = ${customerId}`)
              const revived = (await db.execute<{ revoked_at: string | null }>(sql`
                select revoked_at from customer_price_level_assignments
                 where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!
              assert.equal(revived.revoked_at, null)
              const again = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(again?.unitPrice, '100.0000')
              assert.equal(again?.source, 'customer_level')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * PRC15c: revoking an older assignment still end-dates it to yesterday — the
         * row is kept, today prices base, and a late transaction inside the old
         * window still reads the Gold price that was offered then.
         */
        test('revoking an older assignment end-dates it and preserves its history', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const customerId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
                values (${org.orgId}, ${customerId}, true)`)
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD6', 'Gold price', 'explicit', false, true)`)
              const baseId = (await db.execute<{ id: string }>(sql`
                select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
              await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
                values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', true)`)
              const goldSchedule = randomUUID()
              const baseSchedule = randomUUID()
              await db.execute(sql`insert into item_price_schedules
                  (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
                values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
                       (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
              for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
                await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
                  values (${org.orgId}, ${schedule}, '1', ${price})`)
              }
        
              const input = {
                orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
              } as const
              await db.execute(sql`update customer_price_level_assignments set is_active = false
               where org_id = ${org.orgId} and customer_id = ${customerId}`)
              const today = new Date().toISOString().slice(0, 10)
              const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
              const membership = (await db.execute<{ is_active: boolean; effective_to: string | null }>(sql`
                select is_active, effective_to::text as effective_to from customer_price_level_assignments
                 where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!
              assert.equal(membership.is_active, false)
              assert.equal(membership.effective_to, yesterday)
        
              const now = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(now?.unitPrice, '80.0000')
              assert.equal(now?.source, 'base_level')
        
              const late = await resolveItemPrice({ ...input, onDate: '2026-06-15' })
              assert.equal(late?.unitPrice, '100.0000')
              assert.equal(late?.source, 'customer_level')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * PRC15d: revoking a future-effective assignment before it starts removes
         * the never-effective row, so neither today nor the dates it would have
         * covered price off it.
         */
        test('revoking a future assignment removes it and nothing prices off it', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const customerId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
                values (${org.orgId}, ${customerId}, true)`)
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD7', 'Gold price', 'explicit', false, true)`)
              const baseId = (await db.execute<{ id: string }>(sql`
                select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
              const today = new Date().toISOString().slice(0, 10)
              const starts = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10)
              const inside = new Date(Date.parse(`${today}T00:00:00Z`) + 40 * 86400000).toISOString().slice(0, 10)
              await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
                values (${org.orgId}, ${customerId}, ${goldId}, ${starts}, true)`)
              const goldSchedule = randomUUID()
              const baseSchedule = randomUUID()
              await db.execute(sql`insert into item_price_schedules
                  (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
                values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
                       (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
              for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
                await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
                  values (${org.orgId}, ${schedule}, '1', ${price})`)
              }
        
              const input = {
                orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
              } as const
              // Revoked before it ever started: no error, no row left behind.
              const assignmentId = (await db.execute<{ id: string }>(sql`
                select id from customer_price_level_assignments
                 where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!.id
              await db.execute(sql`update customer_price_level_assignments set is_active = false
               where org_id = ${org.orgId} and customer_id = ${customerId}`)
              const remaining = (await db.execute<{ n: number }>(sql`
                select count(*)::int as n from customer_price_level_assignments
                 where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!.n
              assert.equal(remaining, 0)
        
              // The removal is audited with the row's before-image, never silent.
              const audits = (await db.execute<{ action: string; before_customer: string | null }>(sql`
                select action, changes->'before'->>'customer_id' as before_customer from audit_log
                 where org_id = ${org.orgId} and table_name = 'customer_price_level_assignments'
                   and row_id = ${assignmentId}`)).rows
              assert.equal(audits.length, 1)
              assert.equal(audits[0]!.action, 'delete')
              assert.equal(audits[0]!.before_customer, customerId)
        
              const now = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(now?.unitPrice, '80.0000')
              assert.equal(now?.source, 'base_level')
        
              const later = await resolveItemPrice({ ...input, onDate: inside })
              assert.equal(later?.unitPrice, '80.0000')
              assert.equal(later?.source, 'base_level')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * PRC15d backstop: an inactive row with a still-open window is a revocation
         * (or a draft that was never offered) and the resolver must not honour it —
         * while activating that same row restores Gold, and a closed window still
         * reads as history.
         */
        test('an inactive open window never prices, but activation restores it', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const customerId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
                values (${org.orgId}, ${customerId}, true)`)
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD8', 'Gold price', 'explicit', false, true)`)
              const baseId = (await db.execute<{ id: string }>(sql`
                select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
              // Created inactive: never offered, window open.
              await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
                values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', false)`)
              const goldSchedule = randomUUID()
              const baseSchedule = randomUUID()
              await db.execute(sql`insert into item_price_schedules
                  (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
                values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
                       (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
              for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
                await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
                  values (${org.orgId}, ${schedule}, '1', ${price})`)
              }
        
              const input = {
                orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
              } as const
              const today = new Date().toISOString().slice(0, 10)
              const dark = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(dark?.unitPrice, '80.0000')
              assert.equal(dark?.source, 'base_level')
        
              // Offering it for real restores Gold: the flag, not the window, was
              // the block.
              await db.execute(sql`update customer_price_level_assignments set is_active = true
               where org_id = ${org.orgId} and customer_id = ${customerId}`)
              const lit = await resolveItemPrice({ ...input, onDate: today })
              assert.equal(lit?.unitPrice, '100.0000')
              assert.equal(lit?.source, 'customer_level')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * Level activation is versioned (0327): deactivating the level closes its
         * period, so past dates still read it as offered while today does not — and
         * a level created today never covered last month.
         */
        test('deactivating a price level closes its history period without rewriting the past', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const goldId = randomUUID()
              await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
                values (${goldId}, ${org.orgId}, 'GOLD2', 'Gold price', 'explicit', false, true)`)
              const opened = (await db.execute<{ active_from: string; active_to: string | null }>(sql`
                select active_from::text as active_from, active_to::text as active_to
                  from price_level_activation_history where org_id = ${org.orgId} and price_level_id = ${goldId}`)).rows
              assert.equal(opened.length, 1)
              // Standing offer: creation never ends coverage of backdated schedules.
              assert.equal(opened[0]!.active_from, '-infinity')
              assert.equal(opened[0]!.active_to, null)
        
              await db.execute(sql`update price_levels set is_active = false where org_id = ${org.orgId} and id = ${goldId}`)
              const closed = (await db.execute<{ active_from: string; active_to: string | null }>(sql`
                select active_from::text as active_from, active_to::text as active_to
                  from price_level_activation_history where org_id = ${org.orgId} and price_level_id = ${goldId}`)).rows
              assert.equal(closed.length, 1)
              const today = new Date().toISOString().slice(0, 10)
              assert.equal(closed[0]!.active_to, today)
        
              // Reactivation opens a new period; the dark gap stays dark.
              await db.execute(sql`update price_levels set is_active = true where org_id = ${org.orgId} and id = ${goldId}`)
              const periods = (await db.execute<{ active_from: string; active_to: string | null }>(sql`
                select active_from::text as active_from, active_to::text as active_to
                  from price_level_activation_history
                 where org_id = ${org.orgId} and price_level_id = ${goldId} order by active_from`)).rows
              assert.equal(periods.length, 2)
              assert.equal(periods[1]!.active_from, today)
              assert.equal(periods[1]!.active_to, null)
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
] as const;

for(const row of itemPricingAsOfRows) await row.register();
