import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Page loaders import server-only and Next navigation helpers; stub the
// module boundary so the loader loads under plain node (the journal drawer
// and ref-options vendors tests stub them the same way). Only the refusal
// path runs here — no translations, no session — so the stubs never fire.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export function notFound() { throw new Error("notFound") } export function redirect() { throw new Error("redirect") }',
      }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export async function getTranslations() { return (key) => key }',
      }
    }
    return next(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { FieldTimeError } = await import('@openbooks/engine/src/hrm/field-time/errors.ts')
const { loadClockPageData } = await import('./view.ts')

// A correct refusal thrown out of render reaches the operator as generic
// copy in production, so the clock loader converts it to page state: a
// login with no linked employee party reads the refusal with its remedy
// (FieldTimeError no_employee_link) instead of the error boundary.
const t = (key: string): string => key

test('the clock loader returns the refusal state for a user without a party link', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    // Scratch users carry no party link by design — the exact population
    // the release lane hit.
    const userId = await withBypass(() => createScratchUser(org.orgId, 'Unlinked', 'viewer'))
    const data = await withBypass(() => loadClockPageData(org.orgId, userId, t))
    assert.ok(data.refusal, 'an unlinked login must get refusal state, not a throw')
    assert.match(
      data.refusal.message,
      /No employee record is linked to this login/,
      'the refusal carries the engine refusal with its remedy',
    )
    assert.match(
      data.refusal.message,
      /link the user to an employee party/,
      'the operator reads what to do, not a generic failure',
    )
    assert.deepEqual(data.rows, [], 'no pairs resolve without a party')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('a linked login never hits the party refusal again', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, 'Soon linked', 'viewer'))
    const partyId = randomUUID()
    await withBypass(() => db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active)
      values (${partyId}, ${org.orgId}, 'person', 'Soon Linked', true)`))
    await withBypass(() => db.execute(sql`
      update users set party_id = ${partyId} where org_id = ${org.orgId} and id = ${userId}`))
    // Whatever follows (empty data, or the feature-gate refusal when the
    // switch is off) must not be the party refusal: only its own code
    // ever converts, so linking the party clears exactly this state.
    try {
      const data = await withBypass(() => loadClockPageData(org.orgId, userId, t))
      assert.equal(data.refusal, null, 'a linked login gets data, not the party refusal')
    } catch (e) {
      // Any other error (e.g. the feature-gate refusal) still throws out
      // of the loader — the assertion is only that the party refusal is
      // gone, so a throw here passes as long as it is not that refusal.
      assert.ok(
        !(e instanceof FieldTimeError) || e.code !== 'no_employee_link',
        `a linked login must never hit the party refusal, threw: ${String(e)}`,
      )
    }
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
