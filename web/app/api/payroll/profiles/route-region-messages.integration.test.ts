import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __regionMessagesState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual("export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}")
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return virtual('export async function currentUser(){return null}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__regionMessagesState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * The reported defect: saving a payroll profile with a missing or mistyped
 * region refused with two words — `invalid state` (AU), `invalid nation`
 * (GB) — naming no field value, no valid set, and no example. The refusal is
 * correct; the message must name the pack's label, the received value (or its
 * absence), the valid codes, and a valid example — the same bar the French
 * NIR refusal already meets.
 */
async function fixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
    const scheduleId = randomUUID()
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
              ${state.actorId}, ${state.actorId})`)
    const employeeId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Region Message Hire', true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, terminated_on)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`)
    return { org, scheduleId, employeeId }
  })
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () => POST(new Request('http://payroll.test/api', { method: 'POST', body: JSON.stringify(body) })))

function profileBody(employeePartyId: string, scheduleId: string, country: string, province: string) {
  return { employeePartyId, payScheduleId: scheduleId, country, province, payBasis: 'hourly' }
}

async function errorOf(body: unknown): Promise<{ status: number; error: string }> {
  const response = await post(body)
  const payload = (await response.json()) as { error?: string }
  return { status: response.status, error: payload.error ?? '' }
}

test('AU profile with no state names the field, the valid states, and an example', { skip: !DB }, async () => {
  const { org, scheduleId, employeeId } = await fixture()
  try {
    const { status, error } = await errorOf(profileBody(employeeId, scheduleId, 'AU', ''))
    assert.equal(status, 422)
    assert.match(error, /No state on this AU payroll profile/)
    assert.match(error, /NSW/)
    assert.match(error, /VIC/)
    assert.match(error, /\(e\.g\. NSW\)/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('AU profile with an unknown state names the received value and the valid states', { skip: !DB }, async () => {
  const { org, scheduleId, employeeId } = await fixture()
  try {
    const { status, error } = await errorOf(profileBody(employeeId, scheduleId, 'AU', 'XX'))
    assert.equal(status, 422)
    assert.match(error, /Unknown state "XX"/)
    assert.match(error, /NSW, VIC, QLD/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('GB profile with no nation names the field and the four nations', { skip: !DB }, async () => {
  const { org, scheduleId, employeeId } = await fixture()
  try {
    const { status, error } = await errorOf(profileBody(employeeId, scheduleId, 'GB', ''))
    assert.equal(status, 422)
    assert.match(error, /No nation on this GB payroll profile/)
    assert.match(error, /ENG/)
    assert.match(error, /\(e\.g\. ENG\)/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('GB profile with an unknown nation names the received value', { skip: !DB }, async () => {
  const { org, scheduleId, employeeId } = await fixture()
  try {
    const { status, error } = await errorOf(profileBody(employeeId, scheduleId, 'GB', 'XX'))
    assert.equal(status, 422)
    assert.match(error, /Unknown nation "XX"/)
    assert.match(error, /ENG, SCT, WLS, NIR/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('IE profile with an unknown region names the received value and the single region', { skip: !DB }, async () => {
  const { org, scheduleId, employeeId } = await fixture()
  try {
    const { status, error } = await errorOf(profileBody(employeeId, scheduleId, 'IE', 'DUBLIN'))
    assert.equal(status, 422)
    assert.match(error, /Unknown region "DUBLIN"/)
    assert.match(error, /IE/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
