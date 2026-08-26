import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CI can only gate what it can fail on.
 *
 * GitHub Actions runs `run:` blocks as `bash -e {0}`. `-e` aborts on a failing
 * command but says nothing about pipelines: a pipeline's status is its LAST
 * command's, so `node --test ... | tee log` reports `tee`'s exit code, which is
 * always zero. Run 32905175922 completed green while its coverage job printed
 * `ℹ fail 4`.
 *
 * The second half of that failure was quieter. The coverage job never set
 * OPENBOOKS_TRUSTED_TEST_BYPASS, so every DB-backed integration file threw on
 * import and the job measured a smaller suite than the one it claimed to run —
 * three of those four failures were that, not real defects.
 *
 * These are contract tests over the workflow files themselves, because no
 * product test can observe a gate that never fails.
 */

const WORKFLOW_DIR = '.github/workflows'

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(WORKFLOW_DIR, name))
}

/**
 * Split a workflow into `run:` blocks with their line numbers.
 *
 * Deliberately a line scanner rather than a YAML parse: the property under test
 * is textual (does this shell script arm pipefail before it pipes), and a
 * dependency-free check is one fewer thing that can rot.
 */
function runBlocks(source) {
  const lines = source.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    const opener = /^(\s*)(?:-\s+)?run:\s*(\||>-|>|\|-)?\s*(.*)$/.exec(lines[i])
    if (!opener) continue
    const [, indent, folded, inline] = opener
    if (!folded) {
      if (inline.trim()) blocks.push({ line: i + 1, body: inline })
      continue
    }
    const body = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const text = lines[j]
      if (text.trim() && !text.startsWith(`${indent} `)) break
      body.push(text)
      i = j
    }
    blocks.push({ line: i + 1, body: body.join('\n') })
  }
  return blocks
}

/** Strip comments so a `#`-quoted pipe or `set -o pipefail` cannot fake either side. */
function withoutComments(body) {
  return body
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

/** A shell pipeline, not a YAML block scalar or a `||` fallback. */
function pipesOutput(code) {
  return /[^|>]\|[^|]/.test(code)
}

/**
 * A pipeline followed by `|| fallback` is a deliberate statement that failure is
 * acceptable here, so pipefail is not required — and would be wrong. The
 * coverage summary truncates its own input with `head`, which SIGPIPEs the
 * upstream `sed`; arming pipefail there would fail a step whose only job is to
 * pretty-print a report that has already been recorded.
 */
function toleratesFailure(code) {
  return /\|\|/.test(code)
}

test('every piping workflow step arms pipefail, so a failing command cannot be masked', () => {
  const offenders = []
  for (const file of workflowFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const block of runBlocks(source)) {
      const code = withoutComments(block.body)
      if (!pipesOutput(code)) continue
      if (toleratesFailure(code)) continue
      if (/set\s+-o\s+pipefail|set\s+-[a-z]*e[a-z]*o\s+pipefail|PIPESTATUS/.test(code)) continue
      offenders.push(`${file}:${block.line}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these steps pipe their output without pipefail, so the pipeline reports the LAST command's exit code and a failing build goes green:\n${offenders.join('\n')}`,
  )
})

test('every workflow step that runs the test suite supplies the trusted-bypass contract', () => {
  // Matches what the root `npm test` script and the restore drill already do.
  // A step that runs DB-backed tests without it does not fail loudly — the
  // files throw on import and the job quietly measures a smaller suite.
  const offenders = []
  for (const file of workflowFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const block of runBlocks(source)) {
      const code = withoutComments(block.body)
      if (!/node\s[^\n]*--test\b/.test(code)) continue
      // Only GLOBBED runs are in scope. A glob's membership changes as files
      // are added, which is exactly how the coverage job silently stopped
      // running its DB-backed files; an explicitly named test file is the
      // author's deliberate choice and is proven by the job passing.
      if (!/['"][^'"]*\*/.test(code)) continue
      // `npm test` and `npm run verify:release` carry the contract in the
      // package script, which is asserted separately below.
      if (/npm\s+(run\s+)?test\b|verify:release/.test(code)) continue
      const stepStart = Math.max(0, block.line - 40)
      const context = source.split('\n').slice(stepStart, block.line).join('\n')
      if (/OPENBOOKS_TRUSTED_TEST_BYPASS/.test(context)) continue
      offenders.push(`${file}:${block.line}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these steps run a GLOB of tests without OPENBOOKS_TRUSTED_TEST_BYPASS, so every DB-backed integration file throws on import and the step measures a smaller suite than it reports:\n${offenders.join('\n')}`,
  )
})

/** Quoted glob or path arguments, which is how both commands name their tests. */
function testTargets(command) {
  return new Set([...command.matchAll(/'([^']+\.(?:test\.ts|test\.mjs|test\.ts))'/g)].map((m) => m[1]))
}

test('the coverage job runs at least everything the canonical test command runs', () => {
  // The coverage job called itself the full suite and published an lcov
  // artifact, while its globs omitted web/app, web/components and both script
  // tests — including this file. A failing assertion in any of them left the
  // coverage job green.
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const workflow = readFileSync(join(WORKFLOW_DIR, 'test.yml'), 'utf8')
  const coverageStep = workflow.slice(workflow.indexOf('Test suite with coverage'))
  const canonical = testTargets(scripts.test)
  const covered = testTargets(coverageStep.slice(0, coverageStep.indexOf('- name:', 1)))
  const missing = [...canonical].filter((target) => !covered.has(target))
  assert.deepEqual(
    missing,
    [],
    `the coverage job advertises the full suite but does not run:\n${missing.join('\n')}`,
  )
})

test('the canonical npm test script keeps the trusted-bypass contract it is trusted for', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  assert.match(scripts.test, /OPENBOOKS_TRUSTED_TEST_BYPASS=1/)
  assert.match(scripts.test, /NODE_ENV=test/)
})

test('the integration canary fails on a recorded test failure, not only on a skip', () => {
  // The canary reads its own TAP back to prove the database was reachable. It
  // has to reject `not ok` too, or a genuinely failing integration test passes
  // the skip check and the zero-tests check and reports success.
  const source = readFileSync(join(WORKFLOW_DIR, 'test.yml'), 'utf8')
  assert.match(source, /not ok \\d\+ - /)
})
