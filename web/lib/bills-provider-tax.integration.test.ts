import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// bills.ts is a server-only service; the marker package gates only RSC
// bundling, so shim it to exercise the production service directly.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { computeBillTotalsWithProvider, taxProfileMap } = await import('./bills.ts')
const { saveTaxRateProviderConfig } = await import('@openbooks/engine/src/tax/rate-providers.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { db } = await import('@openbooks/engine/src/platform/db.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return `http://127.0.0.1:${(address as { port: number }).port}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

test('vendor bills ship from the vendor to the receiving entity; invoices ship from the entity to the customer', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  let calls = 0
  let provider: Server | null = null
  const seenBodies: Array<Record<string, unknown>> = []
  try {
    const codeId = randomUUID()
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, recoverable_percent, collected_account_id, paid_account_id, is_active)
      values (${codeId}, ${org.orgId}, 'GST', 'GST', '100', ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`)
    await db.execute(sql`
      insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from)
      values (${randomUUID()}, ${org.orgId}, ${codeId}, '5', ${org.date})`)
    await db.execute(sql`
      insert into addresses (id, org_id, party_id, line1, city, region, postal_code, country, is_default_shipping, is_default_billing)
      values (${randomUUID()}, ${org.orgId}, ${org.vendorId}, '1 Yonge St', 'Toronto', 'ON', 'M5E 1E5', 'CA', true, true)`)
    await db.execute(sql`
      insert into addresses (id, org_id, party_id, line1, city, region, postal_code, country, is_default_shipping, is_default_billing)
      values (${randomUUID()}, ${org.orgId}, ${org.customerId}, '5 King St W', 'Toronto', 'ON', 'M5V 1B2', 'CA', true, true)`)

    provider = createServer(async (req, res) => {
      calls += 1
      seenBodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        taxAmount: '5.0000',
        components: [{ jurisdiction: 'GST', ratePercent: '5.0000', taxAmount: '5.0000' }],
        externalRef: `HOOK-${calls}`,
      }))
    })
    const origin = await listen(provider)
    await saveTaxRateProviderConfig(
      org.orgId,
      {
        provider: 'custom_http', isEnabled: true, preferProvider: true,
        // The stub declares historical support so the fixture-dated documents
        // below quote at all; as-of refusal is covered by its own test.
        settings: { quoteUrl: `${origin}/hook`, jurisdictionTaxCodes: { GST: codeId }, supportsHistoricalDates: true },
      },
      null,
      { allowPrivateEndpoints: true },
    )
    const profiles = await taxProfileMap(org.orgId, org.date)
    const lines = [{ accountId: org.accounts.cogs, amount: '100', taxCodeId: codeId }]

    // A Canadian vendor bill from a Canadian supplier: the provider sees the
    // Canadian vendor as the origin and the Canadian receiving entity as the
    // destination — never an empty side defaulted to the US.
    const bill = await computeBillTotalsWithProvider(lines, profiles, {
      orgId: org.orgId,
      kind: 'vendor_bill',
      currency: 'CAD',
      documentDate: org.date,
      partyId: org.vendorId,
      subsidiaryId: org.subsidiaryId,
      allowPrivateEndpoints: true,
    })
    assert.equal(calls, 1)
    const billRequest = (bill.lines[0] as unknown as { providerQuote: { request: { shipFrom: unknown; shipTo: unknown } } }).providerQuote.request
    assert.deepEqual(billRequest.shipFrom, {
      line1: '1 Yonge St', city: 'Toronto', region: 'ON', postalCode: 'M5E 1E5', country: 'CA',
    })
    assert.deepEqual(billRequest.shipTo, { country: 'CA' })
    assert.equal(bill.lines[0]?.taxAmount, '5.0000')
    assert.equal(bill.lines[0]?.taxComponents[0]?.taxCodeId, codeId)

    // A customer invoice mirrors it: the selling entity ships to the customer.
    const invoice = await computeBillTotalsWithProvider(
      [{ accountId: org.accounts.revenue, amount: '100', taxCodeId: codeId }],
      profiles,
      {
        orgId: org.orgId,
        kind: 'customer_invoice',
        currency: 'CAD',
        documentDate: org.date,
        partyId: org.customerId,
        subsidiaryId: org.subsidiaryId,
        allowPrivateEndpoints: true,
      },
    )
    assert.equal(calls, 2)
    const invoiceRequest = (invoice.lines[0] as unknown as { providerQuote: { request: { shipFrom: unknown; shipTo: unknown } } }).providerQuote.request
    assert.deepEqual(invoiceRequest.shipFrom, { country: 'CA' })
    assert.deepEqual(invoiceRequest.shipTo, {
      line1: '5 King St W', city: 'Toronto', region: 'ON', postalCode: 'M5V 1B2', country: 'CA',
    })

    // No side of any provider request in this flow may carry a US default.
    for (const body of seenBodies) {
      for (const side of [body.shipFrom, body.shipTo]) {
        const values = Object.values((side ?? {}) as Record<string, unknown>)
        assert.ok(!values.includes('US'), `provider request carries a US default: ${JSON.stringify(body)}`)
      }
    }

    // A subsidiary that resolves nowhere refuses before any provider call.
    await assert.rejects(
      computeBillTotalsWithProvider(lines, profiles, {
        orgId: org.orgId,
        kind: 'vendor_bill',
        currency: 'CAD',
        documentDate: org.date,
        partyId: org.vendorId,
        subsidiaryId: randomUUID(),
      }),
      /receiving entity.*no tax address/,
    )
    assert.equal(calls, 2, 'the refused draft must not call the provider')
  } finally {
    if (provider) await close(provider)
    await dropScratchOrg(org.orgId)
  }
})
