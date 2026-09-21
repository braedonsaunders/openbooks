import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Next.js error.tsx sanitizes thrown messages to a digest. The three
// production callers must catch AmbiguousListViewDefaultError and render
// error.message in-page — PageHeader + EmptyState for the list components,
// pageHeader + empty-state for property management, the way HRM leave does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db = { execute() { return { rows: [] } } }',
      }
    }
    return nextResolve(specifier, context)
  },
})

const { AmbiguousListViewDefaultError } = await import('./resolve.ts')
const { EmptyState, PageHeader } = await import('@openbooks/ui')
const { renderToStaticMarkup } = await import('react-dom/server')
const React = await import('react')
Object.assign(globalThis, { React })

const REMEDY = 'Clear the extra default and save again'
const OPERATOR_MESSAGE =
  'More than one default view is stored for this scope. Clear the extra default and save again.'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const recordList = readFileSync(join(webRoot, 'components/record-list-view.tsx'), 'utf8')
const entityList = readFileSync(join(webRoot, 'components/entity-list-view.tsx'), 'utf8')
const propertyView = readFileSync(join(webRoot, 'app/(app)/property-management/view.ts'), 'utf8')

test('the overlapping-default error names the operator-visible remedy', () => {
  const error = new AmbiguousListViewDefaultError()
  assert.equal(error.message, OPERATOR_MESSAGE)
  assert.ok(error.message.includes(REMEDY), 'the operator-visible string must be the error message')
})

test('entity, record, and property-management callers catch the named error and render error.message', () => {
  for (const [name, src] of [
    ['record-list-view', recordList],
    ['entity-list-view', entityList],
    ['property-management/view', propertyView],
  ] as const) {
    assert.match(src, /AmbiguousListViewDefaultError/, `${name} must catch the typed overlapping-default error`)
    assert.match(src, /error\.message/, `${name} must render the named message, not a digest`)
    assert.match(
      src,
      /EmptyState|empty-state/,
      `${name} must render the remedy through EmptyState, the way HRM leave does`,
    )
    assert.match(
      src,
      /PageHeader|pageHeader/,
      `${name} must put the named message on PageHeader, the way HRM leave does`,
    )
  }
  assert.match(
    recordList,
    /description=\{error\.message\}/,
    'record-list-view must put the named message on PageHeader and EmptyState',
  )
  assert.match(
    entityList,
    /description=\{error\.message\}/,
    'entity-list-view must put the named message on PageHeader and EmptyState',
  )
})

test('list callers put the named remedy on PageHeader and EmptyState', () => {
  const error = new AmbiguousListViewDefaultError()
  const html = renderToStaticMarkup(
    <>
      <PageHeader title="Default view" description={error.message} />
      <EmptyState description={error.message} />
    </>,
  )
  assert.ok(html.includes(REMEDY), 'the operator-visible string must appear in the in-page refusal')
  assert.ok(html.includes(OPERATOR_MESSAGE), 'the full named message must appear, not a digest')
})

test('property-management carries the named remedy as empty-state data, not a thrown digest', () => {
  assert.match(
    propertyView,
    /listViewRefusal: resolvedViewResult\.error\.message/,
    'the loader must store the named message for the empty-state',
  )
  assert.match(
    propertyView,
    /description: resolvedViewResult\.error\.message/,
    'the page header must carry the named message',
  )
  assert.match(
    propertyView,
    /widgetBlock\(\s*'empty-state'/,
    'the spec must render the refusal through the shared empty-state',
  )
  assert.match(
    propertyView,
    /description: data\.listViewRefusal/,
    'the empty-state must bind the stored named message',
  )
  assert.match(
    propertyView,
    /f\('listViewRefusal'\)/,
    'the empty-state shows exactly when the refusal is set',
  )
  assert.match(
    propertyView,
    /f\('hasContent'\)/,
    'the workspace hides exactly when the refusal is set',
  )
})
