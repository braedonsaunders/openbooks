import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/accounts/[id]/register/route.ts', import.meta.url), 'utf8')

test('account-register PDFs stamp the footer from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToPdf\(data, branding, page, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})
