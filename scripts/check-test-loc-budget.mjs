#!/usr/bin/env node
/**
 * Repo-wide ratchet on the SIZE of the test corpus.
 *
 * The corpus reached ~670k non-blank lines by 2026-09-24, +365k of them in
 * one week, mostly one new regression file per fixed finding. The owner's
 * directive: fewer, higher-quality tests. This check counts the non-blank lines of every
 * tracked test file and fails when the total exceeds the ceiling recorded in
 * scripts/test-loc-budget.json. The ceiling only goes down: pruning lowers
 * it, and a change that adds test lines must delete at least as many
 * elsewhere (dead, duplicate, source-pinning, or mock-only tests).
 *
 *   node scripts/check-test-loc-budget.mjs           check
 *   node scripts/check-test-loc-budget.mjs --lower[=N]  lower the ceiling to
 *     the current total plus N lines of headroom (default 0), never raising
 *     it. Maintainers lower it with a small headroom after each pruning
 *     batch, so a fix's regression check fits without the corpus regrowing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const BUDGET = 'scripts/test-loc-budget.json'
const TEST_FILE = /(^|\/)e2e\/|\.(test|spec)\.(ts|tsx|mjs|js|cjs)$/

export function testLines(files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')) {
  let total = 0
  for (const file of files) {
    if (!TEST_FILE.test(file) || file.includes('node_modules/') || !existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) total++
  }
  return total
}

const budget = JSON.parse(readFileSync(BUDGET, 'utf8'))
const total = testLines()
const lower = process.argv.find((arg) => arg === '--lower' || arg.startsWith('--lower='))
if (lower) {
  const target = total + Number(lower.split('=')[1] ?? 0)
  if (target < budget.ceiling) {
    budget.ceiling = target
    writeFileSync(BUDGET, JSON.stringify(budget, null, 2) + '\n')
    console.log(`lowered test-line ceiling to ${target} (total ${total})`)
  }
} else {
  console.log(`checked test lines; total=${total} ceiling=${budget.ceiling}`)
  if (total > budget.ceiling) {
    console.error(`test corpus is ${total - budget.ceiling} non-blank lines over its ceiling (${BUDGET}). ` +
      'Delete at least that many dead, duplicate, source-pinning or mock-only test lines; the ceiling never rises.')
    process.exitCode = 1
  }
}
