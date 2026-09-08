import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_EXPLICIT_ANY, measuredExplicitAnys } from './check-explicit-any.mjs'

/**
 * CI can only gate what it can fail on.
 *
 * GitHub Actions runs `run:` blocks as `bash -e {0}`. `-e` aborts on a failing
 * command but says nothing about pipelines: a pipeline's status is its LAST
 * command's, so `node --test ... | tee log` reports `tee`'s exit code, which is
 * always zero. A job written that way reports green while printing failures.
 *
 * The quieter half of the same class is a job that measures a smaller suite
 * than the one it claims to run — omit OPENBOOKS_TRUSTED_TEST_BYPASS and every
 * DB-backed file throws on import instead of being exercised.
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
 * Split a run block into shell commands, joining backslash-continued lines.
 *
 * A fallback only excuses the pipeline in its own command. Keeping command
 * boundaries here prevents a summary command such as `... || echo ...` from
 * excusing an unrelated pipeline later in the same YAML block.
 */
function shellCommands(code) {
  const commands = []
  let continued = ''

  for (const line of code.split('\n')) {
    const text = line.trim()
    if (!text) continue

    const continues = /\\\s*$/.test(text)
    const part = text.replace(/\\\s*$/, '')
    continued = continued ? `${continued} ${part}` : part
    if (continues) continue

    commands.push(...splitShellCommands(continued))
    continued = ''
  }

  if (continued) commands.push(...splitShellCommands(continued))
  return commands
}

/** Split at command separators without treating quoted shell snippets as code. */
function splitShellCommands(code) {
  const commands = []
  let command = ''
  let quote = null
  let escaped = false

  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]
    if (escaped) {
      command += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      command += char
      escaped = true
      continue
    }
    if (quote) {
      command += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      command += char
      quote = char
      continue
    }
    if (char === ';' || (char === '&' && code[i + 1] === '&')) {
      if (command.trim()) commands.push(command.trim())
      command = ''
      if (char === '&') i += 1
      continue
    }
    command += char
  }

  if (command.trim()) commands.push(command.trim())
  return commands
}

/** Whether this one shell command deliberately handles its pipeline failure. */
function commandToleratesFailure(code) {
  let quote = null
  let escaped = false
  for (let i = 0; i < code.length - 1; i += 1) {
    const char = code[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '|' && code[i + 1] === '|') return true
  }
  return false
}

/**
 * A pipeline followed by `|| fallback` is a deliberate statement that failure is
 * acceptable here, so pipefail is not required — and would be wrong. The
 * coverage summary truncates its own input with `head`, which SIGPIPEs the
 * upstream `sed`; arming pipefail there would fail a step whose only job is to
 * pretty-print a report that has already been recorded. A block only tolerates
 * failure when every pipeline in it makes that statement.
 */
function toleratesFailure(code) {
  const pipelines = shellCommands(code).filter((command) => pipesOutput(command))
  return pipelines.length > 0 && pipelines.every((command) => commandToleratesFailure(command))
}

function unprotectedPipelines(code) {
  return shellCommands(code).filter((command) => pipesOutput(command) && !commandToleratesFailure(command))
}

test('every piping workflow step arms pipefail, so a failing command cannot be masked', () => {
  const offenders = []
  for (const file of workflowFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const block of runBlocks(source)) {
      const code = withoutComments(block.body)
      if (unprotectedPipelines(code).length === 0) continue
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

test('an allowed fallback does not excuse an unrelated failing pipeline in the same run block', () => {
  const code = withoutComments(`
    test -f report.txt || echo "no report produced"
    false | tee test-output.log
  `)

  assert.equal(toleratesFailure(code), false, 'a mixed block is not wholly tolerated by one unrelated fallback')
  assert.deepEqual(
    unprotectedPipelines(code),
    ['false | tee test-output.log'],
    'the fallback belongs only to its own command; the failing producer pipeline still requires pipefail',
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


test('the coverage run executes the canonical test command, not a parallel glob list', () => {
  // This job used to maintain its own copy of the test globs, drifted from the
  // canonical list, and published an lcov artifact for a suite it had not run.
  // Coverage is now produced by the same `npm test` invocation that gates the
  // merge, so the two cannot diverge by construction. Assert exactly that.
  const workflow = readFileSync(join(WORKFLOW_DIR, 'test.yml'), 'utf8')
  const blocks = runBlocks(workflow)
  const covering = blocks.filter((b) => /--experimental-test-coverage/.test(withoutComments(b.body)))
  assert.equal(
    covering.length,
    1,
    'exactly one step must produce coverage; it is missing or duplicated',
  )
  const body = withoutComments(covering[0].body)
  assert.match(
    body,
    /npm test\b/,
    'the coverage step must run the canonical `npm test` script so its membership cannot drift from the merge gate',
  )
  assert.ok(
    !/engine\/src\/\*\*|web\/\*\*|packages\/\*\*/.test(body),
    'the coverage step must not re-specify test globs; that is the drift this test exists to prevent',
  )
  assert.match(
    body,
    /--test-reporter=lcov/,
    'the coverage step must still emit lcov',
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
 * The golden-harness gate.
 *
 * A change to a financial edit path can satisfy every unit test and still break
 * a ledger invariant — an FX residual landing in a tax box, or a widened
 * variance-account hole. The gate that catches that class already exists: a
 * seeded company driven through real activity by the business simulation, then
 * the golden harness asserting the trial balance and the subledger↔GL and
 * inventory tie-outs. What was missing was binding it to the merge decision.
 * trust.yml runs the harness, yet a pull request merges on the checks in
 * test.yml, so a fix could merge with the harness red or quietly dropped.
 *
 * So the requirement is pinned here, in the same contract suite that pins CI
 * membership: CI must run the golden harness on a ledger carrying real sim
 * activity, inside the same job as the full test suite, failing the job. A
 * change that breaks a ledger invariant fails before merge.
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

test('every step that invokes the sim CLI arms its OPENBOOKS_SIM interlock', () => {
  // engine/src/sim/db-guard.ts refuses to run without OPENBOOKS_SIM=1 for
  // EVERY subcommand, including read-only ones like `coverage`. A step that
  // invokes the CLI without the flag therefore fails on the interlock and
  // never reports on what it was meant to gate. That is exactly how folding
  // sim-smoke.yml's coverage gate into test.yml broke it: sim-smoke set the
  // flag job-wide, and the fold carried the command but not the environment.
  for (const file of readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith('.yml'))) {
    const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
    for (const block of runBlocks(source)) {
      const code = withoutComments(block.body)
      if (!/\bsim\s+--\s/.test(code)) continue
      // Anchor on the sim line itself, not the block's first line: several
      // blocks open with `set -o pipefail`, and stepAround resolves by first
      // match, so a shared opening line points at the wrong step.
      const step = stepAround(source, code.split('\n').find((entry) => /\bsim\s+--\s/.test(entry)))
      assert.match(
        step,
        /OPENBOOKS_SIM:\s*["']?1/,
        `${file}: a step invoking the sim CLI must set OPENBOOKS_SIM=1, or it fails on the interlock instead of on its gate`,
      )
    }
  }
})

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
  // Match the invocation, not a literal `run: npm test` line: the step is a
  // block scalar now because it also emits lcov, and pinning the exact text
  // made an unrelated formatting change look like a removed test run.
  assert.match(
    integration,
    /\bnpm test\b/,
    'this contract pins the integration job, the one that runs the full suite',
  )
  assert.ok(
    integration.includes(harnessCode.trim().split('\n')[0]),
    'the golden harness must run in the same job as the full suite, not in a workflow merges do not wait for',
  )

  // The gate only blocks merges while the workflow fires on pull requests.
  const on = source.slice(source.indexOf('\non:'), source.indexOf('\njobs:'))
  assert.match(on, /pull_request:/, 'test.yml must keep its pull_request trigger or the gate gates nothing')
})

test('the trust workflow consumes the checkpoint but never produces simulation evidence', () => {
  // Sole producer, sole consumer: test.yml owns the checkpoint, trust.yml
  // consumes it via workflow_run and must never run a simulation of its own.
  // A consumer that silently becomes a second producer would publish evidence
  // from a run nothing gated, and would do so without turning anything red.
  const source = readFileSync(join(WORKFLOW_DIR, 'trust.yml'), 'utf8')
  const on = source.slice(source.indexOf('\non:'), source.indexOf('\njobs:'))
  assert.match(on, /pull_request:/, 'trust.yml must keep its pull_request trigger')
  assert.match(
    withoutComments(on),
    /workflow_run:/,
    'trust.yml must stay bound to test.yml completion via workflow_run',
  )

  const blocks = runBlocks(source)
  const harness = blocks.filter((b) => GOLDEN_HARNESS.test(withoutComments(b.body)))
  assert.equal(
    harness.length,
    0,
    'trust.yml must run the golden harness zero times: test.yml integration is the sole producer',
  )
  const provision = blocks.find((b) => SIM_PROVISION.test(withoutComments(b.body)))
  assert.equal(
    provision,
    undefined,
    'trust.yml must not provision simulation companies: the checkpoint arrives from test.yml',
  )

  // The consumer wiring itself is pinned: publish must download the
  // checkpoint from the triggering test run (run-id), not from thin air, and
  // must stamp the corpus with that run's SHA rather than its own checkout.
  const publishBlock = topLevelBlock(source, 'publish')
  assert.match(
    publishBlock,
    /run-id:\s*\$\{\{\s*github\.event\.workflow_run\.id\s*\}\}/,
    'trust publish must download the checkpoint from the triggering test run by run-id',
  )
  assert.match(
    publishBlock,
    /workflow_run\.head_sha/,
    'trust publish must attribute the corpus to the tested commit, not its own checkout',
  )
})

test('the release job does not re-run the suite, and fails closed without a green merge gate', () => {
  // The suite ran ~35 minutes inside publish-container's verify job to
  // reproduce a result test.yml had already produced for the same commit
  // minutes earlier. Removing that is only sound while the substitute is
  // enforced, so this pins BOTH halves: the job must not run the suite, and
  // it must verify a successful `test` run for the exact SHA it releases.
  const publish = readFileSync(join(WORKFLOW_DIR, 'publish-container.yml'), 'utf8')
  const verify = topLevelBlock(publish.slice(publish.indexOf('\njobs:')), 'verify')

  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  assert.doesNotMatch(
    scripts['verify:release'],
    /npm test\b/,
    'verify:release must not run the suite; the merge gate proves it for this commit',
  )
  assert.match(
    scripts['verify:release:full'],
    /npm test\b/,
    'verify:release:full must retain the suite so a full local verification is still available',
  )

  const gate = stepAround(verify, 'actions/runs?head_sha=')
  assert.match(gate, /select\(\.name == "test"\)/, 'the gate must look for the merge-gate workflow by name')
  assert.match(gate, /head_sha=\$\{SOURCE_COMMIT\}/, 'the gate must be scoped to the exact commit being released')
  assert.match(gate, /exit 1/, 'the gate must fail closed when no green run exists')
  assert.ok(
    !/continue-on-error/.test(gate),
    'an advisory merge-gate check would let an unverified commit be released',
  )
})

test('jobs running the suite retain complete local history', () => {
  // Parts of the suite inspect the repository's own history — the history
  // rewrite tooling and the hygiene checks both shell out to git. A depth-1
  // checkout leaves them nothing to read, so they degrade into passes that
  // assert nothing. Cover every workflow that reaches the suite, whichever
  // script name it arrives by.
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const scriptsRunningSuite = Object.keys(scripts).filter((name) => /npm test\b/.test(scripts[name]))
  const SUITE_ENTRYPOINTS = new RegExp(
    ['npm (?:run )?test(?![:\\w-])', ...scriptsRunningSuite.map((name) => `npm run ${name}\\b`)].join('|'),
  )
  for (const file of readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith('.yml'))) {
    const workflow = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
    const jobsAt = workflow.indexOf('\njobs:')
    if (jobsAt === -1) continue
    const jobNames = [...workflow.slice(jobsAt).matchAll(/\n {2}([A-Za-z0-9_-]+):\n/g)].map((m) => m[1])
    for (const jobName of jobNames) {
      const job = topLevelBlock(workflow.slice(jobsAt), jobName)
      if (!SUITE_ENTRYPOINTS.test(withoutComments(job))) continue
      assert.match(
        job,
        /fetch-depth:\s*0/,
        `${file}:${jobName} runs the suite, so its checkout needs fetch-depth: 0`,
      )
    }
  }
})

test('the release job proves the commit it releases is on main', () => {
  // The release gate answers one question — is this pinned commit an ancestor
  // of main — and it needs two things the default checkout does not provide.
  // Full history, because ancestry cannot be computed from a depth-1 clone;
  // and a materialized local `main`, because checking out an explicit ref
  // leaves HEAD detached with no branch to compare against. Without either,
  // the gate cannot fail and silently stops gating.
  const publish = readFileSync(join(WORKFLOW_DIR, 'publish-container.yml'), 'utf8')
  const verify = topLevelBlock(publish.slice(publish.indexOf('\njobs:')), 'verify')

  assert.match(verify, /fetch-depth:\s*0/, 'ancestry cannot be computed from a shallow checkout')
  assert.match(
    verify,
    /refs\/heads\/main:refs\/heads\/main/,
    'a detached pinned-ref checkout must materialize local main before comparing against it',
  )
  assert.match(
    verify,
    /merge-base --is-ancestor/,
    'the release must refuse a commit that is not on main',
  )
})
