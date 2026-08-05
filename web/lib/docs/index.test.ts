import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adjacentArticles,
  categoriesWithArticles,
  docNavIndex,
  DOC_ARTICLES,
  DOC_CATEGORIES,
  DOC_SECTIONS,
  getArticle,
} from './index'

test('documentation registry is complete and internally consistent', () => {
  assert.ok(DOC_ARTICLES.length >= 30, 'the foundational documentation set should remain substantial')

  const categoryKeys = DOC_CATEGORIES.map((category) => category.key)
  const sectionKeys = DOC_SECTIONS.map((section) => section.key)
  const slugs = DOC_ARTICLES.map((article) => article.slug)
  assert.equal(new Set(categoryKeys).size, categoryKeys.length, 'category keys must be unique')
  assert.equal(new Set(sectionKeys).size, sectionKeys.length, 'section keys must be unique')
  assert.equal(new Set(slugs).size, slugs.length, 'article slugs must be unique')

  const knownCategories = new Set(categoryKeys)
  const sectionsByKey = new Map(DOC_SECTIONS.map((section) => [section.key, section]))
  const knownSlugs = new Set(slugs)

  for (const section of DOC_SECTIONS) {
    assert.ok(knownCategories.has(section.category), `${section.key} must reference a registered category`)
    if (section.parentKey) {
      const parent = sectionsByKey.get(section.parentKey)
      assert.ok(parent, `${section.key} must reference an existing parent section`)
      assert.equal(parent?.category, section.category, `${section.key} and its parent must share a category`)
    }

    const visited = new Set<string>()
    let current: typeof section | undefined = section
    while (current) {
      assert.equal(visited.has(current.key), false, `${section.key} cannot contain a parent cycle`)
      visited.add(current.key)
      current = current.parentKey ? sectionsByKey.get(current.parentKey) : undefined
    }
  }

  for (const article of DOC_ARTICLES) {
    assert.ok(knownCategories.has(article.category), `${article.slug} must reference a registered category`)
    if (article.section) {
      const section = sectionsByKey.get(article.section)
      assert.ok(section, `${article.slug} must reference an existing section`)
      assert.equal(section?.category, article.category, `${article.slug} and its section must share a category`)
    }
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

test('categories, sections, and articles have deterministic display order', () => {
  const groups = categoriesWithArticles()
  assert.deepEqual(
    groups.map(({ category }) => category.order),
    [...groups].map(({ category }) => category.order).sort((a, b) => a - b),
  )

  for (const { category, articles } of groups) {
    assert.ok(articles.length > 0, `${category.key} should not be empty`)
    assert.equal(new Set(articles.map((article) => article.slug)).size, articles.length)
  }

  const nav = docNavIndex()
  assert.deepEqual(
    nav.articles.map((article) => article.slug),
    groups.flatMap(({ articles }) => articles.map((article) => article.slug)),
  )

  for (const category of DOC_CATEGORIES) {
    const siblings = DOC_SECTIONS.filter((section) => section.category === category.key && !section.parentKey)
    assert.deepEqual(
      siblings.map((section) => section.order),
      [...siblings].map((section) => section.order).sort((a, b) => a - b),
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
