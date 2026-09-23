import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '@/lib/auth'

// TR2 regression (DB partition): with a CAD root and a USD subsidiary both
// taxable, prepare can freeze one legal entity's return — CAD-only and
// USD-only filings, each with its registration pinned. The stored scope,
// registration and translation are exactly what was requested, a re-preview
// with the same scope matches the frozen snapshot, and the scoped filings
// mark filed (the mark-filed recompute replays the frozen posture instead of
// the org-wide default, which would refuse as mixed-currency).

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __taxFilingScopeUser: state })
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (
      (specifier === './auth' || specifier.endsWith('/lib/auth')) &&
      context.parentURL?.endsWith('/web/lib/authz.ts')
    ) {
      return virtual('export async function currentUser(){ return globalThis.__taxFilingScopeUser.user }')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const routeUrl = './route.ts?prepare-scope'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { computeTaxReturn } = await import('@openbooks/engine/src/tax-returns/return.ts')
const { markTaxFilingFiled } = await import('@openbooks/engine/src/tax-returns/filing.ts')
const { postDocument } = await import('@openbooks/engine/src/ledger/posting-document.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

async function createUsdSubsidiary(org: ScratchOrg): Promise<string> {
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('USD', 'US Dollar', 2)
    on conflict (code) do nothing`)
  const id = randomUUID()
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'US Ops', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
  await db.execute(sql`
    insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
    select gen_random_uuid(), ${org.orgId}, p.id, ${id}
      from parties p
     where p.org_id = ${org.orgId} and p.kind in ('customer', 'vendor')
    on conflict do nothing`)
  return id
}

async function makeTaxCode(org: ScratchOrg, code: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into tax_codes
      (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
    values (${id}, ${org.orgId}, ${code}, ${code}, 'both', 'standard',
            ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`)
  return id
}

async function seedInvoice(
  org: ScratchOrg,
  opts: { subsidiaryId: string; number: string; taxCodeId: string; amount: string; taxAmount: string; currency: string },
): Promise<void> {
  const documentId = randomUUID()
  const lineId = randomUUID()
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', ${opts.number}, ${opts.subsidiaryId},
              ${org.customerId}, ${org.date}, ${org.date},
              ${opts.currency}, '1', ${opts.amount}, ${opts.taxAmount}, ${(Number(opts.amount) + Number(opts.taxAmount)).toFixed(4)})`)
    await tx.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, ${opts.amount},
              ${opts.amount}, ${opts.taxAmount}, ${opts.taxCodeId}, '1', ${opts.amount})`)
    await tx.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, withholding_account_id, overridden)
      values (${org.orgId}, ${lineId}, ${opts.taxCodeId}, 1, '10', ${opts.amount}, ${opts.taxAmount},
              ${opts.taxAmount}, '0.0000', 'standard', false, false, 2, ${org.accounts.taxOutput},
              null, null, false)`)
    await tx.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`)
  })
  await postDocument(documentId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  })
}

const prepare = (body: unknown) =>
  POST(
    new Request('http://openbooks.test/api/tax/filings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

type FilingRow = {
  id: string
  period_from: string
  period_to: string
  version: number
  functional_currency: string | null
  presentation_currency: string | null
  translation: { presentationCurrency: string } | null
  subsidiary_ids: string[] | null
  registration_id: string | null
  registration_number: string | null
  boxes: { lineCode: string; value: string }[]
}

async function readFiling(orgId: string, id: string): Promise<FilingRow> {
  return (await db.execute<FilingRow>(sql`
    select id, period_from::text, period_to::text, version,
           functional_currency, presentation_currency, translation, subsidiary_ids,
           registration_id, registration_number, boxes
      from tax_filings where org_id = ${orgId} and id = ${id}`)).rows[0]!
}

test('prepare freezes one entity return per scope, and scoped filings mark filed', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const usSub = await withBypassContext(() => createUsdSubsidiary(org))
  try {
    const cadCode = await withBypassContext(() => makeTaxCode(org, 'CAD-TAX'))
    const usCode = await withBypassContext(() => makeTaxCode(org, 'US-TAX'))
    await withBypassContext(() => seedInvoice(org, {
      subsidiaryId: org.subsidiaryId, number: 'INV-CAD', taxCodeId: cadCode,
      amount: '200.0000', taxAmount: '20.0000', currency: 'CAD',
    }))
    await withBypassContext(() => seedInvoice(org, {
      subsidiaryId: usSub, number: 'INV-USD', taxCodeId: usCode,
      amount: '1000.0000', taxAmount: '100.0000', currency: 'USD',
    }))
    const formCode = 'ENTITY-SCOPE'
    const regCad = randomUUID()
    const regUs = randomUUID()
    await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, 'Tax filer', 'tax_filer')
      state.user = {
        id: actor,
        orgId: org.orgId,
        name: 'Tax filer',
        email: 'filer@scratch.test',
        roles: [],
        isSuperAdmin: false,
        envKind: 'production',
        productionOrgId: org.orgId,
        homeOrgId: org.orgId,
        homeUserId: actor,
      }
      await db.execute(sql`
        update app_roles set permissions = '["compliance.file"]'::jsonb, subsidiary_restriction = '{"mode":"all"}'::jsonb
         where org_id = ${org.orgId} and key = 'tax_filer'`)
      await db.execute(sql`
        insert into tax_return_forms (org_id, code, name, submission_channel, is_active)
        values (${org.orgId}, ${formCode}, 'Entity-scoped return', 'portal_manual', true)`)
      for (const [lineCode, taxCodeId, basis, sign, sequence] of [
        ['BASE', cadCode, 'taxable_base', 1, 10],
        ['BASE', usCode, 'taxable_base', 1, 11],
        ['TAX', cadCode, 'tax_collected', -1, 20],
        ['TAX', usCode, 'tax_collected', -1, 21],
      ] as const) {
        await db.execute(sql`
          insert into tax_report_lines
            (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
          values (${randomUUID()}, ${org.orgId}, ${formCode}, ${lineCode}, ${lineCode},
                  ${taxCodeId}, ${basis}, ${sign}, ${sequence})`)
      }
      for (const [regId, number] of [[regCad, 'CAD-REG-1'], [regUs, 'USD-REG-1']] as const) {
        const jurisdictionId = randomUUID()
        await db.execute(sql`
          insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type, is_active)
          values (${jurisdictionId}, ${org.orgId}, ${number}, ${number}, 'ZZ', 'country', 'vat', true)`)
        await db.execute(sql`
          insert into tax_registrations
            (id, org_id, jurisdiction_id, registration_number, filing_frequency, return_form_code, is_active)
          values (${regId}, ${org.orgId}, ${jurisdictionId}, ${number}, 'quarterly', ${formCode}, true)`)
      }
    })

    await withOrgContext(org.orgId, async () => {
      // Two same-form registrations match the window, so the org-wide prepare
      // refuses as ambiguous instead of freezing one of them silently.
      const ambiguous = await prepare({ code: formCode, from: org.date, to: org.date })
      assert.equal(ambiguous.status, 422)
      assert.match(((await ambiguous.json()) as { error: string }).error, /has 2 registrations/)

      // CAD-only filing with its registration pinned.
      const cad = await prepare({
        code: formCode, from: org.date, to: org.date,
        filingEntity: { subsidiaryIds: [org.subsidiaryId], registrationId: regCad },
      })
      assert.equal(cad.status, 201, JSON.stringify(await cad.clone().json()))
      const cadBody = (await cad.json()) as { id: string }
      const cadRow = await readFiling(org.orgId, cadBody.id)
      assert.deepEqual(cadRow.subsidiary_ids, [org.subsidiaryId])
      assert.equal(cadRow.registration_id, regCad)
      assert.equal(cadRow.registration_number, 'CAD-REG-1')
      assert.equal(cadRow.functional_currency, 'CAD')
      assert.equal(cadRow.presentation_currency, null)
      assert.equal(cadRow.translation, null)
      assert.deepEqual(
        cadRow.boxes.map((b) => [b.lineCode, b.value]),
        [['BASE', '200.0000'], ['TAX', '20.0000']],
      )
      // A re-preview with the same scope reproduces the frozen snapshot.
      const cadPreview = await computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
        filingEntity: { subsidiaryIds: [org.subsidiaryId], registrationId: regCad },
      })
      assert.deepEqual(
        cadPreview.boxes.map((b) => [b.lineCode, b.value]),
        cadRow.boxes.map((b) => [b.lineCode, b.value]),
      )

      // USD-only filing with its registration pinned and an explicit
      // presentation currency; the stored translation is what was requested.
      const usd = await prepare({
        code: formCode, from: org.date, to: org.date,
        filingEntity: { subsidiaryIds: [usSub], registrationId: regUs },
        translation: { presentationCurrency: 'USD' },
      })
      assert.equal(usd.status, 201, JSON.stringify(await usd.clone().json()))
      const usdBody = (await usd.json()) as { id: string }
      const usdRow = await readFiling(org.orgId, usdBody.id)
      assert.deepEqual(usdRow.subsidiary_ids, [usSub])
      assert.equal(usdRow.registration_id, regUs)
      assert.equal(usdRow.registration_number, 'USD-REG-1')
      assert.equal(usdRow.functional_currency, 'USD')
      assert.equal(usdRow.presentation_currency, 'USD')
      assert.equal(usdRow.translation?.presentationCurrency, 'USD')
      assert.deepEqual(
        usdRow.boxes.map((b) => [b.lineCode, b.value]),
        [['BASE', '1000.0000'], ['TAX', '100.0000']],
      )
      const usdPreview = await computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
        filingEntity: { subsidiaryIds: [usSub], registrationId: regUs },
        translation: { presentationCurrency: 'USD' },
      })
      assert.deepEqual(
        usdPreview.boxes.map((b) => [b.lineCode, b.value]),
        usdRow.boxes.map((b) => [b.lineCode, b.value]),
      )

      // Both scoped filings certify once the covered period is closed: the
      // mark-filed recompute replays each filing's frozen posture.
      await db.execute(sql`
        insert into period_locks (id, org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
        values (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl',
                'closed', now(), 'test: governed close'),
               (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'tax',
                'closed', now(), 'test: governed close')`)
      const filedCad = await markTaxFilingFiled(org.orgId, cadBody.id, state.user!.id, 'GOV-CAD-1')
      assert.equal(filedCad.id, cadBody.id)
      const filedUsd = await markTaxFilingFiled(org.orgId, usdBody.id, state.user!.id, 'GOV-USD-1')
      assert.equal(filedUsd.id, usdBody.id)
      assert.equal((await readFiling(org.orgId, cadBody.id)).boxes.length, 2)
    })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
