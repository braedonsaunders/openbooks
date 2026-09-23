import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Report filter pickers must not offer another legal entity's dimensions.
// dimensionOptions used to list every active department/location/class and
// up to 500 journal-active projects org-wide, so a reader fenced to one
// subsidiary could see — and select — dimensions they may never read.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { dimensionOptions } = await import('./filters.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

test(
  'dimension pickers only offer the scoped subsidiaries’ dimensions',
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    const subB = randomUUID()
    const projectB = randomUUID()
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, tax_ids, is_elimination, is_active, custom)
          values (${subB}, ${org.orgId}, 'Second Co', 'CAD', 'CA', ${org.subsidiaryId}, '{}'::jsonb, false, true, '{}'::jsonb)
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into departments (id, org_id, name, is_active, subsidiary_id)
          values (${randomUUID()}, ${org.orgId}, 'Scoped dept A', true, ${org.subsidiaryId}),
                 (${randomUUID()}, ${org.orgId}, 'Scoped dept B', true, ${subB}),
                 (${randomUUID()}, ${org.orgId}, 'Org-wide dept', true, null)
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
          values (${projectB}, ${org.orgId}, ${subB}, 'HIDDEN', 'Hidden project', 'active', true, '{}'::jsonb)
        `),
      )

      await withOrgContext(org.orgId, async () => {
        const scoped = await dimensionOptions(org.orgId, undefined, [org.subsidiaryId])
        const deptNames = scoped.departments.map((d) => d.name)
        assert.ok(deptNames.includes('Scoped dept A'))
        assert.ok(deptNames.includes('Org-wide dept'), 'org-wide dimensions stay usable in a scoped view')
        assert.ok(!deptNames.includes('Scoped dept B'), 'another subsidiary’s department must not be offered')

        // The selected-project union arm obeys the same scope: a hidden
        // project is not smuggled back in through the explicit selection.
        const withHidden = await dimensionOptions(org.orgId, projectB, [org.subsidiaryId])
        assert.ok(
          !withHidden.projects.some((p) => p.id === projectB),
          'the selected project stays hidden outside its subsidiary scope',
        )
        const openWithHidden = await dimensionOptions(org.orgId, projectB, null)
        assert.ok(
          openWithHidden.projects.some((p) => p.id === projectB),
          'an unrestricted reader still resolves the selected project',
        )

        const open = await dimensionOptions(org.orgId, undefined, null)
        assert.ok(open.departments.some((d) => d.name === 'Scoped dept B'))

        const empty = await dimensionOptions(org.orgId, undefined, [])
        assert.deepEqual(empty.departments, [])
        assert.deepEqual(empty.projects, [])
        assert.deepEqual(empty.locations, [])
        assert.deepEqual(empty.classes, [])
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
