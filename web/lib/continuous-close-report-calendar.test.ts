import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/continuous-close/reports/[runId]/pdf/route.ts', import.meta.url), 'utf8')

test('continuous-close report PDFs stamp the footer from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(gate\.user\.orgId\)[\s\S]*?exportDataToPdf\(data, branding, layout, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})
