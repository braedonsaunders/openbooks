import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const publisher = fileURLToPath(new URL('./publish-trust.mjs', import.meta.url))
const repositoryRoot = dirname(dirname(publisher))

function runPublisher({ conformance, controls, checkpoint, out, sha = 'test-sha' }) {
  const args = [publisher, '--conformance', conformance, '--checkpoint', checkpoint, '--out', out, '--sha', sha]
  if (controls) args.push('--controls', controls)
  return spawnSync(process.execPath, args, { cwd: repositoryRoot, encoding: 'utf8' })
}

test('empty publication refuses before mutating the output directory', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const conformance = join(tempDirectory, 'conformance')
    const controls = join(tempDirectory, 'controls')
    const checkpoint = join(tempDirectory, 'checkpoint')
    const out = join(tempDirectory, 'trust')
    const preservedHistory = '[{"gitSha":"previous"}]\n'
    const preservedBadge = '{"message":"previous"}\n'

    for (const directory of [conformance, controls, checkpoint, out]) {
      mkdirSync(directory, { recursive: true })
    }
    writeFileSync(join(out, 'history.json'), preservedHistory)
    writeFileSync(join(out, 'badge-conformance.json'), preservedBadge)
    writeFileSync(join(out, 'badge-invariants.json'), preservedBadge)

    const result = runPublisher({ conformance, controls, checkpoint, out })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /refusing to publish an empty trust page/)
    assert.equal(readFileSync(join(out, 'history.json'), 'utf8'), preservedHistory)
    assert.equal(readFileSync(join(out, 'badge-conformance.json'), 'utf8'), preservedBadge)
    assert.equal(readFileSync(join(out, 'badge-invariants.json'), 'utf8'), preservedBadge)
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('publication writes evidence and history when inputs are present', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const conformance = join(tempDirectory, 'conformance')
    const controls = join(tempDirectory, 'controls')
    const checkpoint = join(tempDirectory, 'checkpoint')
    const out = join(tempDirectory, 'trust')
    mkdirSync(conformance, { recursive: true })
    mkdirSync(controls, { recursive: true })
    mkdirSync(checkpoint, { recursive: true })

    const conformanceCases = [{ id: 'case-1', status: 'pass' }]
    const controlsCases = [{ id: 'alloc-1', status: 'pass', control: 'A12' }]
    writeFileSync(
      join(conformance, 'conformance.json'),
      JSON.stringify({
        totals: { pass: 1, fail: 0, gap: 0 },
        pass: true,
        cases: conformanceCases,
        gitSha: 'test-sha',
        casesSha256: digestOf(conformanceCases),
      }),
    )
    writeFileSync(
      join(controls, 'controls.json'),
      JSON.stringify({
        kind: 'internal-controls',
        totals: { pass: 1, fail: 0, gap: 0 },
        pass: true,
        cases: controlsCases,
        gitSha: 'test-sha',
        casesSha256: digestOf(controlsCases),
      }),
    )
    writeFileSync(
      join(controls, 'controls-matrix.md'),
      '# Internal-controls evidence matrix\n',
    )
    writeFileSync(
      join(checkpoint, 'checkpoint.json'),
      JSON.stringify({
        orgName: 'Acme',
        counts: { postedEntries: 1 },
        checks: [{ name: 'balanced', ok: true }],
        pass: true,
        gitSha: 'test-sha',
      }),
    )

    const result = runPublisher({ conformance, controls, checkpoint, out })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(out, 'badge-conformance.json')), true)
    assert.equal(existsSync(join(out, 'badge-invariants.json')), true)
    assert.equal(existsSync(join(out, 'conformance.json')), true)
    assert.equal(existsSync(join(out, 'controls.json')), true)
    assert.equal(existsSync(join(out, 'controls-matrix.md')), true)
    assert.equal(existsSync(join(out, 'checkpoint.json')), true)
    assert.equal(existsSync(join(out, 'history.json')), true)

    const history = JSON.parse(readFileSync(join(out, 'history.json'), 'utf8'))
    assert.equal(history.length, 1)
    assert.equal(history[0].controls.kind, 'internal-controls')
    assert.deepEqual(history[0].controls.failures, [])
    const published = JSON.parse(readFileSync(join(out, 'controls.json'), 'utf8'))
    assert.equal(published.kind, 'internal-controls')
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('controls-only input is refused instead of published as unavailable', () => {
  // Reversal of the old partial-tolerance contract (owner-accepted finding
  // 7.5): publishing one part while recording the others as unavailable is
  // exactly how a stale component survives under a new SHA. The publisher
  // now requires every component and fails closed.
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const conformance = join(tempDirectory, 'conformance')
    const controls = join(tempDirectory, 'controls')
    const checkpoint = join(tempDirectory, 'checkpoint')
    const out = join(tempDirectory, 'trust')
    mkdirSync(controls, { recursive: true })

    const controlsCases = [{ id: 'alloc-1', status: 'pass', control: 'A12' }]
    writeFileSync(
      join(controls, 'controls.json'),
      JSON.stringify({
        kind: 'internal-controls',
        totals: { pass: 1, fail: 0, gap: 0 },
        pass: true,
        cases: controlsCases,
        gitSha: 'test-sha',
        casesSha256: digestOf(controlsCases),
      }),
    )

    const result = runPublisher({ conformance, controls, checkpoint, out })

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /partial|every component|all three/i)
    assert.equal(existsSync(out), false, 'a refused publication must leave no output directory')
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function writeEvidence(dir, { sha, tamper = null, dropSha = false, dropDigest = false, dropCheckpoint = false }) {
  const conformanceCases = [{ id: 'case-1', status: 'pass' }]
  const controlsCases = [{ id: 'alloc-1', status: 'pass', control: 'A12' }]
  if (tamper === 'cases') conformanceCases.push({ id: 'injected', status: 'pass' })
  const conformance = {
    totals: { pass: 1, fail: 0, gap: 0 },
    pass: true,
    cases: conformanceCases,
    ...(dropSha ? {} : { gitSha: sha }),
    ...(dropDigest ? {} : { casesSha256: tamper === 'digest' ? '0'.repeat(64) : digestOf([{ id: 'case-1', status: 'pass' }]) }),
  }
  const controls = {
    kind: 'internal-controls',
    totals: { pass: 1, fail: 0, gap: 0 },
    pass: true,
    cases: controlsCases,
    gitSha: sha,
    casesSha256: digestOf(controlsCases),
  }
  mkdirSync(join(dir, 'conformance'), { recursive: true })
  mkdirSync(join(dir, 'controls'), { recursive: true })
  if (!dropCheckpoint) mkdirSync(join(dir, 'checkpoint'), { recursive: true })
  writeFileSync(join(dir, 'conformance', 'conformance.json'), JSON.stringify(conformance))
  writeFileSync(join(dir, 'controls', 'controls.json'), JSON.stringify(controls))
  if (!dropCheckpoint) {
    writeFileSync(
      join(dir, 'checkpoint', 'checkpoint.json'),
      JSON.stringify({
        orgName: 'Acme',
        counts: { postedEntries: 1 },
        checks: [{ name: 'balanced', ok: true }],
        pass: true,
        gitSha: sha,
      }),
    )
  }
}

test('mixed-source evidence is rejected before anything is published', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const out = join(tempDirectory, 'trust')
    writeEvidence(tempDirectory, { sha: 'commit-a' })
    // Swap the controls artifact for one produced from another commit.
    const controlsPath = join(tempDirectory, 'controls', 'controls.json')
    const controls = JSON.parse(readFileSync(controlsPath, 'utf8'))
    controls.gitSha = 'commit-b'
    writeFileSync(controlsPath, JSON.stringify(controls))

    const result = runPublisher({
      conformance: join(tempDirectory, 'conformance'),
      controls: join(tempDirectory, 'controls'),
      checkpoint: join(tempDirectory, 'checkpoint'),
      out,
      sha: 'commit-a',
    })

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /mixed-source|same commit|does not match/)
    assert.equal(existsSync(out), false, 'a rejected publication must leave no output directory')
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('evidence without source provenance is rejected', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const out = join(tempDirectory, 'trust')
    writeEvidence(tempDirectory, { sha: 'commit-a', dropSha: true, dropDigest: true })

    const result = runPublisher({
      conformance: join(tempDirectory, 'conformance'),
      controls: join(tempDirectory, 'controls'),
      checkpoint: join(tempDirectory, 'checkpoint'),
      out,
      sha: 'commit-a',
    })

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /provenance|gitSha|source/i)
    assert.equal(existsSync(out), false, 'a rejected publication must leave no output directory')
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('partial publication is refused and leaves the previous bundle intact', () => {
  // A run that could only produce one part must not publish that part over
  // the previous bundle: conditional writes leave the other components
  // stale while history claims the new SHA. Fail closed instead.
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const out = join(tempDirectory, 'trust')
    mkdirSync(out, { recursive: true })
    const staleConformance = '{"stale":true}\n'
    const staleHistory = '[{"gitSha":"previous"}]\n'
    writeFileSync(join(out, 'conformance.json'), staleConformance)
    writeFileSync(join(out, 'history.json'), staleHistory)
    writeEvidence(tempDirectory, { sha: 'commit-a', dropCheckpoint: true })

    const result = runPublisher({
      conformance: join(tempDirectory, 'conformance'),
      controls: join(tempDirectory, 'controls'),
      checkpoint: join(tempDirectory, 'checkpoint'),
      out,
      sha: 'commit-a',
    })

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /partial|every component|all three/i)
    assert.equal(readFileSync(join(out, 'conformance.json'), 'utf8'), staleConformance)
    assert.equal(readFileSync(join(out, 'history.json'), 'utf8'), staleHistory)
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('a full publication swaps atomically and drops stale components', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const out = join(tempDirectory, 'trust')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'conformance.json'), '{"stale":true}\n')
    writeFileSync(join(out, 'junk-from-a-manual-run.txt'), 'junk\n')
    writeFileSync(join(out, 'history.json'), '[{"gitSha":"previous"}]\n')
    writeEvidence(tempDirectory, { sha: 'commit-a' })

    const result = runPublisher({
      conformance: join(tempDirectory, 'conformance'),
      controls: join(tempDirectory, 'controls'),
      checkpoint: join(tempDirectory, 'checkpoint'),
      out,
      sha: 'commit-a',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(out, 'junk-from-a-manual-run.txt')), false, 'stale files must not survive the swap')
    const published = JSON.parse(readFileSync(join(out, 'conformance.json'), 'utf8'))
    assert.equal(published.gitSha, 'commit-a', 'the bundle must be the new evidence, not the stale file')
    const history = JSON.parse(readFileSync(join(out, 'history.json'), 'utf8'))
    assert.equal(history.length, 2, 'the append-only trend must survive the swap')
    assert.equal(history[0].gitSha, 'previous')
    assert.equal(history[1].gitSha, 'commit-a')
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('a matrix whose header disagrees with the corpus is refused before publication', () => {
  // The August badge drift: the matrix was refreshed by hand while the badge
  // input came from an older run, and the publisher rendered the stale badge
  // under a new label. The publisher now refuses a bundle whose two
  // renderings of one derivation disagree, before touching the output.
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const out = join(tempDirectory, 'trust')
    writeEvidence(tempDirectory, { sha: 'commit-a' })
    writeFileSync(
      join(tempDirectory, 'conformance', 'conformance.json'),
      JSON.stringify({
        totals: { pass: 77, fail: 0, gap: 15, skipped: 0 },
        pass: true,
        cases: Array.from({ length: 77 }, (_, i) => ({ id: `case-${i}`, status: 'pass' })).concat(
          Array.from({ length: 15 }, (_, i) => ({ id: `gap-${i}`, status: 'gap' })),
        ),
        gitSha: 'commit-a',
        casesSha256: digestOf(
          Array.from({ length: 77 }, (_, i) => ({ id: `case-${i}`, status: 'pass' })).concat(
            Array.from({ length: 15 }, (_, i) => ({ id: `gap-${i}`, status: 'gap' })),
          ),
        ),
      }),
    )
    writeFileSync(
      join(tempDirectory, 'conformance', 'conformance-matrix.md'),
      '# Accounting standards conformance matrix\n\n**42 passing · 0 failing · 0 gaps · 0 not run**\n',
    )

    const result = runPublisher({
      conformance: join(tempDirectory, 'conformance'),
      controls: join(tempDirectory, 'controls'),
      checkpoint: join(tempDirectory, 'checkpoint'),
      out,
      sha: 'commit-a',
    })

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /badge\/matrix drift|counts differ/)
    assert.equal(existsSync(out), false, 'a refused publication must leave no output directory')
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('a matrix agreeing with the corpus publishes a badge restating its totals', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const out = join(tempDirectory, 'trust')
    writeEvidence(tempDirectory, { sha: 'commit-a' })
    const cases = [{ id: 'case-1', status: 'pass' }]
    writeFileSync(
      join(tempDirectory, 'conformance', 'conformance.json'),
      JSON.stringify({
        totals: { pass: 1, fail: 0, gap: 2, skipped: 0 },
        pass: true,
        cases: cases.concat([
          { id: 'gap-1', status: 'gap' },
          { id: 'gap-2', status: 'gap' },
        ]),
        gitSha: 'commit-a',
        casesSha256: digestOf(
          cases.concat([
            { id: 'gap-1', status: 'gap' },
            { id: 'gap-2', status: 'gap' },
          ]),
        ),
      }),
    )
    writeFileSync(
      join(tempDirectory, 'conformance', 'conformance-matrix.md'),
      '# Accounting standards conformance matrix\n\n**1 passing · 0 failing · 2 gaps · 0 not run**\n',
    )

    const result = runPublisher({
      conformance: join(tempDirectory, 'conformance'),
      controls: join(tempDirectory, 'controls'),
      checkpoint: join(tempDirectory, 'checkpoint'),
      out,
      sha: 'commit-a',
    })

    assert.equal(result.status, 0, result.stderr)
    const badge = JSON.parse(readFileSync(join(out, 'badge-conformance.json'), 'utf8'))
    assert.equal(badge.message, '1 passing, 2 gaps')
    assert.equal(badge.gitSha, 'commit-a')
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('tampered case payloads are rejected by their digest', () => {
  for (const tamper of ['cases', 'digest']) {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
    try {
      const out = join(tempDirectory, 'trust')
      writeEvidence(tempDirectory, { sha: 'commit-a', tamper })

      const result = runPublisher({
        conformance: join(tempDirectory, 'conformance'),
        controls: join(tempDirectory, 'controls'),
        checkpoint: join(tempDirectory, 'checkpoint'),
        out,
        sha: 'commit-a',
      })

      assert.equal(result.status, 1, `${tamper}: ${result.stderr}`)
      assert.match(result.stderr, /digest|tamper|integrity/i)
      assert.equal(existsSync(out), false, 'a rejected publication must leave no output directory')
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true })
    }
  }
})
