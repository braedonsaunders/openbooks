import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

// Every template resolution carries immutable evidence of the design it
// returned: the saved template's id + revision plus the sha256 of the
// compiled HTML actually printed (a starter fallback has no id or revision,
// but its content hash still identifies the design byte-for-byte). Every
// issuance channel records this same object.

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { resolvePdfTemplate } = await import('./store')

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

test(
  'a resolved template carries its id, revision and content hash',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Template Admin', 'admin'))
      const id = (await withBypassContext(() => db.execute<{ id: string }>(sql`
        insert into pdf_templates (org_id, record_type, name, source_html, compiled_html, created_by, updated_by)
        values (${org.orgId}, 'customer_invoice', 'Provenance', '<p>Proof</p>', '<p>Proof</p>', ${actor}, ${actor})
        returning id`))).rows[0]!.id

      const byDefault = await withBypassContext(() => resolvePdfTemplate(org.orgId, 'customer_invoice', null))
      assert.deepEqual(byDefault?.provenance, {
        templateId: id,
        revision: 1,
        contentHash: sha256('<p>Proof</p>'),
      })
      const byId = await withBypassContext(() => resolvePdfTemplate(org.orgId, 'customer_invoice', id))
      assert.deepEqual(byId?.provenance, {
        templateId: id,
        revision: 1,
        contentHash: sha256('<p>Proof</p>'),
      })
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a starter fallback carries a content hash with no id or revision',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const tpl = await withBypassContext(() => resolvePdfTemplate(org.orgId, 'customer_invoice', null))
      assert.ok(tpl, 'a record type with no saved template still resolves to the starter')
      assert.equal(tpl.provenance.templateId, null)
      assert.equal(tpl.provenance.revision, null)
      assert.equal(tpl.provenance.contentHash, sha256(tpl.compiledHtml))
      assert.match(tpl.provenance.contentHash, /^[0-9a-f]{64}$/)
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)
