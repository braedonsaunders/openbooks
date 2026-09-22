import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const MIGRATIONS_DIR = join(ROOT, 'schema', 'migrations', 'generated')

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// The digest-transition ledger in scripts/bootstrap.ts, parsed from source so
// this test can never drift from what applyTracked actually enforces.
const bootstrap = readFileSync(join(ROOT, 'scripts', 'bootstrap.ts'), 'utf8')
const TRANSITIONS = [...bootstrap.matchAll(
  /\{\s*filename: "generated\/([^"]+)",\s*from: "([0-9a-f]{64})",\s*to: "([0-9a-f]{64})",\s*strategy: "(restamp|reapply)",/g,
)].map((match) => ({ file: match[1], from: match[2], to: match[3], strategy: match[4] }))

const presentFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()
const presentContent = new Map(presentFiles.map((name) => [name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8')]))

/**
 * Every digest each migration file ever published, across all branches: a
 * ledger can record any of them. One `git log --raw` names every historical
 * blob; one `git cat-file --batch` hashes them all in a single process.
 */
function publishedDigests() {
  const raw = execFileSync(
    'git',
    // --no-abbrev: the batch responses echo full blob SHAs, and attribution
    // below keys on them; abbreviated raw SHAs would never match back.
    ['log', '--all', '--raw', '--no-abbrev', '--format=%H', '--', 'schema/migrations/generated'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
  const blobs = new Map() // blobSha -> Set<filename>
  for (const line of raw.split('\n')) {
    // git log --raw: `:<oldmode> <newmode> <oldblob> <newblob> <status>\t<path>`.
    // A new mode of 000000 is a deletion (content removed, not published);
    // otherwise the new blob is a version the tree published under this path.
    const match = /^:\d{6} (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\t(.+)$/.exec(line)
    if (!match) continue
    if (match[1] === '000000') continue
    const name = match[4].replace(/^schema\/migrations\/generated\//, '')
    if (!name.endsWith('.sql')) continue
    if (!blobs.has(match[3])) blobs.set(match[3], new Set())
    blobs.get(match[3]).add(name)
  }
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: [...blobs.keys()].join('\n') + '\n',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (batch.status !== 0) throw new Error('git cat-file --batch failed')
  const out = new Map() // filename -> Set<digest>
  // Walk the batch stream by declared sizes: a line-based reassembly cannot
  // survive content that itself contains newlines, and a trailing newline
  // eaten as a chunk boundary corrupts every digest it computes.
  const buf = batch.stdout
  let pos = 0
  while (pos < buf.length) {
    const newline = buf.indexOf(10, pos)
    if (newline < 0) break
    const header = buf.slice(pos, newline).toString()
    const [blobSha, , sizeText] = header.split(' ')
    const size = Number(sizeText)
    pos = newline + 1
    if (!blobSha || !Number.isFinite(size)) continue
    const digest = sha256(buf.slice(pos, pos + size))
    for (const name of blobs.get(blobSha) ?? []) {
      if (!out.has(name)) out.set(name, new Set())
      out.get(name).add(digest)
    }
    pos += size + 1
  }
  return out
}

const published = publishedDigests()

// The historical digests still awaiting an individually-audited transition.
// Each was published by an in-place corrective edit to an already-applied
// migration, so a ledger recording it is wedged exactly like the 0001
// baseline was; unlike 0001 these are per-file corrective revisions whose
// diffs each need their own reviewed reason before an entry can honestly be
// written. The queue is bidirectional: an entry that lands strikes its slot,
// and a slot that no longer matches a real uncovered digest fails the build.
const PENDING_TRANSITION_AUDIT = new Map(Object.entries({
  '0011_payment_run_live_selection.sql': ['17cacb57c512ae6ce45ab61ef47450e49e917e3397e62b5d5a29560675aff09b'],
  '0022_close_posting_fence.sql': ['61a5ffdabbcc4dbca2d6e190553b101a081a4be42400820b36d249a54b626c09'],
  '0046_account_posting_classification_serialization.sql': ['69307248fc4467327e2a86f0b832a25214822487eb9bda6fbea6980f67d17eb3'],
  '0049_payment_schedule_occurrence_durability.sql': ['72413aefec05e405b8b17e1825728fa15b769fb4ebed6e4d645ffd3cb82ccb8c'],
  '0050_ownership_policy_first_use_serialization.sql': ['ee989d4b0e128c91c882990dea54d12197ac347808395d22ae07cc5bc44282cb'],
  '0065_payroll_voided_run_replacement.sql': ['dcef603c89ac688334eaa2c52e0df527d280b49197bb55f9ece7d86311a6b848'],
  '0068_equipment_capitalization_concurrency.sql': ['a86b5adcd5aec290661bea3c331898da8c2ba04be6b661c5a1a945e739d6ae18'],
  '0070_governed_query_private_projection.sql': ['9e8897579551997ab1034e62e000f3272109c079eb715a2f39c2c20d1c5bde98'],
  '0100_document_open_balance_currency.sql': ['063ee52a3a1088e7589e7d84d6ad110246ca8c04c310d63f0ca8c5b2bf52cf7f'],
  '0103_depreciation_book_policy_history.sql': ['8851f2dc2b88b08082729c9e5ae38b67cefe5b94e3d5f913b76a87836224d1f9'],
  '0109_absorb_apps.sql': ['28437f040361b0335ea7e1f78e4706d66e10acf34b8b012767daa386d6e96052', 'ddabdb3bf63435464e64a12acf8d8e0a4dbf7f292df2002e9be85a34ae814c25', '3eae5bbd6a14168a50072b84b84f0eb913320ef10557bf06d8bca134a8eae735', 'd9796daf37a2ac3a49f764439212cb87414c81aef96637b896ef8b9df1361a18'],
  '0110_modules_key_length.sql': ['53c5284e01783b1409bd03522542ec5a06e8cfe89e6e3431b5aa08c4709e0c0c', '6370ad101e9e826e1d39e591f7bba933c5641aebcf959d61d7e3c331df54d788', '8508e715e11e1671906e9e5beb7646e39e96858ef7733a334adb03ee1fe03b32', '2454fdc66b468c13da171171e33251aec24a20511f1f063ef99f42768ea64685'],
  '0137_inventory_original_cost_basis.sql': ['83c412fb78c61733b3d2b4eeda95d3c0dbb4d866483d5009f1efb5be133d1f6c'],
  '0147_gst34_box_basis_heal.sql': ['7b35f9b309ea0cabae8be76649d16d2dceef5ba4e697d8064db171d0d85103b1'],
  '0158_source_reconciliation_evidence.sql': ['7dd804ce6c42c4b0c7ed477afa43d0c5b145238f61ba039a523afcc94e2fd489'],
  '0169_change_orders_income_account.sql': ['e6c2947d86db7727461db0d350b37ebdd5517e3b103ca02e4b9453a11dd0df4e'],
  '0184_hrm_employment_foundation.sql': ['370915e61f46d7c156ef2b1de2a95088b8ba4bc3aede1faf27b5a42155e34126'],
  '0185_hrm_employment_change_requests.sql': ['a72568900431ad20a2375b66aef2bafb7d40bfb06efb47fedfc89407f0feb58d', '46881ed4d789c7a821961960465954cdd42987379d11b98ea0eac37c78665c11', 'defa86344ad643979789dcdf2e4391e04c3143953f4784d2a293b3bf4713fe71'],
  '0193_hrm_employment_processes.sql': ['4ff1c1b308d4bad6b46786763bb5a30f2b41ce4c805a8a28b44e198289763e4b', '18b8c0f1b8871baf0a71c04b2de04bc0dc6fc3f5941f6c400d53fa4230165dd2'],
  '0194_hrm_leave_attendance.sql': ['bf0279d24b2e2a28f63496861e3f53576b9553ca0e43985aa5459eb7ef72ac20'],
  '0202_lease_lifecycle.sql': ['04a791c457547af3d4dfca16608e9c75c343f336053c005851490334da106228'],
  '0203_revenue_contract_modifications.sql': ['e8a5fb9afa1780bc0b20b1952e1868d0d4ef3260365d1b2b281715b32ec492e2'],
  '0204_asset_lifecycle_changes.sql': ['dc5c44517a718adeb8d21264dd462f061772e3472e952ab3a0c8349d5c39d2d5', '56d035cf7faa4579e608daea2e67dc93818c0d2ccf03559ac8df8653fe21bc6b', '3f9e9c0432d15929c0e830f5cbb02c2d57359a6a02f5464a078a1498542143e6', '0c82dda908bde30656322c1e3dce008a8cff76866719b2b3ac0dd0ea2c69af81'],
  '0205_consolidation_loss_of_control.sql': ['5b171861dc958b4256cbd68a8a6e1a89ad15bb7365f49f93eee6b74af1428278', 'a3301dc9124bd54350852a699e0813f796cdf9bb17184cdb49f5a652503ca708'],
  '0230_hrm_documents_surveys.sql': ['df9cb48c60420c4e498ae982eafbc9e1384723c0bf81b9c8f3eb773d5e105341'],
  '0231_field_time_capture.sql': ['0659e776d711c3820357441a167c89167b5aea1f4356d3bdc8596e319e117a68'],
  '0232_hrm_ai_rails.sql': ['046d0f6c2ab771a299af595919a19c28891a65624630b04d12743b2863b908cb', '83c3f217767bfac844e19d4a4f822944c0206bb70b305c773557f0c2de2d8248'],
  '0236_jl_check_account_evidence_stamp.sql': ['7dd451656cd826e5274eef352a81e21c4443a1afadc058a617f9e3ca6f39bdb0'],
  '0244_item_pricing_hierarchy.sql': ['29c9e2fab9e292eb6cadbe8a2b9c3e7c5cef5d48a0d563020cf8eb8c54b72de1'],
}))

test('every transition lands on the bytes the tree publishes today', () => {
  const broken = TRANSITIONS.filter((entry) => {
    const content = presentContent.get(entry.file)
    if (content === undefined) return true // entry names a file that no longer exists
    return sha256(content) !== entry.to
  })
  assert.deepEqual(
    broken.map((entry) => `${entry.file} -> ${entry.to.slice(0, 12)}`),
    [],
    'A transition whose "to" is not the current published digest can never fire: applyTracked advances a ledger only when from == recorded AND to == sha256 of the bytes on disk. This is the 0080 inversion (an entry pointing at bytes the tree stopped publishing) and the original 0001 gap (an entry whose "to" no branch ever published) - both wedged every ledger they were supposed to serve.',
  )
})

test('every transition departs from a digest its file actually published', () => {
  const fabricated = TRANSITIONS.filter((entry) => !published.get(entry.file)?.has(entry.from))
  assert.deepEqual(
    fabricated.map((entry) => `${entry.file} from ${entry.from.slice(0, 12)}`),
    [],
    'A "from" digest the file never published is an unverifiable claim about history: no ledger can ever have recorded it, so the entry is either dead weight or - worse - documents a restamp of an identity nobody can audit. Ledger identities come from the file\'s publication record or they do not come at all.',
  )
})

test('every historical digest can advance: covered by a transition or queued for audit', () => {
  const uncovered = []
  for (const name of presentFiles) {
    const current = sha256(presentContent.get(name))
    for (const digest of published.get(name) ?? []) {
      if (digest === current) continue
      if (TRANSITIONS.some((entry) => entry.file === name && entry.from === digest && entry.to === current)) continue
      const queued = PENDING_TRANSITION_AUDIT.get(name) ?? []
      if (queued.includes(digest)) continue
      uncovered.push(`${name} ${digest.slice(0, 12)}`)
    }
  }
  assert.deepEqual(uncovered, [], `Historical ledger digests with no path to the current identity wedge the database at "changed after it was applied":\n${uncovered.join('\n')}\nAdd an individually-audited transition entry (review the corrective edit, write its reason) or extend the pending queue with a justification.`)

  // Bidirectional: a queue slot that no longer matches a real uncovered
  // digest is stale - the audit landed and must strike it in the same commit.
  const stale = []
  for (const [name, digests] of PENDING_TRANSITION_AUDIT) {
    const current = presentContent.has(name) ? sha256(presentContent.get(name)) : null
    for (const digest of digests) {
      const stillPublished = published.get(name)?.has(digest) ?? false
      const covered = TRANSITIONS.some((entry) => entry.file === name && entry.from === digest && entry.to === current)
      if (!stillPublished || covered) stale.push(`${name} ${digest.slice(0, 12)}`)
    }
  }
  assert.deepEqual(stale, [], `Pending-audit queue entries that no longer name a real uncovered digest (strike them with the transition that landed):\n${stale.join('\n')}`)
})

test('no migration body commits the runner transaction from inside itself', () => {
  // executeTrackedMigration wraps each migration in one transaction with the
  // ledger insert inside it; a body-issued COMMIT ends that transaction early,
  // so a ledger-write failure would leave the migration applied but
  // unrecorded - the half-applied state the wrapper exists to prevent.
  // 0046 and 0079 shipped that way and are digest-pinned forever; both are
  // replay-tolerant (idempotent bodies), which is the only reason they are
  // survivable. New migrations must not join them.
  const GRANDFATHERED = new Map([
    ['0046_account_posting_classification_serialization.sql', 'shipped with a trailing COMMIT; replay-tolerant (CREATE OR REPLACE / IF NOT EXISTS body), digest-pinned, cannot be edited'],
    ['0079_budget_subsidiary.sql', 'shipped with a trailing COMMIT; replay-tolerant (owner-fill + idempotent shapes), digest-pinned, cannot be edited'],
  ])
  const offenders = []
  for (const name of presentFiles) {
    if (GRANDFATHERED.has(name)) continue
    if (/^\s*commit\s*;/im.test(presentContent.get(name))) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `Migration bodies issue their own COMMIT, escaping the runner's ledger transaction:\n${offenders.join('\n')}\nThe runner wraps each migration with the _applied_migrations insert in ONE transaction; a body COMMIT splits it. Move the work into the transaction or use savepoints, and never end the runner's transaction from inside a migration body.`)
  // And the grandfathered entries must keep telling the truth.
  for (const [name] of GRANDFATHERED) {
    assert.ok(/^\s*commit\s*;/im.test(presentContent.get(name)), `${name} is grandfathered for a trailing COMMIT it no longer contains - strike the grandfather entry`)
  }
})