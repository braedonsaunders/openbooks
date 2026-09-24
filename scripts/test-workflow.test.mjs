import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/test.yml', import.meta.url),
  'utf8',
)

function occurrenceCount(source, value) {
  return source.split(value).length - 1
}

function namedStep(name) {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `workflow must contain the ${name} step`)
  const next = workflow.indexOf('\n      - ', start + marker.length)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

function topLevelJob(name) {
  const marker = `\n  ${name}:\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `workflow must contain the ${name} job`)
  const next = workflow.slice(start + marker.length).search(/\n  (?=\S)/)
  return workflow.slice(start, next === -1 ? workflow.length : start + marker.length + next)
}

test('units, database shards and simulation run independently without omitted test partitions', () => {
  const unit = topLevelJob('unit')
  const integration = topLevelJob('database')
  const simulation = topLevelJob('simulation')
  // The INNER timeout must stay strictly below the job timeout. It fires first,
  // so `tee unit.txt` still produces an artifact and the shard exits 124 — a
  // diagnosable failure. If the JOB timeout wins instead, the runner is killed
  // with no output and the only evidence is "the job timed out".
  // Raised 12m -> 16m (job 16 -> 20) after shard 5 hit the 12m wall on
  // 30f3f660d while shards 1-4 finished in 3m44s-6m06s. That spread is
  // IMBALANCE, not growth. Shards are now a plain round robin (the committed
  // timing record was removed), so the budget keeps headroom for the spread.
  assert.match(unit, /timeout --signal=TERM --kill-after=10s 16m npm run test:unit/)
  assert.match(unit, /timeout-minutes: 20/)
  assert.match(unit, /apt-get install -y qpdf/)
  // Pinned together so the matrix and the denominator cannot drift apart.
  // Raised 4 -> 5 when shard 2 hit the 8m wall on tip-of-main: the passing
  // shards ran 297s/403s/445s against a 480s budget, so shard 4 was at 93%
  // and the packing was already even to 3s. The partition had outgrown four
  // shards rather than been packed badly.
  assert.match(unit, /shard: \[1, 2, 3, 4, 5\]/)
  assert.match(unit, /OPENBOOKS_TEST_SHARD: \$\{\{ matrix.shard \}\}\/5/)
  // THIRD place the shard count lives: the receipt check in the integration
  // job counts evidence directories. Widening the matrix to 5 without this
  // left it expecting 4 and the run failed on "Verify every test file ran
  // exactly once" — after the two assertions above were already green, so
  // the guard reported the change complete when it was two-thirds done.
  // Pinned here so all three move together or none do.
  assert.match(namedStep('Verify every test file ran exactly once'), /\['unit',\s*5,/)
  assert.match(namedStep('Verify every test file ran exactly once'), /\['integration',\s*16,/)
  assert.match(integration, /npm run test:integration/)
  assert.doesNotMatch(integration, /npm test\b|npm run test:unit/)
  assert.match(integration, /shard: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/)
  assert.match(integration, /OPENBOOKS_TEST_SHARD: \$\{\{ matrix.shard \}\}\/16/)
  assert.match(integration, /fail-fast: false/)
  // Pinned so the budget is a decision rather than a drift. Raised 15 -> 25
  // when the payroll and tax packs landed: shards 11 and 16 were cancelled
  // mid fixture-pool reset at ~15m while still making progress.
  assert.match(integration, /timeout-minutes: 25/)
  assert.doesNotMatch(integration, /--test-concurrency|continue-on-error/)
  assert.match(integration, /name: coverage-\$\{\{ matrix.shard \}\}/)
  assert.match(integration, /COLLECT_COVERAGE:.*github.event_name == 'workflow_dispatch'/)
  assert.match(simulation, /sim -- run/)
  assert.match(simulation, /harness --/)
  assert.match(simulation, /services:/)
})

test('browser suites fan out and claim every workflow spec exactly once', () => {
  // The browser tests were one serial ~24-minute job and were the pipeline's
  // critical path on their own; every other partition finished inside 16
  // minutes. Pinned so the fan-out stays a decision rather than drift.
  const app = topLevelJob('e2e-app')
  assert.match(app, /shard: \[1, 2, 3\]/)
  assert.match(app, /--project app --shard=\$\{\{ matrix.shard \}\}\/3/)
  assert.match(app, /fail-fast: false/)

  const workflows = topLevelJob('e2e-workflows')
  assert.match(workflows, /fail-fast: false/)
  assert.doesNotMatch(namedStep('Playwright app suite'), /continue-on-error/)
  assert.doesNotMatch(namedStep('Playwright workflow suites'), /continue-on-error/)

  // The matrix is the only thing deciding which workflow suites run at all, so
  // a typo here would drop a suite silently and still green the job — the same
  // failure shape as a database test misfiled into the unit partition.
  // Compare the declared matrix against what is actually on disk.
  const declared = [...workflows.matchAll(/^\s+suites: "([^"]+)"$/gm)].flatMap(([, value]) => value.split(' '))
  const specs = declared.map((pair) => pair.split(':')[0])
  const databases = declared.map((pair) => pair.split(':')[1])
  assert.ok(specs.length > 0, 'workflow matrix must declare its suites')
  assert.equal(new Set(specs).size, specs.length, 'no workflow spec may be claimed twice')
  assert.equal(
    new Set(databases).size,
    databases.length,
    'every workflow suite needs its own pristine database; the suites are not order-independent',
  )

  // A spec may also be claimed by a DISPATCH-ONLY workflow instead of the
  // gating matrix: the payroll browser walk is the longest suite in the
  // repository and runs on demand rather than on every commit. That is a
  // deliberate decision, not drift — but "runs on demand" and "runs nowhere"
  // look identical from the matrix alone, so the claim has to be counted from
  // both places or this guard would pass while a suite quietly stopped
  // running. Parsed from the dispatch workflow's own `suites` input default,
  // never hardcoded here: that input exists so more packs can be added without
  // editing CI, and a literal in this test would go stale the first time
  // somebody uses it.
  const dispatchWorkflows = readdirSync(new URL('../.github/workflows', import.meta.url))
    .filter((entry) => entry.endsWith('.yml') && entry !== 'test.yml')
    .map((entry) => ({
      file: entry,
      source: readFileSync(new URL(`../.github/workflows/${entry}`, import.meta.url), 'utf8'),
    }))
    .filter(({ source }) => /^on:\s*\n\s+workflow_dispatch:/m.test(source))

  const dispatchClaims = []
  for (const { file, source } of dispatchWorkflows) {
    // Scope to the trigger block so a `suites:` env elsewhere cannot be read as
    // a claim, then take the default of the `suites` input.
    const triggers = source.slice(source.indexOf('on:'), source.indexOf('\njobs:'))
    const suites = /suites:\s*\n(?:[^\n]*\n)*?\s*default:\s*"([^"]+)"/.exec(triggers)
    if (!suites) continue
    // A dispatch workflow must not also be a gate; otherwise "on demand" is a
    // fiction and the suite is back on every push under another name.
    assert.doesNotMatch(
      triggers,
      /\n\s+(push|pull_request):/,
      `${file} claims suites on workflow_dispatch, so it must not also trigger on push or pull_request`,
    )
    for (const pair of suites[1].split(' ')) dispatchClaims.push({ file, pair })
  }

  const dispatchSpecs = dispatchClaims.map(({ pair }) => pair.split(':')[0])
  const dispatchDatabases = dispatchClaims.map(({ pair }) => pair.split(':')[1])
  assert.equal(
    new Set(dispatchDatabases).size,
    dispatchDatabases.length,
    'every dispatch suite needs its own pristine database too',
  )

  const claimed = [...specs, ...dispatchSpecs]
  assert.equal(
    new Set(claimed).size,
    claimed.length,
    'a spec claimed by the gating matrix must not also be claimed by a dispatch workflow',
  )

  const onDisk = readdirSync(new URL('../e2e/workflows', import.meta.url))
    .filter((entry) => entry.endsWith('.spec.ts'))
    .map((entry) => entry.replace(/\.spec\.ts$/, ''))
    .sort()
  assert.deepEqual(
    [...claimed].sort(),
    onDisk,
    'every e2e/workflows spec must be claimed exactly once, either by a test.yml matrix group '
      + `(currently: ${[...specs].sort().join(', ')}) or by a workflow_dispatch workflow's suites input `
      + `(currently: ${dispatchClaims.map(({ file, pair }) => `${pair} in ${file}`).join(', ') || 'none'})`,
  )
})

test('test workflow propagates tee producer failures and retains its failure guards', (t) => {
  const pipelines = [
    { stepName: 'Integration canary', logFile: 'canary.tap' },
    { stepName: 'Database test shard', logFile: 'coverage.txt' },
  ]
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-test-workflow-'))
  t.after(() => rmSync(tempDirectory, { recursive: true, force: true }))

  for (const { stepName, logFile } of pipelines) {
    const step = namedStep(stepName)
    const pipefail = 'set -o pipefail'
    const loggingPipeline = `2>&1 | tee ${logFile}`
    assert.match(step, /^\s{8}shell: bash$/m, `${stepName} must select bash explicitly`)
    assert.ok(step.includes(pipefail), `${stepName} must arm pipefail`)
    assert.ok(step.includes(loggingPipeline), `${stepName} must retain its tee logging pipeline`)
    assert.ok(
      step.indexOf(pipefail) < step.indexOf(loggingPipeline),
      `${stepName} must arm pipefail before starting the logging pipeline`,
    )

    const failingProducer = [
      pipefail,
      `${JSON.stringify(process.execPath)} -e 'console.log("deliberate producer failure"); process.exit(23)' ${loggingPipeline}`,
    ].join('\n')
    const failure = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-c', failingProducer],
      { cwd: tempDirectory, encoding: 'utf8' },
    )
    assert.notEqual(
      failure.status,
      0,
      `${stepName} must propagate a deliberate producer failure through tee`,
    )
    assert.match(
      readFileSync(join(tempDirectory, logFile), 'utf8'),
      /deliberate producer failure/,
      `${stepName} must still capture producer output`,
    )

    const successfulProducer = [
      pipefail,
      `${JSON.stringify(process.execPath)} -e 'console.log("successful producer")' ${loggingPipeline}`,
    ].join('\n')
    const success = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-c', successfulProducer],
      { cwd: tempDirectory, encoding: 'utf8' },
    )
    assert.equal(success.status, 0, `${stepName} must still accept a successful producer`)
  }

  const canary = namedStep('Integration canary')
  for (const assertion of [
    '/# SKIP(?:\\s|$)/im.test(s)',
    '/^not ok \\d+ - /m.test(s)',
    '!/^# fail 0$/m.test(s)',
    '!/^ok \\d+ - /m.test(s)',
  ]) {
    assert.ok(canary.includes(assertion), `integration canary must retain ${assertion}`)
  }

  const bypass = 'OPENBOOKS_TRUSTED_TEST_BYPASS: "1"'
  const restoreDrill = namedStep('Export, destroy, restore, and verify an isolated backup')
  assert.equal(
    occurrenceCount(workflow, bypass),
    1,
    'trusted test bypass must be limited to the restore drill step that imports its guard',
  )
  assert.equal(occurrenceCount(restoreDrill, bypass), 1)
})

test('the restore drill provisions the owned ephemeral fixture marker', () => {
  // Scratch-org fixtures fail closed without the database-side nonce, so a
  // restore drill without the marker step trips the interlock instead of
  // rehearsing anything. The drill owns its throwaway service database, so
  // it stamps the same authorization every other database job uses.
  const job = topLevelJob('restore-drill')
  assert.match(
    job,
    /- name: Mark database as the owned ephemeral fixture/,
    'restore-drill must stamp the owned ephemeral fixture marker before the drill',
  )
  assert.match(
    job,
    /OPENBOOKS_TEST_DB_MARKER=\$MARKER/,
    'restore-drill must export the marker to the drill step, not just stamp the catalog',
  )
  assert.doesNotMatch(
    job,
    /OPENBOOKS_TEST_ALLOW_UNMARKED_DB/,
    'restore-drill must satisfy the interlock, never opt out of it',
  )
})


// Every workflow is DISCOVERED, not listed: a named list only guards the files
// that existed when it was written, and the workflow most tempting to put on a
// cron is the newest one. A long browser walk on a schedule is worse than a
// merge gate rather than better — it spends minutes with no commit to justify
// them, and nobody reads a green nightly.
//
// `mutation.yml` is the one sanctioned exception: nightly, `continue-on-error`,
// and it gates nothing (its ratchet is an in-repo test, not this workflow). This
// list may only SHRINK. Adding to it means arguing that some other job should
// burn CI on unchanged source.
const SCHEDULED_WORKFLOWS_ALLOWED = new Set(['mutation.yml'])

test('CI has no scheduled runs on unchanged source', () => {
  const workflows = readdirSync(new URL('../.github/workflows', import.meta.url))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  assert.ok(workflows.length > 0, 'no workflow files found — the glob is broken, not the repository')
  for (const name of SCHEDULED_WORKFLOWS_ALLOWED) {
    assert.ok(workflows.includes(name), `${name} is allow-listed for a schedule but no longer exists`)
  }
  for (const name of workflows) {
    if (SCHEDULED_WORKFLOWS_ALLOWED.has(name)) continue
    const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /^  schedule:|^\s+- cron:/m, `${name} must not run on a schedule`)
  }
})


test('the unit deadline kills an unresponsive test worker and stays failed', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync('timeout', ['--signal=TERM', '--kill-after=0.1s', '1s',
    process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, 'GNU timeout must finish without the probe timeout');
  assert.ok(result.status === 137 || result.signal === 'SIGKILL',
    `unresponsive worker must be killed, got ${result.status}/${result.signal}`);
});


test('receipt directory comparison accepts two-digit shard names and still rejects omissions', () => {
  const step = namedStep('Verify every test file ran exactly once')
  const statement = step.split('\n').find(line => line.includes('assert.deepEqual(dirs,'))
  assert.ok(statement)
  const check = new Function('assert', 'dirs', 'count', 'prefix', statement)
  for (const count of [4, 8, 16]) {
    const dirs = Array.from({ length: count }, (_, index) => `coverage-${index + 1}`).sort()
    check(assert, dirs, count, 'coverage')
    assert.throws(() => check(assert, dirs.slice(1), count, 'coverage'))
    assert.throws(() => check(assert, [...dirs, dirs[0]].sort(), count, 'coverage'))
  }
})

test('a skipped control is an unrun control: both partitions audit their own skips', () => {
  // The hazard this pins: every DB-backed test skips itself when no database is
  // configured, so a partition whose database wiring breaks reports green
  // having executed nothing. The canary proves ONE known file ran; these prove the shard that
  // actually matters did not quietly skip.
  for (const partition of ['unit', 'database']) {
    const job = topLevelJob(partition)
    assert.match(
      job,
      new RegExp(`assert-skip-budget\\.mjs ${partition} `),
      `${partition} must audit its own skip count`,
    )
  }
  // `if: always()` matters: a shard that FAILED must still be audited, or a red
  // shard hides a partition that also stopped running things.
  const audits = workflow.split('- name: Skips are declared, not silent')
  assert.equal(audits.length, 3, 'both partitions declare the audit step')
  for (const audit of audits.slice(1)) {
    assert.match(audit.slice(0, 400), /if: always\(\)/)
  }
})

test('scoping main is safe only because a scoped run cannot clear a release', () => {
  const scope = topLevelJob('scope')
  // Fails toward FULL on every unknown: non-push events, force pushes, a base
  // that is not in history, and anything touching the build's own inputs.
  assert.match(scope, /github\.event_name \}\}" != "push" \]; then full=true/)
  assert.match(scope, /0000000000000000000000000000000000000000/)
  assert.match(scope, /git cat-file -e "\$base\^\{commit\}"/)
  assert.match(scope, /\\\.github\/workflows\/\|package-lock\\\.json/)

  // The expensive matrices are gated; the cheap gate never is.
  for (const job of ['unit', 'database', 'simulation']) {
    assert.match(topLevelJob(job), /if: needs\.scope\.outputs\.code == 'true'/, job)
  }
  for (const job of ['e2e-app', 'e2e-workflows']) {
    assert.match(topLevelJob(job), /if: needs\.scope\.outputs\.browser == 'true'/, job)
  }
  assert.doesNotMatch(topLevelJob('typecheck'), /^\s+if:/m)

  // The keystone. It must NOT be always() — its entire value is that it cannot
  // exist unless everything it needs really passed.
  const full = topLevelJob('full-verification')
  assert.match(full, /if: needs\.scope\.outputs\.full == 'true'/)
  // The DIRECTIVE, not the prose — the comment above it names `if: always()`
  // precisely to warn the next person off adding one.
  assert.doesNotMatch(full, /^\s*if: always\(\)/m)
  for (const needed of ['unit', 'database', 'simulation', 'integration', 'e2e-app', 'e2e-workflows']) {
    assert.ok(
      new RegExp(`needs: \\[[^\\]]*\\b${needed}\\b`).test(full),
      `full-verification must depend on ${needed}`,
    )
  }

  // And publish must actually require it, or scoping silently weakens the gate.
  const publish = readFileSync(
    new URL('../.github/workflows/publish-container.yml', import.meta.url),
    'utf8',
  )
  assert.match(publish, /select\(\.name == "full-verification"\)/)
  assert.match(publish, /No EXHAUSTIVE 'test' run/)
})

test('the aggregator only tolerates a skipped partition on a scoped run', () => {
  const integration = topLevelJob('integration')
  assert.match(integration, /FULL: \$\{\{ needs\.scope\.outputs\.full \}\}/)
  assert.match(integration, /full \? \["success"\] : \["success", "skipped"\]/)
})
