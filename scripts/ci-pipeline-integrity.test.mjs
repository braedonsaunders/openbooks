import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_EXPLICIT_ANY, measuredExplicitAnys } from './check-explicit-any.mjs'
import { auditRegister, BASELINE, REGISTER, scopeBaselineToRegister } from './check-register-reachability.mjs'

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

/**
 * The last half of the ratchet problem.
 *
 * Both soft ceilings (`MAX_EXPLICIT_ANY` in check-explicit-any.mjs and
 * `--max-warnings=` in the `lint` script) sat motionless through 231 commits
 * while the real counts moved underneath them. A ceiling far above reality is
 * not a ratchet: the gate stays green while hundreds of new violations land,
 * then reports health it never measured. Raising a limit is a one-character
 * edit, so contract tests are what stop it — no product test can observe a
 * gate whose number simply got bigger instead of smaller.
 */

test('the explicit-any limit is not above the anys actually in the tree', () => {
  // Measured live by the same walk the gate runs, so editing MAX_EXPLICIT_ANY
  // upward fails here exactly like adding an `any` fails the gate itself: the
  // only honest state is that the limit equals the count, and code fixes — not
  // edits to the constant — are what let the count (and with it the limit) fall.
  const measured = measuredExplicitAnys().total
  assert.ok(
    MAX_EXPLICIT_ANY <= measured,
    `MAX_EXPLICIT_ANY is ${MAX_EXPLICIT_ANY} but this tree measures ${measured} explicit ` +
      `anys. A ceiling above the real count gates nothing; tighten the limit to ${measured} ` +
      `(or fix fewer). Model to copy: scripts/check-credential-fetch-redirects.mjs ships an empty baseline.`,
  )
})

test('the lint warning ceiling is not above the warnings eslint actually emits', () => {
  // Spawns the exact `npm run lint` command CI runs rather than re-deriving
  // eslint's config in parallel — a second counting path would drift the same
  // way the stale limits did.
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const limitMatch = /--max-warnings=(\d+)/.exec(scripts.lint)
  assert.ok(limitMatch, `the lint script carries no measurable --max-warnings ceiling:\n${scripts.lint}`)

  let output = ''
  try {
    output = execFileSync('npm', ['run', 'lint', '--silent'], { encoding: 'utf8' })
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
    assert.fail(`npm run lint itself failed before the ceiling could be compared (${error.status})`)
  }
  const summary = /✖\s+\d+\s+problems\s+\((\d+) errors?, (\d+) warnings?\)/.exec(output)
  const measured = summary ? Number(summary[2]) : 0

  assert.ok(
    Number(limitMatch[1]) <= measured,
    `--max-warnings=${limitMatch[1]} exceeds the ${measured} warnings eslint actually emits. ` +
      'A ceiling above the real count gates nothing; set it back to the measured total.',
  )
})

/**
 * The register trusts the closing report; nothing checked the tree. A finding
 * recorded fixed from a worker branch that was never merged overstated what
 * had actually shipped — a launch decision from the register alone would have
 * shipped a recorded-as-fixed segregation-of-duties bypass believing it was
 * closed. check-register-reachability.mjs is the tree-side half, but it audits
 * campaign orchestration state and therefore stays a deliberate standalone
 * command rather than a permanent product gate.
 */

test('the campaign checker stays standalone and is excluded from canonical npm test', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  assert.match(
    scripts['check:register-reachability'] ?? '',
    /check-register-reachability\.mjs$/,
    'the campaign checker must remain available for deliberate live-register audits',
  )
  assert.doesNotMatch(
    scripts.test,
    /check:register-reachability/,
    'campaign orchestration state must not be a permanent product shipping gate',
  )
})

test('the embedded register names every closing ref as a commit token or nothing', () => {
  for (const [id, ref] of REGISTER) {
    assert.ok(
      ref === null || /^[0-9a-f]{7,40}$/.test(ref),
      `${id}: closing ref must be a commit token or null, got ${JSON.stringify(ref)}`,
    )
  }
  const knownClasses = new Set(['unreachable', 'unresolvable', 'unattributed'])
  for (const [id, baselineClass] of BASELINE) {
    assert.ok(knownClasses.has(baselineClass), `${id}: unknown baseline class ${baselineClass}`)
    assert.ok(REGISTER.has(id), `${id}: baseline entry names no register entry`)
  }
})

test('a live campaign cohort scopes historical baseline rows to its own findings', () => {
  const liveRegister = new Map([
    ['fnd_mt6g89d5_7irug4', null],
    ['fnd_live_only', null],
  ])
  const scoped = scopeBaselineToRegister(liveRegister, new Map([
    ['fnd_mt6g89d5_7irug4', 'unattributed'],
    ['fnd_other_campaign', 'unreachable'],
  ]))
  assert.deepEqual([...scoped], [['fnd_mt6g89d5_7irug4', 'unattributed']])
})

test('register reachability fails new drift, publishes baselined gaps, and rejects a stale baseline', () => {
  const ancestor = '3333333333333333333333333333333333333333'
  const register = new Map([
    ['fnd_new_drift', '1111111111111111111111111111111111111111'],
    ['fnd_published_gap', '2222222222222222222222222222222222222222'],
    ['fnd_now_reachable', ancestor],
    ['fnd_never_attributed', null],
    ['fnd_object_gone', '4444444444444444444444444444444444444444'],
  ])
  const baseline = new Map([
    ['fnd_published_gap', 'unreachable'],
    ['fnd_now_reachable', 'unreachable'],
  ])
  const result = auditRegister({
    register,
    baseline,
    resolveRef: (ref) => (ref === '4444444444444444444444444444444444444444' ? null : ref),
    isAncestor: (sha) => sha === ancestor,
  })
  assert.deepEqual(
    result.newDrift.map((entry) => entry.id).sort(),
    ['fnd_never_attributed', 'fnd_new_drift', 'fnd_object_gone'],
    'new drift (unmerged fix, missing attribution, vanished commit) must fail the gate',
  )
  assert.deepEqual(
    result.knownGaps.map((entry) => entry.id),
    ['fnd_published_gap'],
    'a baselined gap is reported as published backlog, not a violation',
  )
  assert.deepEqual(
    result.staleBaseline.map((entry) => entry.id),
    ['fnd_now_reachable'],
    'a baseline entry whose fix reached main must be removed, or the backlog rots into amnesty',
  )
  assert.deepEqual(
    result.classDrift.map((entry) => entry.id),
    [],
    'no class drift in this fixture',
  )
})

/**
 * The golden-harness gate.
 *
 * Three consecutive audit rounds closed financial blockers while introducing
 * new ledger defects at par: the FX residual that landed in a tax box and the
 * widened variance-account hole were both INTRODUCED BY FIXES, and fix safety
 * on the financial edit path did not improve across any of them. The gate that
 * catches this class of break already exists — a seeded company driven through
 * real activity by the business simulation, then the golden harness asserting
 * the trial balance and the subledger↔GL and inventory tie-outs — but nothing
 * bound that gate to the merge decision. trust.yml runs the harness, yet a
 * pull request merges on the checks in test.yml, so a fix could merge with the
 * harness red, or with the harness quietly dropped.
 *
 * So the requirement is pinned here, in the same contract suite that pins CI
 * membership: any change to a financial edit path merges only through CI, and
 * CI must run the golden harness — on a ledger carrying real sim activity,
 * inside the same job as the full test suite, failing the job. A fix that
 * breaks a ledger invariant must fail before merge, not at the next audit.
 */

const GOLDEN_HARNESS = /npm\s+--prefix\s+engine\s+run\s+--silent\s+harness\b/
const SIM_PROVISION = /sim\s+--\s+provision\b/
const SIM_RUN = /sim\s+--\s+run\b/
const SCHEMA_BOOTSTRAP = /scripts\/bootstrap\.ts/

/** Slice a workflow from a top-level `key:` to the next top-level key. */
function topLevelBlock(source, key) {
  const start = source.indexOf(`\n  ${key}:`)
  if (start === -1) return ''
  // Exactly two spaces of indent: `\n  ` alone also matches every deeper key.
  const next = source.slice(start + 1).search(/\n {2}(?=\S)/)
  return next === -1 ? source : source.slice(start, start + 1 + next)
}

/** The `- name:` step a command lives in, so step-level neutering is visible. */
function stepAround(source, needle) {
  const at = source.indexOf(needle)
  const start = source.lastIndexOf('\n      - ', at)
  const end = source.indexOf('\n      - ', at)
  return source.slice(start, end === -1 ? undefined : end)
}

test('the merge-gating workflow runs the golden harness, after real activity, in the full-suite job', () => {
  // test.yml is the workflow pull requests actually merge against, so this is
  // where "runs the golden harness as part of its check command" has to hold.
  const source = readFileSync(join(WORKFLOW_DIR, 'test.yml'), 'utf8')
  const blocks = runBlocks(source)

  const harness = blocks.filter((b) => GOLDEN_HARNESS.test(withoutComments(b.body)))
  assert.equal(
    harness.length,
    1,
    'the merge gate must run the golden harness exactly once; it is missing, duplicated, or renamed',
  )
  const harnessCode = withoutComments(harness[0].body)
  assert.ok(
    !toleratesFailure(harnessCode),
    'a `||` fallback on the harness invocation is a statement that ledger invariants may fail here',
  )
  assert.match(
    stepAround(source, harnessCode.trim().split('\n')[0]),
    /manifest\.json/,
    'the harness must run on the org the simulation provisioned (read from its manifest), not the pristine bootstrap tenant where every tie-out passes vacuously',
  )
  assert.ok(
    !/continue-on-error/.test(stepAround(source, harnessCode.trim().split('\n')[0])),
    'the harness step must not be advisory: continue-on-error converts the gate into a footnote',
  )

  // A harness over an untouched org proves nothing, so the simulation that
  // drives real activity must run first, in order, with the schema loaded
  // before either of them.
  const provision = blocks.filter((b) => SIM_PROVISION.test(withoutComments(b.body)))
  const simRun = blocks.filter((b) => SIM_RUN.test(withoutComments(b.body)))
  const bootstraps = blocks.filter((b) => SCHEMA_BOOTSTRAP.test(withoutComments(b.body)))
  assert.equal(provision.length, 1, 'the merge gate must drive the seeded company exactly once')
  assert.equal(simRun.length, 1, 'the simulation must actually run the provisioned company, not only provision it')
  assert.ok(
    bootstraps.some((b) => b.line < provision[0].line),
    'the schema must be bootstrapped before the simulation can provision anything',
  )
  assert.ok(
    provision[0].line <= simRun[0].line && simRun[0].line < harness[0].line,
    'ordering is the invariant: provision activity → run it → assert the ledger invariants',
  )

  // The simulation refuses to run without its explicit opt-in; pin it so the
  // activity step cannot be silently disarmed by an env tidy-up.
  const integration = topLevelBlock(source, 'integration')
  assert.match(integration, /OPENBOOKS_SIM:\s*"1"/, 'the sim opt-in interlock must be set for the activity step')

  // "as part of its check command": the harness rides in the same job as the
  // full database-backed suite, so one green check covers both.
  assert.ok(integration.includes('run: npm test'), 'this contract pins the integration job, the one that runs the full suite')
  assert.ok(
    integration.includes(harnessCode.trim().split('\n')[0]),
    'the golden harness must run in the same job as the full suite, not in a workflow merges do not wait for',
  )

  // The gate only blocks merges while the workflow fires on pull requests.
  const on = source.slice(source.indexOf('\non:'), source.indexOf('\njobs:'))
  assert.match(on, /pull_request:/, 'test.yml must keep its pull_request trigger or the gate gates nothing')
})

test('the trust workflow keeps running the golden harness on pull requests too', () => {
  // Defense in depth: trust.yml's invariants job is the original harness run
  // and the source of the published evidence corpus. Dropping it — or its
  // pull_request trigger — must fail here just like dropping the merge-gate
  // copy above.
  const source = readFileSync(join(WORKFLOW_DIR, 'trust.yml'), 'utf8')
  const on = source.slice(source.indexOf('\non:'), source.indexOf('\njobs:'))
  assert.match(on, /pull_request:/, 'trust.yml must keep its pull_request trigger')

  const blocks = runBlocks(source)
  const harness = blocks.filter((b) => GOLDEN_HARNESS.test(withoutComments(b.body)))
  assert.equal(harness.length, 1, 'trust.yml must keep running the golden harness exactly once')
  assert.ok(
    !toleratesFailure(withoutComments(harness[0].body)),
    'the evidence pipeline must not tolerate a failed harness invocation',
  )
  const provision = blocks.find((b) => SIM_PROVISION.test(withoutComments(b.body)))
  assert.ok(provision, 'trust.yml must keep driving real activity before asserting invariants')
  assert.ok(provision.line < harness[0].line, 'the harness must run after the simulation, not before it')
})

test('a live campaign invocation remains strict and emits machine-readable irreducible rows', () => {
  const env = { ...process.env, OPENBOOKS_REGISTER_JSON: JSON.stringify({ findings: [{ id: 'fnd_live_gap', status: 'fixed' }] }) }
  delete env.OPENBOOKS_REGISTER_DB
  delete env.OPENBOOKS_REGISTER_THREAD_ID

  assert.throws(
    () => execFileSync('npm', ['run', 'check:register-reachability', '--silent'], { encoding: 'utf8', env }),
    (error) => {
      const output = String(error.stdout ?? '') + String(error.stderr ?? '')
      assert.equal(error.status, 1, 'an unattributed live row must fail the standalone campaign command')
      const marker = 'IRREDUCIBLE_REGISTER_ROWS_JSON='
      const json = output.slice(output.indexOf(marker) + marker.length).trim()
      const report = JSON.parse(json)
      assert.deepEqual(report.categoryCounts, { unattributed: 1 })
      assert.deepEqual(report.rows.map((row) => ({ id: row.id, category: row.category })), [
        { id: 'fnd_live_gap', category: 'unattributed' },
      ])
      return true
    },
  )
})

test('malformed or empty live campaign input fails closed before any tree check', () => {
  for (const value of ['not-json', JSON.stringify({ findings: [] })]) {
    const env = { ...process.env, OPENBOOKS_REGISTER_JSON: value }
    delete env.OPENBOOKS_REGISTER_DB
    delete env.OPENBOOKS_REGISTER_THREAD_ID
    assert.throws(
      () => execFileSync('node', ['scripts/check-register-reachability.mjs'], { encoding: 'utf8', env }),
      (error) => {
        assert.equal(error.status, 1)
        assert.match(String(error.stdout ?? '') + String(error.stderr ?? ''), /FAIL: cannot load OPENBOOKS_REGISTER_JSON/)
        return true
      },
    )
  }
})
