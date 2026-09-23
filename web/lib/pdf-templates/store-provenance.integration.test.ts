import assert from 'node:assert/strict'
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
      assert.equal(byDefault?.provenance.templateId, id)
      assert.equal(byDefault?.provenance.revision, 1)
      assert.match(byDefault?.provenance.contentHash ?? '', /^[0-9a-f]{64}$/)
      const byId = await withBypassContext(() => resolvePdfTemplate(org.orgId, 'customer_invoice', id))
      assert.equal(byId?.provenance.templateId, id)
      assert.equal(byId?.provenance.revision, 1)
      assert.equal(
        byId?.provenance.contentHash,
        byDefault?.provenance.contentHash,
        'the same design resolves to the same hash by either path',
      )
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'changing only the footer changes the hash; identical designs share it',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // The hash covers every renderer-consumed field (body, header, footer,
    // paper, orientation, margins) — a chrome-only redesign must move the
    // provenance, and re-saving the same design must not.
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Template Admin', 'admin'))
      const seed = (name: string, footer: string | null) =>
        withBypassContext(() => db.execute<{ id: string }>(sql`
          insert into pdf_templates (org_id, record_type, name, footer_html, source_html, compiled_html, created_by, updated_by)
          values (${org.orgId}, 'customer_invoice', ${name}, ${footer}, '<p>Same</p>', '<p>Same</p>', ${actor}, ${actor})
          returning id`)).then((r) => r.rows[0]!.id)
      const footed = await seed('Footed', '<p>footer v1</p>')
      const bare = await seed('Bare', null)
      const clone = await seed('Clone', '<p>footer v1</p>')

      const hashOf = (id: string) =>
        withBypassContext(() => resolvePdfTemplate(org.orgId, 'customer_invoice', id)).then(
          (tpl) => tpl!.provenance.contentHash,
        )
      const footedHash = await hashOf(footed)
      const bareHash = await hashOf(bare)
      assert.notEqual(footedHash, bareHash, 'a footer-only change moves the hash')
      assert.equal(await hashOf(clone), footedHash, 'identical designs share the hash')
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
      assert.match(tpl.provenance.contentHash, /^[0-9a-f]{64}$/)
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)
