import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

/**
 * What an operator may store as an issue destination, and where the resulting
 * request is allowed to go. Both are security boundaries: the owner/repo pair
 * becomes a URL path, and the request carries the deployment's access token.
 */

// `server-only` throws outside a React Server Component; these functions are
// pure validators that happen to live beside the database reads.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { feedbackDenyList, parseFeedbackLabels, sanitizeFeedbackSettingsInput } = await import(
  './config'
)
const { feedbackGithubRequest } = await import('./github')

const base = {
  enabled: false,
  owner: 'openbooks',
  repo: 'openbooks',
  labels: '',
  searchDuplicates: true,
}

test('labels are trimmed, de-duplicated case-insensitively, and bounded', () => {
  assert.deepEqual(parseFeedbackLabels(' bug , Bug,  triage '), ['bug', 'triage'])
  assert.deepEqual(parseFeedbackLabels(''), [])
  assert.equal(parseFeedbackLabels('a1,a2,a3,a4,a5,a6,a7,a8,a9,a10').length, 8)
  assert.deepEqual(parseFeedbackLabels(`bug,${'x'.repeat(41)}`), ['bug'])
})

test('an owner or repository that is not a valid GitHub name is refused', () => {
  for (const owner of ['has space', 'bad/slash', '-leading', 'trailing-']) {
    assert.throws(() => sanitizeFeedbackSettingsInput({ ...base, owner }), /owner/i, owner)
  }
  for (const repo of ['bad/slash', '.', '..', 'has space']) {
    assert.throws(() => sanitizeFeedbackSettingsInput({ ...base, repo }), /name/i, repo)
  }
})

test('reporting cannot be enabled without a destination', () => {
  assert.throws(
    () => sanitizeFeedbackSettingsInput({ ...base, enabled: true, repo: '' }),
    /repository owner and name/i,
  )
})

test('a valid destination normalizes rather than rejecting on whitespace', () => {
  const clean = sanitizeFeedbackSettingsInput({
    ...base,
    owner: '  openbooks ',
    repo: ' openbooks ',
    labels: 'bug, Bug',
    token: '  ghp_example  ',
  })
  assert.equal(clean.owner, 'openbooks')
  assert.equal(clean.repo, 'openbooks')
  assert.equal(clean.labels, 'bug')
  assert.equal(clean.token, 'ghp_example')
})

test('a blank token means keep the stored one, not clear it', () => {
  assert.equal(sanitizeFeedbackSettingsInput({ ...base, token: '   ' }).token, undefined)
  assert.equal(sanitizeFeedbackSettingsInput({ ...base }).token, undefined)
})

test('the deny list keeps identifying values and drops ones too short to redact safely', () => {
  assert.deepEqual(
    feedbackDenyList(['Acme Industrial Corp', ' ab ', null, undefined, '', 'sam@example.test']),
    ['Acme Industrial Corp', 'sam@example.test'],
  )
})

test('an issue-tracker request to any other host is refused before it is sent', async () => {
  await assert.rejects(
    () =>
      feedbackGithubRequest({
        url: 'https://attacker.test/repos/openbooks/openbooks/issues',
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: '{}',
      }),
    /refusing an issue-tracker request/,
  )
})
