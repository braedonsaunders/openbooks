import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'

// Translation is the only scripted boundary: list resolution, the shared
// reader's feature refusal, authorization and the database stay real.
stubModules({ intl: true })

const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { EntityListView } = await import('./entity-list-view.tsx')
const { RecordListView } = await import('./record-list-view.tsx')

installTrustedTestDatabaseBypass()
const DB = !!process.env.OPENBOOKS_DB_URL

async function actor(orgId: string, key: string, permissions: string[]): Promise<string> {
  return withBypassContext(async () => {
    const id = await createScratchUser(orgId, key, key)
    const updated = await db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${orgId} and key=${key} returning key`)
    assert.equal(updated.rows.length, 1, `${key} role setup updates one role`)
    return id
  })
}

function featureStates(html: string): number {
  return html.split('data-route-state="feature-disabled"').length - 1
}

test('entity and document lists whose feature is off render the shared feature state once, without list controls', { skip: !DB }, async () => {
  // Resourcing and Return authorizations are off for a new organization.
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const admin = await actor(org.orgId, 'features-admin', ['*'])
    const reader = await actor(org.orgId, 'list-reader', ['resourcing.read', 'projects.read', 'sales.read'])
    const entityList = (userId: string) => withOrgContext(org.orgId, () => EntityListView({
      recordType: 'resourcing_assignment', orgId: org.orgId, userId, canManage: true, sp: {},
    }))
    const documentList = (userId: string) => withOrgContext(org.orgId, () => RecordListView({
      recordType: 'rma', basePath: '/returns', orgId: org.orgId, userId, canManage: true, sp: {},
    }))

    for (const [name, render, feature] of [
      ['entity list', entityList, 'resourcing'],
      ['document list', documentList, 'returnAuthorizations'],
    ] as const) {
      const html = renderToStaticMarkup(await render(admin))
      assert.equal(featureStates(html), 1, `${name}: one shared feature state replaces the body`)
      assert.match(html, /data-route-placement="section"/)
      assert.match(html, new RegExp(`>${feature}<`), `${name}: the canvas names the switch`)
      assert.match(html, /href="\/admin\/setup\/features"/, `${name}: a setup manager is linked to Features`)
      assert.doesNotMatch(html, /feature_disabled|Company Settings/, `${name}: no refusal code or remedy text`)
      assert.doesNotMatch(html, /<table|views\.defaultName|type="search"/, `${name}: no table, view switcher or search`)

      const readerHtml = renderToStaticMarkup(await render(reader))
      assert.equal(featureStates(readerHtml), 1)
      assert.doesNotMatch(readerHtml, /href="\/admin\/setup\/features"/, `${name}: no Features link without setup authority`)
      assert.match(readerHtml, /askAdministrator/, `${name}: the reader is told who can turn it on`)
    }
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
