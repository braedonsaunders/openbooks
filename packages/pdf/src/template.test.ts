import assert from 'node:assert/strict'
import test from 'node:test'
import { renderTemplate } from './template'

test('triple-brace record values are escaped unless raw values are explicitly enabled', () => {
  const rendered = renderTemplate(
    '<p>{{{memo}}}</p>',
    { memo: '<img src="https://attacker.example/pixel" onerror="steal()">Visible note' },
    { escapeHtml: true },
  )

  // HTML-bearing merge values are plainified before escaping, so an injected
  // element (including its external URL) cannot reach the printed body.
  assert.equal(rendered, '<p>Visible note</p>')
  assert.doesNotMatch(rendered, /attacker\.example|<img/i)
})

test('trusted callers can explicitly opt into raw HTML values', () => {
  assert.equal(
    renderTemplate(
      '<p>{{{memo}}}</p>',
      { memo: '<strong>Approved markup</strong>' },
      { escapeHtml: true, allowRawValues: true },
    ),
    '<p><strong>Approved markup</strong></p>',
  )
})
