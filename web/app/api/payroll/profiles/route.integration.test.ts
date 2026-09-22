import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __payrollProfileState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__payrollProfileState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { PAYROLL_COUNTRY_PACKS } = await import('@openbooks/engine/src/payroll/packs.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * The countries the profile editor may offer, snapshotted once before any
 * test runs so a pack registered mid-file could never inflate it. (Nothing
 * in this file registers packs; the snapshot makes the derivation explicit.)
 */
const EXPECTED_COUNTRIES: readonly string[] = Object.keys(PAYROLL_COUNTRY_PACKS)

async function fixture() {
  // Scratch seeding runs under an explicit bypass boundary: importing the
  // route registers the web request-org resolver, which denies outside a
  // Next request store, so ambient setup would hit RLS (and reads would
  // silently return zero rows).
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
    const employeeId = randomUUID()
    const scheduleId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Sloppy Hire', true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, terminated_on)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`)
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
              ${state.actorId}, ${state.actorId})`)
    return { org, employeeId, scheduleId }
  })
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () => POST(new Request('http://payroll.test', { method: 'POST', body: JSON.stringify(body) })))
const get = (query = '') =>
  withOrgContext(state.orgId, () => GET(new Request(`http://payroll.test${query}`)))

test('profile POST refuses money and percent fields wider than their columns', { skip: !DB }, async () => {
  // Claim amounts are numeric(19,4) and vacation_percent numeric(7,4): pasted
  // figures wider than that cleared the exact-decimal check and died in the
  // upsert with a storage error. Fail closed with the named 422 instead.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, country: 'CA', province: 'ON', payBasis: 'hourly', sin: '046454286' }
    // Each refusal names WHICH of the three causes fired and what was
    // supplied. One message covering all three is what made a pasted
    // twenty-digit figure undiagnosable, so assert the cause, not the field.
    for (const [label, patch, message] of [
      ['claim amount too wide', { federalClaimAmount: '99999999999999999999' }, /federalClaimAmount is limited to 15 digits before the decimal point — got 20/],
      ['claim amount not a number', { federalClaimAmount: 'abc' }, /federalClaimAmount must be an amount — "abc" is not a number/],
      ['claim amount negative', { federalClaimAmount: '-1' }, /federalClaimAmount cannot be negative — got -1/],
      // The unreadable-value branch is itself split: an over-scale figure, a
      // spreadsheet thousands separator, a currency symbol, and scientific
      // notation are all refused as "not a number" by the strict gate but need
      // four different remedies, so each names its cause.
      ['claim amount scale', { federalClaimAmount: '1234.56789' }, /federalClaimAmount allows at most 4 decimal places — got 5 in "1234.56789"/],
      ['claim amount separator', { federalClaimAmount: '1,234.56' }, /federalClaimAmount must not contain a thousands separator — remove , from "1,234.56"/],
      // A decimal comma is not a thousands separator: "remove the comma"
      // would bank 1234 for 12.34. Name the decimal point, and the rewrite.
      ['claim amount decimal comma', { federalClaimAmount: '12,34' }, /federalClaimAmount must use "\." as the decimal point — write "12,34" as "12\.34"/],
      // A decimal comma with its own grouping ("1 234,56") reads the same
      // way: without this the grouping message composes into wrong money in
      // two steps (drop the comma, then the space banks 123456).
      ['claim amount grouped decimal comma', { federalClaimAmount: '1 234,56' }, /write "1 234,56" as "1234\.56"/],
      // A single comma with any other tail is genuinely ambiguous: name both
      // readings rather than picking one.
      ['claim amount ambiguous comma', { federalClaimAmount: '1,234' }, /federalClaimAmount is ambiguous — "1,234" could mean 1234 \(thousands separator\) or 1\.234 \(decimal comma\)/],
      // Dot-grouping with a decimal comma ("1.234,56") reads by the same
      // rule every locale shares: the last separator is the decimal point.
      // The dot-last mirror ("1,234.56") must keep its grouping message —
      // that is the regression risk.
      ['claim amount dot grouping', { federalClaimAmount: '1.234,56' }, /federalClaimAmount must use "\." as the decimal point — write "1\.234,56" as "1234\.56"/],
      ['claim amount comma grouping unchanged', { federalClaimAmount: '1,234.56' }, /federalClaimAmount must not contain a thousands separator — remove , from "1,234\.56"/],
      ['claim amount currency', { federalClaimAmount: '$1200' }, /federalClaimAmount must not contain a currency symbol — remove \$ from "\$1200"/],
      ['claim amount scientific', { federalClaimAmount: '1.5E+05' }, /federalClaimAmount must be written out in full, not in scientific notation/],
      ['vacation percent too wide', { vacationPercent: '1234' }, /vacationPercent is limited to 3 digits before the decimal point — got 4/],
      ['vacation percent not a number', { vacationPercent: 'abc' }, /vacationPercent must be a percentage — "abc" is not a number/],
      ['vacation percent scale', { vacationPercent: '12.34567' }, /vacationPercent allows at most 4 decimal places — got 5 in "12.34567"/],
      ['vacation percent negative', { vacationPercent: '-1' }, /vacationPercent cannot be negative — got -1/],
      // The echo is bounded: the body is arbitrary JSON, so an object must not
      // come back as "[object Object]" and a long paste must not come back
      // whole. Name the type, cap the string.
      ['claim amount object', { federalClaimAmount: { a: 1 } }, /federalClaimAmount must be an amount — "a object" is not a number/],
      ['claim amount long paste', { federalClaimAmount: 'x'.repeat(500) }, /is not a number/],
    ] as const) {
      const response = await post({ ...base, ...patch })
      assert.equal(response.status, 422, `${label}: ${await response.clone().text()}`)
      assert.match(((await response.json()) as { error: string }).error, message)
    }
    // The boundary itself, both sides. numeric(19,4) is fifteen whole digits:
    // fifteen must SAVE and sixteen must refuse, or the limit in the message
    // is a number nobody has checked.
    const sixteen = await post({ ...base, federalClaimAmount: '1234567890123456' })
    assert.equal(sixteen.status, 422, await sixteen.clone().text())
    assert.match(((await sixteen.json()) as { error: string }).error, /limited to 15 digits before the decimal point — got 16/)

    const rows = await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*) as count from employee_payroll_profiles where org_id = ${org.orgId}`))
    assert.equal(rows.rows[0]!.count, '0')
    // The widened scale, both sides: the money columns are numeric(19,4), so a
    // three-decimal figure the old 2dp gate refused as malformed must SAVE
    // exactly, while five decimals still refuse naming the four-place limit.
    const threeDp = await post({ ...base, federalClaimAmount: '1234.567', vacationPercent: '999.9999' })
    assert.equal(threeDp.status, 200, await threeDp.clone().text())
    const threeDpSaved = await withOrgContext(org.orgId, () => db.execute<{ federal_claim_amount: string }>(sql`
      select federal_claim_amount::text from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`))
    assert.deepEqual(threeDpSaved.rows[0], { federal_claim_amount: '1234.5670' })
    // In-range values, including the column maximums at the route's 4dp
    // contract, still save.
    const ok = await post({ ...base, federalClaimAmount: '999999999999999.99', vacationPercent: '999.9999' })
    assert.equal(ok.status, 200, await ok.clone().text())
    const saved = await withOrgContext(org.orgId, () => db.execute<{ federal_claim_amount: string; vacation_percent: string }>(sql`
      select federal_claim_amount::text, vacation_percent::text from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`))
    assert.deepEqual(saved.rows[0], { federal_claim_amount: '999999999999999.9900', vacation_percent: '999.9999' })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile GET serves the packs declared subdivisions and withholding shapes', { skip: !DB }, async () => {
  // The editor renders whatever the installed packs declare: countries from
  // the registry, subdivision lists and labels from each pack's regions
  // coverage, withholding fields from its column-mapped certificates.
  const { org } = await fixture()
  try {
    const response = await get()
    assert.equal(response.status, 200, await response.clone().text())
    const body = (await response.json()) as {
      countries: string[]
      packProfiles: Record<string, {
        countryName: string
        subdivisionLabel: string
        subdivisions: string[]
        subdivisionNames: Record<string, string>
        supportedSubdivisions: string[]
        certificates: { key: string; form: string; scope: { level: string; region?: string } }[]
        exemptionFlags: { column: string }[]
      }>
    }
    // The contract is that the editor renders whatever the installed packs
    // declare — the registry's keys, in registry order — not a CA/US union.
    // This pinned ['CA', 'US'] and went red the day the registry opened past
    // two countries: a stale pin, not a regression. Derive it; the GET is the
    // runtime registration assertion, so every registered pack must also
    // declare its profile shape below.
    assert.deepEqual(body.countries, EXPECTED_COUNTRIES)
    assert.deepEqual(Object.keys(body.packProfiles), EXPECTED_COUNTRIES)
    for (const [country, profile] of Object.entries(body.packProfiles)) {
      // The pickers show names, never bare codes: the pack's own name for
      // the country, its regionNames for every known subdivision.
      assert.equal(profile.countryName, PAYROLL_COUNTRY_PACKS[country]!.name, `${country} serves its pack name`)
      for (const code of profile.subdivisions) {
        assert.equal(
          profile.subdivisionNames[code],
          PAYROLL_COUNTRY_PACKS[country]!.regions.regionNames[code],
          `${country}/${code} serves its declared region name`,
        )
      }
      assert.equal(typeof profile.subdivisionLabel, 'string', `${country} declares a subdivision label`)
      assert.ok(profile.subdivisionLabel.length > 0, `${country} subdivision label is non-empty`)
      assert.ok(Array.isArray(profile.subdivisions), `${country} declares subdivisions`)
      // Anchor the loop: an installable pack that supports no subdivision
      // would make every assertion below vacuous. installable-region-coverage
      // pins the same fact at the pack level; this pins it at the wire.
      assert.ok(
        profile.supportedSubdivisions.length > 0,
        `${country} serves at least one supported subdivision`,
      )
      for (const code of profile.supportedSubdivisions) {
        assert.ok(profile.subdivisions.includes(code), `${country} supports only a known subdivision: ${code}`)
      }
      assert.ok(Array.isArray(profile.certificates), `${country} declares certificates`)
      assert.ok(Array.isArray(profile.exemptionFlags), `${country} declares exemption flags`)
    }
    const ca = body.packProfiles['CA']!
    assert.equal(ca.subdivisionLabel, 'province')
    assert.ok(ca.subdivisions.includes('ON') && ca.subdivisions.includes('ZZ'))
    assert.deepEqual(ca.supportedSubdivisions, ca.subdivisions)
    assert.ok(ca.certificates.some((c) => c.key === 'ca_td1' && c.scope.level === 'country'))
    assert.ok(ca.certificates.some((c) => c.key === 'ca_td1_ON' && c.scope.region === 'ON'))
    assert.deepEqual(ca.exemptionFlags, [])
    const us = body.packProfiles['US']!
    assert.equal(us.subdivisionLabel, 'state')
    assert.ok(us.subdivisions.includes('CA') && us.subdivisions.includes('NY'))
    assert.ok(us.subdivisions.includes('DC'), 'DC is a declared US subdivision')
    // The fleet is complete: every declared US subdivision is supported.
    // DC was the last wage-tax gap; it left unimplementedUsStates() by
    // gaining an engine, not by the supported list being weakened. The
    // previous `<` asserted that absence; it is no longer a fact. Pin
    // the equality the same way Canada is pinned — do not reopen a gap
    // to satisfy a stale comparison.
    assert.deepEqual(us.supportedSubdivisions, us.subdivisions)
    assert.ok(us.certificates.some((c) => c.key === 'us_w4'))
    assert.deepEqual(us.exemptionFlags.map((f) => f.column).sort(), ['fica_exempt', 'futa_exempt'])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST validates withholding answers against the pack declaration', { skip: !DB }, async () => {
  // Choice sets and count bands come from the pack's declared certificate
  // fields: the W-4's statuses and 0–99 allowances, the TD1's 0–10 codes.
  // An answer for a column the pack does not declare is refused.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, payBasis: 'hourly' }
    const list = (await (await get()).json()) as {
      packProfiles: Record<string, { supportedSubdivisions: string[] }>
    }
    const usState = list.packProfiles['US']!.supportedSubdivisions[0]!
    for (const [label, patch, status, message] of [
      ['US filing status', { country: 'US', province: usState, filingStatus: 'single', sin: '123-45-6789' }, 200, null],
      ['unknown status', { country: 'US', province: usState, filingStatus: 'separate', sin: '123-45-6789' }, 422, /invalid filingStatus/],
      ['CA filing status', { country: 'CA', province: 'ON', filingStatus: 'single', sin: '046454286' }, 422, /invalid filingStatus/],
      ['CA claim code', { country: 'CA', province: 'ON', federalClaimCode: 5, sin: '046454286' }, 200, null],
      ['CA claim code band', { country: 'CA', province: 'ON', federalClaimCode: 11, sin: '046454286' }, 422, /claim code must be 0–10/],
      // A code province accepts a provincial claim code; Québec, whose pack
      // declares claimIdentity 'amount', refuses it by name and names its form.
      ['CA provincial claim code', { country: 'CA', province: 'ON', provincialClaimCode: 2, sin: '046454286' }, 200, null],
      ['QC claim code refused', { country: 'CA', province: 'QC', provincialClaimCode: 1, sin: '046454286' }, 422, /TP-1015\.3-V identifies the claim by an amount/],
      ['QC claim amount accepted', { country: 'CA', province: 'QC', provincialClaimAmount: '15000', sin: '046454286' }, 200, null],
      ['US claim code', { country: 'US', province: usState, federalClaimCode: 1, sin: '123-45-6789' }, 422, /not declared/],
      ['US allowances', { country: 'US', province: usState, w4Allowances: 5, sin: '123-45-6789' }, 200, null],
      ['US allowances band', { country: 'US', province: usState, w4Allowances: 100, sin: '123-45-6789' }, 422, /invalid w4Allowances/],
      ['CA allowances', { country: 'CA', province: 'ON', w4Allowances: 1, sin: '046454286' }, 422, /invalid w4Allowances/],
    ] as const) {
      const response = await post({ ...base, ...patch })
      assert.equal(response.status, status, `${label}: ${await response.clone().text()}`)
      if (message) assert.match(((await response.json()) as { error: string }).error, message)
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST validates the sealed identifier against the pack declaration', { skip: !DB }, async () => {
  // The old validator stripped non-digits and demanded nine: every
  // alphanumeric identifier was mangled and every non-9-digit one refused.
  // The pack's own pattern judges the value as given; refusals name the
  // pack's own label and shape, so the 422 is worth showing.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, payBasis: 'hourly' }
    const list = (await (await get()).json()) as {
      packProfiles: Record<string, { supportedSubdivisions: string[] }>
    }
    const usState = list.packProfiles['US']!.supportedSubdivisions[0]!
    for (const [label, patch, status, message] of [
      ['GB NINO', { country: 'GB', province: 'ENG', sin: 'QQ123456C' }, 200, null],
      ['GB spaced NINO', { country: 'GB', province: 'ENG', sin: 'QQ 12 34 56 C' }, 200, null],
      ['FR Corsican NIR', { country: 'FR', province: 'FR', sin: '254022A03300522' }, 200, null],
      ['US hyphenated SSN', { country: 'US', province: usState, sin: '123-45-6789' }, 200, null],
      ['stripped NINO digits', { country: 'GB', province: 'ENG', sin: '123456' }, 422, /National Insurance number/],
      ['stripped Corsican NIR', { country: 'FR', province: 'FR', sin: '25402203300522' }, 422, /numéro de sécurité sociale/],
      ['spaced US SSN', { country: 'US', province: usState, sin: '12345 6789' }, 422, /SSN/],
      ['dashed CA SIN', { country: 'CA', province: 'ON', sin: '046-454-286' }, 422, /SIN/],
      // Saves never refuse for a missing identifier — required-ness is the
      // readiness warnings' job — so an omitted key keeps the sealed value.
      ['missing CA SIN keeps', { country: 'CA', province: 'ON' }, 200, null],
    ] as const) {
      const response = await post({ ...base, ...patch })
      assert.equal(response.status, status, `${label}: ${await response.clone().text()}`)
      if (message) assert.match(((await response.json()) as { error: string }).error, message)
    }
    // Nothing was persisted by the refusals: the last accepted value (the
    // hyphenated SSN) is what the row holds, sealed.
    const stored = await withOrgContext(org.orgId, () => db.execute<{ present: boolean; last3: string | null }>(sql`
      select (sin_encrypted is not null) as present, sin_last3 as "last3"
        from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`))
    assert.equal(stored.rows[0]!.present, true)
    assert.equal(stored.rows[0]!.last3, '789')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST saves an identifier-less employee where the pack does not require one', { skip: !DB }, async () => {
  // Quoting a TFN is voluntary, so the AU pack declares its identifier not
  // required: the save succeeds and clears the sealed value.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, payBasis: 'hourly' }
    const seeded = await post({ ...base, country: 'AU', province: 'NSW', sin: '123456782' })
    assert.equal(seeded.status, 200, await seeded.clone().text())
    const cleared = await post({ ...base, country: 'AU', province: 'NSW', sin: '' })
    assert.equal(cleared.status, 200, await cleared.clone().text())
    const stored = await withOrgContext(org.orgId, () => db.execute<{ present: boolean; last3: string | null }>(sql`
      select (sin_encrypted is not null) as present, sin_last3 as "last3"
        from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`))
    assert.equal(stored.rows[0]!.present, false)
    assert.equal(stored.rows[0]!.last3, null)
    // Omitting the key entirely keeps the cleared state and still saves.
    const omitted = await post({ ...base, country: 'AU', province: 'NSW' })
    assert.equal(omitted.status, 200, await omitted.clone().text())
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile GET never echoes the sealed identifier, only its last three', { skip: !DB }, async () => {
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const saved = await post({
      employeePartyId: employeeId, payScheduleId: scheduleId,
      country: 'GB', province: 'ENG', payBasis: 'hourly', sin: 'QQ123456C',
    })
    assert.equal(saved.status, 200, await saved.clone().text())
    const response = await get(`?employee=${employeeId}`)
    assert.equal(response.status, 200, await response.clone().text())
    const body = (await response.json()) as { profile: Record<string, unknown> }
    assert.equal(body.profile['sin_last3'], '56C')
    assert.ok(!('sin' in body.profile), 'the sealed value is never echoed')
    assert.ok(!('sin_encrypted' in body.profile), 'the ciphertext is never echoed')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile GET serves every pack identifier declaration', { skip: !DB }, async () => {
  // The editor labels the sealed field from the pack — NINO, PPSN, NIR —
  // never a hardcoded "SIN / SSN".
  const { org } = await fixture()
  try {
    const body = (await (await get()).json()) as {
      packProfiles: Record<string, {
        identifier: {
          label: string; formatHelp: string; example: string;
          required: boolean; neededFor: string | null; numericEntry: boolean;
        }
      }>
    }
    assert.deepEqual(Object.keys(body.packProfiles), EXPECTED_COUNTRIES)
    for (const [country, profile] of Object.entries(body.packProfiles)) {
      assert.ok(profile.identifier.label.length > 0, `${country} declares an identifier label`)
      assert.ok(profile.identifier.formatHelp.length > 0, `${country} declares an identifier shape`)
      assert.ok(profile.identifier.example.length > 0, `${country} declares an identifier example`)
    }
    assert.equal(body.packProfiles['GB']!.identifier.label, 'National Insurance number')
    assert.equal(body.packProfiles['IE']!.identifier.label, 'PPSN')
    assert.equal(body.packProfiles['IE']!.identifier.neededFor, null)
    assert.equal(body.packProfiles['AU']!.identifier.required, false)
    assert.equal(body.packProfiles['CA']!.identifier.required, true)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST saves the same valid US profile concurrently without a 422', { skip: !DB }, async () => {
  // The reported defect: an intermittent 422 saving a valid US profile. Drive
  // it the way it was reported — many concurrent saves of the same employee,
  // then many concurrent saves across employees — and require every one to
  // succeed. A regression that refuses committed-looking rows under
  // concurrency turns any of these red with the 422 body attached.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const list = (await (await get()).json()) as {
      packProfiles: Record<string, { supportedSubdivisions: string[] }>
    }
    const usState = list.packProfiles['US']!.supportedSubdivisions[0]!
    const body = (id: string, allowances: number) => ({
      employeePartyId: id, payScheduleId: scheduleId,
      country: 'US', province: usState, payBasis: 'hourly',
      sin: '123-45-6789', w4Allowances: allowances,
    })
    const sameEmployee = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post(body(employeeId, i % 100))),
    )
    for (const [i, response] of sameEmployee.entries()) {
      assert.equal(response.status, 200, `same-employee save ${i}: ${await response.clone().text()}`)
    }
    const others: string[] = []
    await withBypassContext(async () => {
      for (let i = 0; i < 5; i++) {
        const id = randomUUID()
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${id}, ${org.orgId}, 'person', ${`Load Hire ${i}`}, true, '{}'::jsonb)`)
        await db.execute(sql`
          insert into employee_roles (id, org_id, party_id, terminated_on)
          values (${randomUUID()}, ${org.orgId}, ${id}, null)`)
        others.push(id)
      }
    })
    const acrossEmployees = await Promise.all(
      others.flatMap((id, ei) =>
        Array.from({ length: 8 }, (_, i) => post(body(id, (ei * 8 + i) % 100)))),
    )
    for (const [i, response] of acrossEmployees.entries()) {
      assert.equal(response.status, 200, `cross-employee save ${i}: ${await response.clone().text()}`)
    }
    const rows = await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*) as count from employee_payroll_profiles where org_id = ${org.orgId}`))
    assert.equal(rows.rows[0]!.count, String(1 + others.length))
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST holds the employee row lock across the scope check and upsert', { skip: !DB }, async () => {
  // The scope comment promises a re-home racing the save cannot slip between
  // the subsidiary check and the write. That holds only while the locking
  // reads and the upsert share one transaction: hold an uncommitted re-home
  // (a plain row update) on a second connection and require the real POST to
  // block on the employee lock rather than sailing through on released locks.
  // It then proceeds to 200 once the contender rolls back — the write is
  // refused-or-validated, never stale.
  const { org, employeeId, scheduleId } = await fixture()
  const holder = await withBypassContext(() => pool.connect())
  assert.ok(holder, 'a second database connection is required to stage the racing re-home')
  try {
    const list = (await (await get()).json()) as {
      packProfiles: Record<string, { supportedSubdivisions: string[] }>
    }
    const usState = list.packProfiles['US']!.supportedSubdivisions[0]!
    // The holder connection carries bypass GUCs from its acquisition above,
    // so this block states the scope the raw queries already run under.
    await withBypassContext(async () => {
      await holder.query('begin')
      await holder.query('update parties set display_name = $1 where id = $2', ['Re-homed Rival', employeeId])
    })
    let settled = false
    const pending = post({
      employeePartyId: employeeId, payScheduleId: scheduleId,
      country: 'US', province: usState, payBasis: 'hourly', sin: '123-45-6789',
    }).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 750))
    assert.equal(
      settled, false,
      'the save must block on the in-flight re-home: its reads hold the employee row to commit',
    )
    await holder.query('rollback')
    const response = await pending
    assert.equal(response.status, 200, await response.clone().text())
    const saved = await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*) as count from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`))
    assert.equal(saved.rows[0]!.count, '1')
  } finally {
    try { await holder.query('rollback') } catch { /* already settled above */ }
    holder.release()
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST validates pack-declared employee facts against the declaration', { skip: !DB }, async () => {
  // 0191 facts: every band and closed set comes from the pack's own
  // certificate declaration, and every refusal names the fact's
  // operator-facing label — never the engine key. An answer for a column
  // the pack does not declare is refused rather than stored where no
  // engine reads it.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, payBasis: 'hourly' }
    for (const [label, patch, status, message] of [
      ['PL birth year', { country: 'PL', province: 'PL', plRokUrodzenia: 1990 }, 200, null],
      ['PL birth year band', { country: 'PL', province: 'PL', plRokUrodzenia: 1850 }, 422, /Birth year \(rok urodzenia\) must be 1900–2026/],
      ['PL birth year unreadable', { country: 'PL', province: 'PL', plRokUrodzenia: 'sometime' }, 422, /Birth year \(rok urodzenia\) must be 1900–2026/],
      ['ES trio', { country: 'ES', province: 'MD', esSituacionLaboral: 'activo', esGrupoCotizacion: 3, esAnoNacimiento: 1990 }, 200, null],
      ['ES grupo band', { country: 'ES', province: 'MD', esSituacionLaboral: 'activo', esGrupoCotizacion: 12, esAnoNacimiento: 1990 }, 422, /Grupo de cotización \(1–11\) must be 1–11/],
      ['ES grupo zero', { country: 'ES', province: 'MD', esSituacionLaboral: 'activo', esGrupoCotizacion: 0, esAnoNacimiento: 1990 }, 422, /Grupo de cotización \(1–11\) must be 1–11/],
      ['ES situacion closed', { country: 'ES', province: 'MD', esSituacionLaboral: 'casado', esGrupoCotizacion: 3, esAnoNacimiento: 1990 }, 422, /Situación laboral \(SITUPER\) must be one of activo, pensionista, desempleado/],
      ['ES ano band', { country: 'ES', province: 'MD', esSituacionLaboral: 'activo', esGrupoCotizacion: 3, esAnoNacimiento: 1850 }, 422, /Año de nacimiento must be 1906–2026/],
      ['ES grupo on a PL profile', { country: 'PL', province: 'PL', plRokUrodzenia: 1990, esGrupoCotizacion: 3 }, 422, /Grupo de cotización \(1–11\) is not declared by the PL payroll pack/],
      ['JP grade and status', { country: 'JP', province: '13', jpHyojunHoshu: 360000, jpKaigoDainigou: 'false' }, 200, null],
      ['JP grade whole yen', { country: 'JP', province: '13', jpHyojunHoshu: -5, jpKaigoDainigou: 'false' }, 422, /must be a whole number at least 0/],
      ['JP kaigo closed', { country: 'JP', province: '13', jpHyojunHoshu: 360000, jpKaigoDainigou: 'yes' }, 422, /must be answered "true" or "false"/],
      ['BR dependentes and pensao', { country: 'BR', province: 'BR', brDependentes: 2, brPensaoMensal: '1500.00' }, 200, null],
      ['BR dependentes floor', { country: 'BR', province: 'BR', brDependentes: -1 }, 422, /Dependentes \(eSocial cadastro\) must be a whole number at least 0/],
      ['BR pensao unreadable', { country: 'BR', province: 'BR', brDependentes: 0, brPensaoMensal: 'abc' }, 422, /Pensão alimentícia mensal \(court-ordered\) must be an amount — "abc" is not a number/],
      ['BR pensao negative', { country: 'BR', province: 'BR', brDependentes: 0, brPensaoMensal: '-5' }, 422, /Pensão alimentícia mensal \(court-ordered\) cannot be negative — got -5/],
    ] as const) {
      const response = await post({ ...base, ...patch })
      assert.equal(response.status, status, `${label}: ${await response.clone().text()}`)
      if (message) {
        const error = ((await response.json()) as { error: string }).error
        assert.match(error, message)
        assert.doesNotMatch(error, /pl_rok_urodzenia|es_grupo_cotizacion|es_situacion_laboral|es_ano_nacimiento|jp_hyojun_hoshu|jp_kaigo_dainigou|br_dependentes|br_pensao_mensal/, `${label} names an engine key`)
      }
    }
    // The last accepted save (BR dependentes 0, pensão refused) leaves the
    // row BR with dependentes 0 — the accepted zero, not a default — and a
    // null pensão. A separate valid BR save proves both columns persist.
    const saved = await post({ ...base, country: 'BR', province: 'BR', brDependentes: 2, brPensaoMensal: '1500.00' })
    assert.equal(saved.status, 200, await saved.clone().text())
    const stored = await withOrgContext(org.orgId, () => db.execute<{ dependentes: number; pensao: string }>(sql`
      select br_dependentes as dependentes, br_pensao_mensal::text as pensao
        from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`))
    assert.deepEqual(stored.rows[0], { dependentes: 2, pensao: '1500.0000' })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST derives the PL birth year from the PESEL and refuses contradictions', { skip: !DB }, async () => {
  // Decided, not re-decided: a declared field, the PESEL deriving and
  // prefilling it, a contradicting saved value refusing naming both — and
  // no PESEL (or an uncited century band) leaving the field to stand
  // alone. The pack's example PESEL 44051401359 encodes 1944.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, payBasis: 'hourly', country: 'PL', province: 'PL' }
    const storedYear = () => withOrgContext(org.orgId, () => db.execute<{ rok: number | null }>(sql`
      select pl_rok_urodzenia as rok from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`)).then((rows) => rows.rows[0]?.rok ?? null)
    // A bare PESEL prefills the blank field at write: 1944, derived.
    const prefilled = await post({ ...base, sin: '44051401359' })
    assert.equal(prefilled.status, 200, await prefilled.clone().text())
    assert.equal(await storedYear(), 1944)
    // The editor sees the derivation before saving: the GET hint carries
    // the value, while the sealed PESEL itself is never echoed.
    const hinted = (await (await get(`?employee=${employeeId}`)).json()) as {
      profile: Record<string, unknown>; derivedProfileColumns?: Record<string, string>;
    }
    assert.equal(hinted.derivedProfileColumns?.['pl_rok_urodzenia'], '1944')
    assert.equal(hinted.profile['pl_rok_urodzenia'], 1944)
    assert.ok(!('sin' in hinted.profile), 'the sealed value is never echoed')
    assert.ok(!('sin_encrypted' in hinted.profile), 'the ciphertext is never echoed')
    // A contradicting year refuses naming both values and both sources.
    const clash = await post({ ...base, sin: '44051401359', plRokUrodzenia: 1990 })
    assert.equal(clash.status, 422, await clash.clone().text())
    const clashError = ((await clash.json()) as { error: string }).error
    assert.match(clashError, /Birth year \(rok urodzenia\) 1990 does not match the PESEL on file, which gives 1944/)
    assert.equal(await storedYear(), 1944)
    // The stored PESEL answers too: omitting the key does not drop the
    // cross-check — the contradiction is against what the save leaves
    // behind, not only what it carries.
    const stale = await post({ ...base, plRokUrodzenia: 1990 })
    assert.equal(stale.status, 422, await stale.clone().text())
    assert.match(((await stale.json()) as { error: string }).error, /which gives 1944/)
    assert.equal(await storedYear(), 1944)
    // An agreeing year saves.
    const agreed = await post({ ...base, sin: '44051401359', plRokUrodzenia: 1944 })
    assert.equal(agreed.status, 200, await agreed.clone().text())
    // Clearing the identifier leaves the declared field to stand alone.
    const cleared = await post({ ...base, sin: '', plRokUrodzenia: 1990 })
    assert.equal(cleared.status, 200, await cleared.clone().text())
    assert.equal(await storedYear(), 1990)
    // An uncited century band derives nothing: month 99 carries no cited
    // century, so the field stands alone and saves unchallenged.
    const uncited = await post({ ...base, sin: '00994101359', plRokUrodzenia: 1990 })
    assert.equal(uncited.status, 200, await uncited.clone().text())
    assert.equal(await storedYear(), 1990)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test.after(async () => { await pool.end() })
