import 'server-only'

import type { KnowledgeHit, KnowledgeSource } from '@braedonsaunders/appkit-feedback'
import { DOC_ARTICLES, getArticle } from '../docs'

/**
 * The reporter's help source: the in-app documentation registry
 * (web/lib/docs), which is the same content the /docs help centre serves.
 *
 * Reading before filing is the whole reason the reporter is worth having —
 * most "this is broken" reports are "I could not find how to do this", and an
 * answer now beats an issue the reporter will read next week. Documentation
 * is public product content, so nothing here is tenant data and no scope
 * check is owed.
 */

const MAX_HITS = 8
const EXCERPT_CHARS = 280

/** Field weights: a title match means the article is ABOUT the thing asked. */
const TITLE_WEIGHT = 8
const SUMMARY_WEIGHT = 4
const KEYWORD_WEIGHT = 6
const BODY_WEIGHT = 1

// Words too common in an ERP manual to discriminate between its articles.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'not', 'of', 'on', 'or', 'that',
  'the', 'this', 'to', 'was', 'what', 'when', 'why', 'will', 'with', 'you', 'your',
])

function terms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
    ),
  ].slice(0, 12)
}

function occurrences(haystack: string, term: string): number {
  if (!haystack) return 0
  let count = 0
  let index = haystack.indexOf(term)
  while (index !== -1 && count < 5) {
    count += 1
    index = haystack.indexOf(term, index + term.length)
  }
  return count
}

/** The first sentence-ish window around the strongest term, for the model. */
function excerpt(body: string, matched: string[]): string {
  const plain = body.replace(/\s+/g, ' ').trim()
  const lower = plain.toLowerCase()
  const at = matched.map((term) => lower.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
  if (at === undefined) return plain.slice(0, EXCERPT_CHARS)
  const start = Math.max(0, at - EXCERPT_CHARS / 4)
  const window = plain.slice(start, start + EXCERPT_CHARS)
  return start > 0 ? `…${window}` : window
}

export function searchDocArticles(query: string): KnowledgeHit[] {
  const words = terms(query)
  if (words.length === 0) return []

  const scored = DOC_ARTICLES.map((article) => {
    const title = article.title.toLowerCase()
    const summary = article.summary.toLowerCase()
    const keywords = (article.keywords ?? []).join(' ').toLowerCase()
    const body = article.body.toLowerCase()
    const matched: string[] = []
    let score = 0
    for (const word of words) {
      const hits =
        (title.includes(word) ? TITLE_WEIGHT : 0) +
        (summary.includes(word) ? SUMMARY_WEIGHT : 0) +
        (keywords.includes(word) ? KEYWORD_WEIGHT : 0) +
        occurrences(body, word) * BODY_WEIGHT
      if (hits > 0) matched.push(word)
      score += hits
    }
    return { article, score, matched }
  })
    .filter((row) => row.score > 0)
    // Ties break on the article that matched MORE of the query, not on
    // whichever happens to be longer and therefore repeats one word most.
    .sort((a, b) => b.matched.length - a.matched.length || b.score - a.score)
    .slice(0, MAX_HITS)

  return scored.map(({ article, matched }) => ({
    id: article.slug,
    title: article.title,
    url: `/docs/${article.slug}`,
    excerpt: excerpt(article.body, matched) || article.summary,
  }))
}

export function createFeedbackKnowledge(): KnowledgeSource {
  return {
    async search(query) {
      return searchDocArticles(query)
    },
    async read(id) {
      const article = getArticle(id)
      if (!article) return null
      return { title: article.title, url: `/docs/${article.slug}`, body: article.body }
    },
  }
}
