import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord, updateSetupRecord, deleteSetupRecord } = await import('./write.ts')
const { businessCalendarFor, businessCalendarOver, BusinessCalendarMissingError, SubsidiaryCalendarMismatchError } = await import('@openbooks/engine/payroll/business-calendars')

async function adminOrg() {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  return { org, asAdmin: { orgId: org.orgId, id: actor as unknown as string, permissions: ['*'] as Iterable<string> } }
}

async function subsidiary(orgId: string, parentId: string, name: string, currency: string, country: string) {
  const id = randomUUID()
  await withBypass(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${id}, ${orgId}, ${parentId}, ${name}, ${currency}, ${country})`))
  return id
}

// The org-wide calendar governs weekends, resolved pack days and company
// closures at once: US Independence Day 2026 falls on a Saturday, so Friday
// July 3rd is a holiday, Saturday is the weekend, Monday July 6th is the
// company's own closure, and Tuesday is a business day.
const CALENDAR = {
  weekStartsOn: '1',
  weekendDays: [6, 7],
  holidayCountry: 'US',
  holidayRegion: 'FEDERAL',
  effectiveFrom: '2026-01-01',
  isActive: true,
}

/** Driver error text lives on the cause chain, not the wrapper message. */
function pgRefusalText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  while (current instanceof Error && parts.length < 4) {
    parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join('\n')
}

/** A company closure recorded where closures live: payroll_holidays. */
async function recordCompanyClosure(orgId: string, jurisdiction: string, name: string, observedOn: string) {
  await withBypass(() => db.execute(sql`
    insert into payroll_holidays (id, org_id, jurisdiction, pack_key, name, rule_kind, observed_on, effective_from)
    values (${randomUUID()}, ${orgId}, ${jurisdiction}, null, ${name}, 'date', ${observedOn}::date, '2026-01-01')`))
}

test('org-wide calendar governs weekends, closures and statutory days', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const created = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', CALENDAR))
    assert.equal(created.status, 200)
    await recordCompanyClosure(org.orgId, 'US', 'Founder day', '2026-07-06')

    const calendar = await businessCalendarFor(org.orgId, null, '2026-07-01')
    assert.equal(calendar.weekStartsOn, 1)
    assert.equal(calendar.jurisdiction, 'US')
    assert.ok(calendar.isHoliday('2026-07-03'), 'observed Independence Day')
    assert.ok(!calendar.isBusinessDay('2026-07-04'), 'Saturday weekend')
    assert.ok(!calendar.isBusinessDay('2026-07-06'), 'company closure')
    assert.ok(calendar.isBusinessDay('2026-07-07'))
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// A Friday/Saturday subsidiary override wins inside its window and ends
// cleanly: May still reads the org-wide calendar, July reads the override,
// and closing the override hands July back to the org-wide week.
test('a subsidiary override governs inside its window, then ends', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    assert.equal((await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', CALENDAR))).status, 200)
    const subsidiaryId = await subsidiary(org.orgId, org.subsidiaryId, 'Gulf Co', 'USD', 'US')
    const override = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      subsidiaryId, weekStartsOn: '6', weekendDays: [5, 6], effectiveFrom: '2026-06-01', isActive: true,
    }))
    assert.equal(override.status, 200)
    const overrideId = String((override.body as { id: string }).id)

    const may = await businessCalendarFor(org.orgId, subsidiaryId, '2026-05-08')
    assert.equal(may.weekStartsOn, 1, 'May still reads the org-wide calendar')
    assert.ok(may.isBusinessDay('2026-05-08'), 'May Friday is an org-wide business day')

    const sub = await businessCalendarFor(org.orgId, subsidiaryId, '2026-07-10')
    assert.equal(sub.weekStartsOn, 6)
    assert.ok(!sub.isBusinessDay('2026-07-10'), 'Friday is the subsidiary weekend')
    assert.ok(sub.isBusinessDay('2026-07-12'), 'Sunday is a subsidiary business day')
    const orgWide = await businessCalendarFor(org.orgId, null, '2026-07-10')
    assert.ok(orgWide.isBusinessDay('2026-07-10'), 'Friday is an org-wide business day')

    assert.equal((await withBypass(() => updateSetupRecord(asAdmin, 'business-calendars', { id: overrideId, effectiveTo: '2026-06-30' }))).status, 200)
    const range = await businessCalendarOver(org.orgId, subsidiaryId, '2026-06-29', '2026-07-03')
    assert.equal(range.day('2026-06-30').weekStartsOn, 6)
    assert.ok(range.day('2026-06-30').isBusinessDay, 'June 30th is a Tuesday under the override')
    assert.equal(range.day('2026-07-01').weekStartsOn, 1, 'July falls back to the org-wide week')
    assert.ok(range.day('2026-07-03').isHoliday, 'observed Independence Day under the fallback')
    assert.throws(() => range.day('2026-07-04'), RangeError)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// An override starting later in the same week answers from the override: the
// single-date view resolves each date from its governing version, never the
// whole week from the selection date's row. Sunday July 5th works the new
// weekend (the old row would rest it) and Friday July 3rd carries no holiday
// (the old row would observe Independence Day).
test('a later override answers mid-week dates from the override', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    assert.equal((await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', CALENDAR))).status, 200)
    const subsidiaryId = await subsidiary(org.orgId, org.subsidiaryId, 'Gulf Co', 'USD', 'US')
    const override = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      subsidiaryId, weekStartsOn: '6', weekendDays: [5, 6], effectiveFrom: '2026-07-02', isActive: true,
    }))
    assert.equal(override.status, 200)

    const sub = await businessCalendarFor(org.orgId, subsidiaryId, '2026-06-29')
    assert.equal(sub.weekStartsOn, 1, 'the fields describe the selection date’s version')
    assert.equal(sub.jurisdiction, 'US')
    assert.ok(sub.isBusinessDay('2026-07-05'), 'Sunday answers from the override starting mid-week')
    assert.ok(!sub.isHoliday('2026-07-03'), 'the override names no country, so no holiday applies')
    assert.throws(() => sub.isBusinessDay('2026-07-07'), RangeError)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// The drawer sends the whole form on every save: unchanged content in every
// normalization (number 1 vs '1', JSON text vs array, null vs missing) still
// closes the window, while a changed fact refuses with the new-version remedy.
test('a full-form save that changes nothing closes the window', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const created = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', CALENDAR))
    assert.equal(created.status, 200)
    const id = String((created.body as { id: string }).id)
    const closed = await withBypass(() => updateSetupRecord(asAdmin, 'business-calendars', {
      id, weekStartsOn: 1, weekendDays: '[6, 7]', subsidiaryId: null,
      holidayCountry: 'US', holidayRegion: 'FEDERAL', effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30', isActive: true,
    }))
    assert.equal(closed.status, 200)

    const rewritten = await withBypass(() => updateSetupRecord(asAdmin, 'business-calendars', {
      id, weekStartsOn: '1', weekendDays: [6, 7], subsidiaryId: null,
      holidayCountry: 'US', holidayRegion: 'FEDERAL', effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30', isActive: true,
    }))
    assert.equal(rewritten.status, 200, 'array content matches the stored row just as JSON text does')

    const moved = await withBypass(() => updateSetupRecord(asAdmin, 'business-calendars', {
      id, weekStartsOn: '6', weekendDays: [6, 7], subsidiaryId: null,
      holidayCountry: 'US', holidayRegion: 'FEDERAL', effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30', isActive: true,
    }))
    assert.equal(moved.status, 400)
    assert.match(String((moved.body as { error?: string }).error ?? ''), /immutable/)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// A version names one country's holidays: filing US holidays against a GB
// subsidiary refuses at save, and an org-wide US row read for that
// subsidiary refuses by name — never priced by the wrong state's table.
test('a subsidiary calendar must match the subsidiary’s country', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    assert.equal((await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', CALENDAR))).status, 200)
    const subsidiaryId = await subsidiary(org.orgId, org.subsidiaryId, 'Bristol Co', 'GBP', 'GB')

    const mismatched = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      subsidiaryId, weekStartsOn: '1', weekendDays: [6, 7], holidayCountry: 'US', holidayRegion: 'FEDERAL',
      effectiveFrom: '2026-01-01', isActive: true,
    }))
    assert.equal(mismatched.status, 400)
    assert.match(String((mismatched.body as { error?: string }).error ?? ''), /domiciled in GB/)

    const weekendsOnly = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      subsidiaryId, weekStartsOn: '1', weekendDays: [6, 7], effectiveFrom: '2026-01-01', isActive: true,
    }))
    assert.equal(weekendsOnly.status, 200, 'no country names no holidays, so nothing can mismatch')

    await assert.rejects(
      businessCalendarFor(org.orgId, subsidiaryId, '2026-07-01'),
      (error: unknown) => {
        assert.ok(error instanceof SubsidiaryCalendarMismatchError)
        assert.match(error.message, /Bristol Co/)
        assert.match(error.message, /domiciled in GB/)
        assert.match(error.message, /US holidays/)
        assert.doesNotMatch(error.message, /[0-9a-f]{8}-[0-9a-f]{4}/)
        return true
      },
    )
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// An overlapping calendar in the same scope 409s with the remedy instead of
// echoing the Postgres exclusion text; closing the window first makes the
// adjacent window save. Deletes stay refused: versions deactivate, never
// cascade away.
test('overlapping calendar windows conflict typed with the remedy', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const first = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', CALENDAR))
    assert.equal(first.status, 200)
    const firstId = String((first.body as { id: string }).id)
    const retry = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, effectiveFrom: '2026-06-01',
    }))
    assert.equal(retry.status, 409)
    assert.equal((retry.body as { code?: string }).code, 'overlap')
    assert.match(String((retry.body as { error?: string }).error ?? ''), /effective-to/)
    assert.doesNotMatch(String((retry.body as { error?: string }).error ?? ''), /exclusion|conflicting key|SQLSTATE|gist/i)

    const deleted = await withBypass(() => deleteSetupRecord(asAdmin, 'business-calendars', firstId))
    assert.equal(deleted.status, 405)

    // Closing the first window first makes the adjacent window save: the
    // refusal above is about the overlap, never a blanket ban.
    const closed = await withBypass(() => updateSetupRecord(asAdmin, 'business-calendars', { id: firstId, effectiveTo: '2026-06-30' }))
    assert.equal(closed.status, 200)
    const adjacent = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31',
    }))
    assert.equal(adjacent.status, 200)

    // Rewriting a version's facts is refused with the new-version remedy.
    const rewritten = await withBypass(() => updateSetupRecord(asAdmin, 'business-calendars', { id: firstId, weekStartsOn: '6' }))
    assert.equal(rewritten.status, 400)
    assert.match(String((rewritten.body as { error?: string }).error ?? ''), /immutable/)

    // The database guard backstops the API: direct rewrites and deletes
    // refuse with the same history message.
    await assert.rejects(
      withBypass(() => db.execute(sql`update org_business_calendars set week_starts_on = 6 where id = ${firstId}`)),
      (error: unknown) => {
        assert.match(pgRefusalText(error), /immutable/)
        return true
      },
    )
    await assert.rejects(
      withBypass(() => db.execute(sql`delete from org_business_calendars where id = ${firstId}`)),
      (error: unknown) => {
        assert.match(pgRefusalText(error), /history is preserved/)
        return true
      },
    )
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// The two versions name different jurisdictions, so neither a resolver
// ignoring effective dating nor one leaking closures across versions can
// pass: July answers from CA-ON, where the US closure does not apply and the
// Ontario closure does, while a date no version covers refuses by name.
test('effective windows select the version per date', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const first = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30',
    }))
    assert.equal(first.status, 200)
    const second = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      weekStartsOn: '6', weekendDays: [5, 6], holidayCountry: 'CA', holidayRegion: 'ON',
      effectiveFrom: '2026-07-01', isActive: true,
    }))
    assert.equal(second.status, 200)
    await recordCompanyClosure(org.orgId, 'US', 'Founder day', '2026-07-06')
    await recordCompanyClosure(org.orgId, 'CA-ON', 'Fête provinciale', '2026-07-07')

    const june = await businessCalendarFor(org.orgId, null, '2026-06-05')
    assert.equal(june.weekStartsOn, 1)
    assert.ok(june.isBusinessDay('2026-06-05'), 'June Friday works the org weekend')
    assert.throws(() => june.isBusinessDay('2026-07-05'), RangeError)

    const range = await businessCalendarOver(org.orgId, null, '2026-06-29', '2026-07-07')
    assert.equal(range.day('2026-06-30').weekStartsOn, 1)
    assert.ok(range.day('2026-06-30').isBusinessDay)
    assert.equal(range.day('2026-07-03').weekStartsOn, 6)
    assert.ok(!range.day('2026-07-03').isBusinessDay, 'July Friday keeps the new weekend')
    assert.ok(!range.day('2026-07-06').isHoliday, 'the US closure does not leak into the CA-ON version')
    assert.ok(range.day('2026-07-06').isBusinessDay, 'July Monday works the new weekend')
    assert.ok(range.day('2026-07-07').isHoliday, 'the Ontario closure applies in its version')
    assert.ok(range.day('2026-07-05').isBusinessDay, 'July Sunday works the new weekend')

    await assert.rejects(
      businessCalendarOver(org.orgId, null, '2025-06-30', '2026-07-01'),
      (error: unknown) => {
        assert.ok(error instanceof BusinessCalendarMissingError)
        assert.match(String((error as Error).message), /Setup → Company → Business calendars/)
        return true
      },
    )
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// Regions select their employment calendar: Saint-Jean-Baptiste (June 24th)
// closes Quebec and not Ontario.
test('a region resolves its own employment calendar', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const ontario = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      weekStartsOn: '1', weekendDays: [6, 7], holidayCountry: 'CA', holidayRegion: 'ON',
      effectiveFrom: '2026-01-01', isActive: true,
    }))
    assert.equal(ontario.status, 200)
    const subsidiaryId = await subsidiary(org.orgId, org.subsidiaryId, 'Montreal Co', 'CAD', 'CA')
    const quebec = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      subsidiaryId, weekStartsOn: '1', weekendDays: [6, 7], holidayCountry: 'CA', holidayRegion: 'QC',
      effectiveFrom: '2026-01-01', isActive: true,
    }))
    assert.equal(quebec.status, 200)

    const on = await businessCalendarFor(org.orgId, null, '2026-06-24')
    assert.equal(on.jurisdiction, 'CA-ON')
    assert.ok(on.isBusinessDay('2026-06-24'), 'June 24th works in Ontario')
    const qc = await businessCalendarFor(org.orgId, subsidiaryId, '2026-06-24')
    assert.equal(qc.jurisdiction, 'CA-QC')
    assert.ok(qc.isHoliday('2026-06-24'), 'Saint-Jean-Baptiste closes Quebec')
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// Shape violations refuse with the remedy before the table ever sees them.
test('calendar shape violations refuse with the remedy', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['seven-day weekend', { ...CALENDAR, weekendDays: [1, 2, 3, 4, 5, 6, 7] }, /business day/],
      ['eighth weekday', { ...CALENDAR, weekendDays: [6, 8] }, /ISO weekdays/],
      ['non-select week start', { ...CALENDAR, weekStartsOn: '9' }, /starts the week/],
      ['lowercase country', { ...CALENDAR, holidayCountry: 'us' }, /capitals/],
      ['region without country', { ...CALENDAR, holidayCountry: '', holidayRegion: 'ON' }, /country/],
    ]
    for (const [name, body, pattern] of cases) {
      const attempt = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', body))
      assert.equal(attempt.status, 400, name)
      assert.match(String((attempt.body as { error?: string }).error ?? ''), pattern, name)
    }
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// Coverage refusals name the working remedy: a pack-less country refuses
// plainly (no remedy that does not work), an untranscribed pack names its
// closures, and a federal calendar beside regional ones requires its region
// — while the FEDERAL qualifier saves.
test('calendar coverage refusals name the working remedy', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const packless = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, holidayCountry: 'AE',
    }))
    assert.equal(packless.status, 400)
    const packlessError = String((packless.body as { error?: string }).error ?? '')
    assert.match(packlessError, /company closures for AE are not available yet/)
    assert.doesNotMatch(packlessError, /record closures in Setup/)

    const untranscribed = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, holidayCountry: 'DE', holidayRegion: 'BY',
    }))
    assert.equal(untranscribed.status, 400)
    assert.match(String((untranscribed.body as { error?: string }).error ?? ''), /"DE-BY"'s statutory holiday calendar is not transcribed yet/)

    const bareRegion = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, holidayCountry: 'CA', holidayRegion: '',
    }))
    assert.equal(bareRegion.status, 400)
    assert.match(String((bareRegion.body as { error?: string }).error ?? ''), /holiday region/)

    const fullKey = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, holidayCountry: 'CA', holidayRegion: 'CA-ON',
    }))
    assert.equal(fullKey.status, 400)
    assert.match(String((fullKey.body as { error?: string }).error ?? ''), /CA-CA-ON/)

    const federal = await withBypass(() => createSetupRecord(asAdmin, 'business-calendars', {
      ...CALENDAR, holidayCountry: 'CA', holidayRegion: 'FEDERAL',
    }))
    assert.equal(federal.status, 200)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// Company closures file under every declared pack calendar, not just the
// CA/US pair the old picker predated: a Bavarian closure saves, and a key no
// pack declares is refused by the write path.
test('company closures file under any declared pack calendar', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const closure = await withBypass(() => createSetupRecord(asAdmin, 'payroll-holidays', {
      jurisdiction: 'DE-BY', effectiveFrom: '2026-01-01', name: 'Betriebsruhe',
      ruleKind: 'date', observedOn: '2026-12-24',
    }))
    assert.equal(closure.status, 200)

    const undeclared = await withBypass(() => createSetupRecord(asAdmin, 'payroll-holidays', {
      jurisdiction: 'XX', effectiveFrom: '2026-01-01', name: 'Nowhere day',
      ruleKind: 'date', observedOn: '2026-12-24',
    }))
    assert.equal(undeclared.status, 400)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})
