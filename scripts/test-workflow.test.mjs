import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  assert.match(unit, /timeout --signal=TERM --kill-after=10s 5m npm run test:unit/)
  assert.match(unit, /timeout-minutes: 8/)
  assert.match(unit, /apt-get install -y qpdf/)
  assert.match(unit, /shard: \[1, 2, 3, 4\]/)
  assert.match(unit, /OPENBOOKS_TEST_SHARD: \$\{\{ matrix.shard \}\}\/4/)
  assert.match(integration, /npm run test:integration/)
  assert.doesNotMatch(integration, /npm test\b|npm run test:unit/)
  assert.match(integration, /shard: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/)
  assert.match(integration, /OPENBOOKS_TEST_SHARD: \$\{\{ matrix.shard \}\}\/16/)
  assert.match(integration, /fail-fast: false/)
  assert.match(integration, /timeout-minutes: 15/)
  assert.doesNotMatch(integration, /--test-concurrency|continue-on-error/)
  assert.match(integration, /name: coverage-\$\{\{ matrix.shard \}\}/)
  assert.match(integration, /COLLECT_COVERAGE:.*github.event_name == 'workflow_dispatch'/)
  assert.match(simulation, /sim -- run/)
  assert.match(simulation, /harness --/)
  assert.match(simulation, /services:/)
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


test('CI has no scheduled runs on unchanged source', () => {
  for (const name of ['test.yml', 'trust.yml', 'security.yml']) {
    const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /^  schedule:|^\s+- cron:/m)
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
