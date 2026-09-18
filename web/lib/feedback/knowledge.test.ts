import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { DOC_ARTICLES } from '../docs'

// `server-only` throws outside a React Server Component; the module under
// test is server-only for the bundler's benefit, and its search is pure.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { createFeedbackKnowledge, searchDocArticles } = await import('./knowledge')

/**
 * The reporter reads the help centre before it files. If this search cannot
 * find the obvious article for an obvious question, the reporter files
 * issues for questions the manual already answers — which is the failure
 * mode worth testing, not the ranking maths.
 */

test('a question about a documented subject finds that subject', () => {
  const hits = searchDocArticles('how do I reconcile a bank statement')
  assert.ok(hits.length > 0, 'a documented subject must return something')
  assert.ok(
    hits.some((hit) => /bank|reconcil/i.test(hit.title)),
    `expected a banking article, got: ${hits.map((h) => h.title).join(', ')}`,
  )
})

test('hits point at the in-app help centre, not an external site', () => {
  for (const hit of searchDocArticles('invoice')) {
    assert.match(hit.url, /^\/docs\/[a-z0-9-]+$/)
    assert.ok(DOC_ARTICLES.some((article) => article.slug === hit.id))
  }
})

test('a query of only common words matches nothing rather than everything', () => {
  assert.deepEqual(searchDocArticles('how do I what is the'), [])
  assert.deepEqual(searchDocArticles('   '), [])
})

test('the result set stays small enough to put in a prompt', () => {
  const hits = searchDocArticles('report invoice project payment account tax close')
  assert.ok(hits.length <= 8, `expected at most 8 hits, got ${hits.length}`)
  for (const hit of hits) assert.ok((hit.excerpt ?? '').length <= 300)
})

test('reading an article returns its body; an unknown id returns null', async () => {
  const knowledge = createFeedbackKnowledge()
  const first = DOC_ARTICLES[0]!
  const article = await knowledge.read(first.slug)
  assert.ok(article)
  assert.equal(article.title, first.title)
  assert.equal(article.body, first.body)
  assert.equal(await knowledge.read('no-such-article'), null)
})
