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
