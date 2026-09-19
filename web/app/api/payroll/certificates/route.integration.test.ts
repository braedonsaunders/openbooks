import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __payrollCertificatesState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__payrollCertificatesState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { resolveCertificate, payrollCertificate } = await import('@openbooks/engine/src/payroll/certificates.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { GET: profilesGet } = await import('../profiles/route')
const { POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
    const scheduleId = randomUUID()
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Monthly', 'monthly', 12, '2026-04-30', 5, true,
              ${state.actorId}, ${state.actorId})`)
    return { org, scheduleId }
  })
}

async function employee(
  orgId: string, scheduleId: string, name: string, country: string, province: string,
): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`)
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, terminated_on)
    values (${randomUUID()}, ${orgId}, ${id}, null)`)
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, ${scheduleId}, ${country}, ${province}, 'salary', true,
            ${state.actorId}, ${state.actorId})`)
  return id
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () => POST(new Request('http://payroll.test', { method: 'POST', body: JSON.stringify(body) })))

async function setup() {
  const { org, scheduleId } = await fixture()
  return { org, scheduleId }
}

test('certificate rows validate purely from the pack declaration', { skip: !DB }, async () => {
  // Every refusal names the pack's own declaration — no country, form or
  // field is hardcoded in the route, so these messages are the pack speaking.
  const { org, scheduleId } = await setup()
  try {
    const hire = await employee(org.orgId, scheduleId, 'GB Hire', 'GB', 'ENG')
    const base = { employeePartyId: hire, country: 'GB' }
    // Unknown certificate: refused with the pack's declared keys.
    {
      const response = await post({ ...base, certificateKey: 'gb_made_up', answers: {} })
      assert.equal(response.status, 422, await response.clone().text())
      assert.match(((await response.json()) as { error: string }).error, /declares no "gb_made_up"/)
    }
    // Undeclared field key: refused by name with the declared keys.
    {
      const response = await post({
        ...base, certificateKey: 'gb_tax_code_notice', answers: { tax_bracket: '1257L' },
      })
      assert.equal(response.status, 422, await response.clone().text())
      assert.match(((await response.json()) as { error: string }).error, /declares no "tax_bracket"/)
    }
    // Missing required field with no default: the P6/P9 tax code is required.
    {
      const response = await post({
        ...base, certificateKey: 'gb_tax_code_notice', answers: { non_cumulative: 'true' },
      })
      assert.equal(response.status, 422, await response.clone().text())
      assert.match(((await response.json()) as { error: string }).error, /"tax_code".*required/)
    }
    // A filing that answers nothing is refused outright — a blank row would
    // read as "on file" downstream without satisfying any refusal. (The DE 4
    // is the case: every required field carries a default, so emptiness is
    // the only refusal left to give.)
    {
      const cali = await employee(org.orgId, scheduleId, 'Cali Empty', 'US', 'CA')
      const response = await post({
        employeePartyId: cali, country: 'US', certificateKey: 'us_ca_de4', answers: {},
      })
      assert.equal(response.status, 422, await response.clone().text())
      assert.match(((await response.json()) as { error: string }).error, /no answers/)
    }
    // Bad flag value is refused rather than read as false.
    {
      const response = await post({
        ...base, certificateKey: 'gb_tax_code_notice',
        answers: { tax_code: '1257L', non_cumulative: 'perhaps' },
      })
      assert.equal(response.status, 422, await response.clone().text())
      assert.match(((await response.json()) as { error: string }).error, /non_cumulative|checkbox/)
    }
    // Bad choice value on the starter checklist.
    {
      const response = await post({
        ...base, certificateKey: 'gb_starter_checklist',
        answers: { starter_declaration: 'D', student_loan_plan: 'none' },
      })
      assert.equal(response.status, 422, await response.clone().text())
      assert.match(((await response.json()) as { error: string }).error, /must be one of A, B, C/)
    }
    // A well-formed filing saves.
    {
      const response = await post({
        ...base, certificateKey: 'gb_tax_code_notice',
        answers: { tax_code: '1257L' }, effectiveFrom: '2026-04-06',
      })
      assert.equal(response.status, 200, await response.clone().text())
      const body = (await response.json()) as { ok: boolean; certificateKey: string; effectiveFrom: string }
      assert.deepEqual(body, { ok: true, certificateKey: 'gb_tax_code_notice', effectiveFrom: '2026-04-06' })
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('count and amount answers hold their declared bands and scale', { skip: !DB }, async () => {
  // California's DE 4 exercises the count and amount kinds end to end.
  const { org, scheduleId } = await setup()
  try {
    const hire = await employee(org.orgId, scheduleId, 'CA Hire', 'US', 'CA')
    const base = { employeePartyId: hire, country: 'US', certificateKey: 'us_ca_de4' }
    for (const [label, answers, message] of [
      ['allowances band', { regular_allowances: '100' }, /above the declared maximum 99/],
      ['allowances shape', { regular_allowances: 'two' }, /whole number/],
      ['amount shape', { additional_per_period: 'plenty' }, /not a valid amount/],
      ['amount floor', { additional_per_period: '-5' }, /below the declared minimum 0/],
    ] as const) {
      const response = await post({ ...base, answers })
      assert.equal(response.status, 422, `${label}: ${await response.clone().text()}`)
      assert.match(((await response.json()) as { error: string }).error, message)
    }
    const ok = await post({
      ...base,
      answers: { regular_allowances: '2', additional_per_period: '25.5' },
      effectiveFrom: '2026-01-01',
    })
    assert.equal(ok.status, 200, await ok.clone().text())
    // The amount stores at the pack's declared scale (4dp), like the engine reads.
    const rows = await withOrgContext(org.orgId, () => db.execute<{ answers: Record<string, string> }>(sql`
      select answers from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}`))
    assert.deepEqual(rows.rows[0]!.answers, { regular_allowances: '2', additional_per_period: '25.5000' })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('region scope is the declared scope, never the key name', { skip: !DB }, async () => {
  // A California employee files the DE 4; the New York IT-2104 refuses by
  // name even though the employee asked for it explicitly.
  const { org, scheduleId } = await setup()
  try {
    const hire = await employee(org.orgId, scheduleId, 'Cali Hire', 'US', 'CA')
    const scoped = await post({
      employeePartyId: hire, country: 'US', certificateKey: 'us_ny_it2104',
      answers: { nys_allowances: '1' },
    })
    assert.equal(scoped.status, 422, await scoped.clone().text())
    assert.match(
      ((await scoped.json()) as { error: string }).error,
      /"us_ny_it2104" is scoped to NY but this employee works in CA/,
    )
    // …while the wrong pack entirely is a different refusal.
    const yankee = await employee(org.orgId, scheduleId, 'Yankee Hire', 'GB', 'ENG')
    const pack = await post({
      employeePartyId: yankee, country: 'US', certificateKey: 'us_ca_de4',
      answers: { regular_allowances: '1' },
    })
    assert.equal(pack.status, 422, await pack.clone().text())
    assert.match(((await pack.json()) as { error: string }).error, /belongs to the US payroll pack/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('column-stored certificates cannot be filed as rows', { skip: !DB }, async () => {
  // The W-4 and the TD1 family predate row storage and are still read from
  // the profile: a row filing would shadow the column the engine reads, so
  // it is refused by name. Canada's column path is unchanged — this is the
  // write-side proof.
  const { org, scheduleId } = await setup()
  try {
    const hire = await employee(org.orgId, scheduleId, 'Ontario Hire', 'CA', 'ON')
    const response = await post({
      employeePartyId: hire, country: 'CA', certificateKey: 'ca_td1',
      answers: { federal_claim_code: '5' },
    })
    assert.equal(response.status, 422, await response.clone().text())
    assert.match(
      ((await response.json()) as { error: string }).error,
      /"ca_td1" stores its answers in payroll profile columns/,
    )
    const rows = await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*) as count from employee_tax_certificates where org_id = ${org.orgId}`))
    assert.equal(rows.rows[0]!.count, '0')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a re-filing supersedes rather than overwrites, and prior dates resolve old', { skip: !DB }, async () => {
  // The single most important invariant: history is never rewritten. The old
  // row stays with its superseded_on, and the engine's own resolver reads the
  // older certificate for the older pay date.
  const { org, scheduleId } = await setup()
  try {
    const hire = await employee(org.orgId, scheduleId, 'GB Rehire', 'GB', 'ENG')
    const base = { employeePartyId: hire, country: 'GB', certificateKey: 'gb_tax_code_notice' }
    const first = await post({ ...base, answers: { tax_code: '1257L' }, effectiveFrom: '2026-04-06' })
    assert.equal(first.status, 200, await first.clone().text())
    const second = await post({
      ...base, answers: { tax_code: 'BR' }, effectiveFrom: '2026-08-01',
    })
    assert.equal(second.status, 200, await second.clone().text())
    // A backdated filing against a newer current row is refused by name.
    const backdated = await post({ ...base, answers: { tax_code: '0T' }, effectiveFrom: '2026-01-01' })
    assert.equal(backdated.status, 422, await backdated.clone().text())
    assert.match(((await backdated.json()) as { error: string }).error, /already on file effective 2026-08-01/)
    const rows = await withOrgContext(org.orgId, () => db.execute<{
      answers: Record<string, string>; effective_from: string; superseded_on: string | null;
    }>(sql`
      select answers, effective_from::text as effective_from, superseded_on::text as superseded_on
        from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}
       order by effective_from`))
    assert.equal(rows.rows.length, 2)
    assert.deepEqual(rows.rows[0], {
      answers: { tax_code: '1257L' }, effective_from: '2026-04-06', superseded_on: '2026-08-01',
    })
    assert.deepEqual(rows.rows[1], {
      answers: { tax_code: 'BR' }, effective_from: '2026-08-01', superseded_on: null,
    })
    // The engine's own resolver — the same function the pay run calls — reads
    // the certificate that was actually in force on each pay date.
    const certificate = payrollCertificate('GB', 'gb_tax_code_notice')
    const stored = rows.rows.map((row) => ({
      certificateKey: 'gb_tax_code_notice',
      answers: row.answers,
      effectiveFrom: row.effective_from,
      supersededOn: row.superseded_on,
    }))
    const oldRun = resolveCertificate({ certificate, stored, asOf: '2026-05-05' })
    assert.equal(oldRun.answers.tax_code, '1257L')
    const newRun = resolveCertificate({ certificate, stored, asOf: '2026-09-05' })
    assert.equal(newRun.answers.tax_code, 'BR')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profiles GET serves every declared certificate plus stored rows for prefill', { skip: !DB }, async () => {
  // The read side of the hole: the GET used to filter to profile_columns, so
  // the page could not even populate the fields it has now learned to render.
  const { org, scheduleId } = await setup()
  try {
    const hire = await employee(org.orgId, scheduleId, 'GB Prefill', 'GB', 'ENG')
    const filed = await post({
      employeePartyId: hire, country: 'GB', certificateKey: 'gb_tax_code_notice',
      answers: { tax_code: '1257L' }, effectiveFrom: '2026-04-06',
    })
    assert.equal(filed.status, 200, await filed.clone().text())
    const response = await withOrgContext(org.orgId, () =>
      profilesGet(new Request(`http://payroll.test?employee=${hire}`)))
    assert.equal(response.status, 200, await response.clone().text())
    const body = (await response.json()) as {
      packProfiles: Record<string, { certificates: { key: string; storage: string }[] }>
      storedCertificates: {
        certificateKey: string; country: string; region: string | null; subRegion: string | null;
        answers: Record<string, string>; effectiveFrom: string;
      }[]
    }
    const gbKeys = new Map(body.packProfiles['GB']!.certificates.map((c) => [c.key, c.storage]))
    assert.equal(gbKeys.get('gb_tax_code_notice'), 'certificate_rows')
    assert.equal(gbKeys.get('gb_starter_checklist'), 'certificate_rows')
    const usKeys = new Map(body.packProfiles['US']!.certificates.map((c) => [c.key, c.storage]))
    assert.equal(usKeys.get('us_w4'), 'profile_columns')
    assert.ok(usKeys.get('us_ca_de4') === 'certificate_rows', 'the DE 4 is served, not filtered')
    const caKeys = new Map(body.packProfiles['CA']!.certificates.map((c) => [c.key, c.storage]))
    assert.equal(caKeys.get('ca_td1'), 'profile_columns')
    assert.deepEqual(body.storedCertificates, [{
      certificateKey: 'gb_tax_code_notice',
      country: 'GB',
      region: null,
      subRegion: null,
      answers: { tax_code: '1257L' },
      effectiveFrom: '2026-04-06',
    }])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test.after(async () => { await pool.end() })
