import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { loadApiSchema } = await import('./schema-registry.ts')
const { generateOpenApiSpec } = await import('./openapi-server.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')

test(
  'API schema hides custom record types outside the caller audience',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `aud-${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const typeId = randomUUID()
    const { org } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actors = await seedFlowActors(created.orgId)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, allowed_roles, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${typeKey}, 'Audience Secret', 'Audience Secrets',
           ${JSON.stringify([{ id: 'main', title: 'Details', fields: [{ id: 'secret', type: 'text', label: 'Secret' }] }])}::jsonb,
           'published', '["tax-reviewer"]'::jsonb, ${actors.adminId}, ${actors.adminId})
      `)
      return { org: created }
    })

    try {
      const restricted = await withOrgContext(org.orgId, () =>
        loadApiSchema(org.orgId, ['ordinary-role']),
      )
      assert.equal(
        restricted.some((schema) => schema.key === typeKey),
        false,
        'a caller outside allowed_roles must not receive the type schema',
      )

      const audience = await withOrgContext(org.orgId, () =>
        loadApiSchema(org.orgId, ['tax-reviewer']),
      )
      assert.equal(
        audience.some((schema) => schema.key === typeKey),
        true,
        'a caller in allowed_roles receives the type schema',
      )

      const modelKey = typeKey.replaceAll('-', '_').replace(/^./, (char) => char.toUpperCase())
      const restrictedSpec = await withOrgContext(org.orgId, () =>
        generateOpenApiSpec(org.orgId, 'https://openbooks.test', ['ordinary-role']),
      )
      assert.equal(
        Object.hasOwn(restrictedSpec.components.schemas, modelKey),
        false,
        'OpenAPI must not advertise a type outside allowed_roles',
      )

      const audienceSpec = await withOrgContext(org.orgId, () =>
        generateOpenApiSpec(org.orgId, 'https://openbooks.test', ['tax-reviewer']),
      )
      assert.equal(
        Object.hasOwn(audienceSpec.components.schemas, modelKey),
        true,
        'OpenAPI advertises a type to an allowed role',
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)
