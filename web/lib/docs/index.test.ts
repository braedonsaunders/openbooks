import assert from 'node:assert/strict'
import test from 'node:test'
import { adjacentArticles, categoriesWithArticles, DOC_ARTICLES, DOC_CATEGORIES, getArticle } from './index'

test('documentation registry is complete and internally consistent', () => {
  assert.ok(DOC_ARTICLES.length >= 30, 'the foundational documentation set should remain substantial')

  const categoryKeys = DOC_CATEGORIES.map((category) => category.key)
  const slugs = DOC_ARTICLES.map((article) => article.slug)
  assert.equal(new Set(categoryKeys).size, categoryKeys.length, 'category keys must be unique')
  assert.equal(new Set(slugs).size, slugs.length, 'article slugs must be unique')

  const knownCategories = new Set(categoryKeys)
  const knownSlugs = new Set(slugs)
  for (const article of DOC_ARTICLES) {
    assert.ok(knownCategories.has(article.category), `${article.slug} must reference a registered category`)
    assert.match(article.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.match(article.updated, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(article.summary.trim().length >= 40, `${article.slug} needs a useful summary`)
    assert.ok(article.body.startsWith(`# ${article.title}\n`), `${article.slug} body must begin with its title`)
    assert.ok(article.body.trim().length >= 500, `${article.slug} must be a substantive article`)
    assert.equal(article.body.includes('`'), false, `${article.slug} must follow the no-backticks authoring convention`)

    for (const related of article.related ?? []) {
      assert.ok(knownSlugs.has(related), `${article.slug} references missing related article ${related}`)
      assert.notEqual(related, article.slug, `${article.slug} cannot relate to itself`)
    }
  }
})

test('categories and articles have deterministic display order', () => {
  const groups = categoriesWithArticles()
  assert.deepEqual(
    groups.map(({ category }) => category.order),
    [...groups].map(({ category }) => category.order).sort((a, b) => a - b),
  )

  for (const { category, articles } of groups) {
    assert.ok(articles.length > 0, `${category.key} should not be empty`)
    assert.deepEqual(
      articles.map((article) => article.order),
      [...articles].map((article) => article.order).sort((a, b) => a - b),
    )
  }
})

test('article lookup and adjacent navigation follow visible reading order', () => {
  const ordered = categoriesWithArticles().flatMap(({ articles }) => articles)
  assert.equal(getArticle(ordered[0]!.slug), ordered[0])
  assert.deepEqual(adjacentArticles(ordered[0]!.slug), { next: ordered[1] })
  assert.deepEqual(adjacentArticles(ordered.at(-1)!.slug), {
    previous: ordered.at(-2),
  })
  assert.deepEqual(adjacentArticles('not-an-article'), {})
})
