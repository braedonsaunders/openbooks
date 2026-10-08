import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../../testing/stub-modules'
import { categoriesWithArticles, getArticle, docNavIndex } from '../../../lib/docs'

stubModules({ intl: true, extra: {
  'next/link': "export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}",
} })
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { loadDocsHome } = await import('./view')
const { DocsHome } = await import('./sections')

test('documentation home carries card metadata while retaining the complete rendered catalog and full-text reader', async () => {
  const { content } = await loadDocsHome()
  const fullGroups = categoriesWithArticles()
  const fullContent = {
    ...content,
    groups: content.groups.map((group, index) => ({ ...group, articles: fullGroups[index]!.articles })),
    startHereArticles: content.startHereArticles.map(article => getArticle(article.slug)!),
    switchingArticles: content.switchingArticles.map(article => getArticle(article.slug)!),
  }
  assert.equal(renderToStaticMarkup(<DocsHome content={content} />), renderToStaticMarkup(<DocsHome content={fullContent} />), 'every link, summary and category remains identical')
  const metadata = JSON.stringify(content)
  assert.ok(metadata.length < JSON.stringify(fullContent).length * 0.3, 'article bodies do not ride the home projection')
  assert.ok([...content.startHereArticles, ...content.switchingArticles, ...content.groups.flatMap(group => group.articles)].every(article => !Object.hasOwn(article, 'body')))
  assert.deepEqual(content.groups.flatMap(group => group.articles.map(article => article.slug)), fullGroups.flatMap(group => group.articles.map(article => article.slug)))
  for (const article of docNavIndex().articles) {
    assert.equal(article.text, getArticle(article.slug)!.body.toLowerCase(), 'the lazy full-text search index retains the complete article')
  }
})
