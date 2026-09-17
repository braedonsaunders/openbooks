import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t05-005: the 404 page rendered "Page not found" twice — RouteStateView
// (and Standalone) put title+description in the PageHeader AND in the body
// EmptyState (h1 + h3, same copy). The header owns the copy; the body keeps
// icon + recovery action.
const routeStateSource = readFileSync(new URL('./route-state.tsx', import.meta.url), 'utf8')
const emptyStateSource = readFileSync(
  new URL('../../packages/ui/src/empty-state.tsx', import.meta.url),
  'utf8',
)

test('route-state header keeps the single title + description', () => {
  assert.match(
    routeStateSource,
    /<PageHeader title=\{title\} description=\{description\} \/>/,
    'the PageHeader remains the one heading + message',
  )
})

test('route-state body no longer repeats the copy', () => {
  assert.match(
    routeStateSource,
    /<EmptyState icon=\{icon\} action=\{action\} \/>/,
    'the body EmptyState carries icon + action only',
  )
})

test('EmptyState supports a title-less body', () => {
  assert.match(emptyStateSource, /title\?: string/, 'title must be optional')
  assert.match(emptyStateSource, /\{title \?/, 'h3 renders only with a title')
})
