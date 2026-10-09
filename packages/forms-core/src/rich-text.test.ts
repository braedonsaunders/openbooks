import test from 'node:test'
import assert from 'node:assert/strict'
import { plainTextDocument, richTextDocumentSchema, richTextPlainText, safeRichTextLink } from './rich-text'
test('typed messages retain literal markup, multiline text and explicit formatted list/link alternatives', () => {
  const legacy = '<strong>Literal</strong>\nSecond line'
  assert.equal(richTextPlainText(plainTextDocument(legacy)), legacy)
  const doc = richTextDocumentSchema.parse({version: 1, blocks: [{kind: 'paragraph', spans: [{text: 'Hello', bold: true}]}, {kind: 'bullet', spans: [{text: 'Read', href: 'https://example.test/schedule'}]}, {kind: 'number', spans: [{text: 'Arrive', italic: true}]}]})
  assert.equal(richTextPlainText(doc), 'Hello\n• Read (https://example.test/schedule)\n1. Arrive')
})
test('rich messages refuse executable/resource markup, unsafe links and bounded-content overflow', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,test', '//example.test', 'https://user:password@example.test', 'https://example.test/\n']) assert.equal(safeRichTextLink(href), false)
  for (const href of ['https://example.test/a?b=c', 'mailto:person@example.test', 'http://example.test']) assert.equal(safeRichTextLink(href), true)
  const doc = plainTextDocument('Text')
  assert.equal(richTextDocumentSchema.safeParse({...doc, html: '<script>alert(1)</script>'}).success, false)
  assert.equal(richTextDocumentSchema.safeParse({version: 1, blocks: [{kind: 'paragraph', spans: [{text: 'Text', style: 'color:red'}]}]}).success, false)
  assert.equal(richTextDocumentSchema.safeParse(plainTextDocument('a'.repeat(4001))).success, false)
})

import { configuredSchedulePdfLayout } from './schedule-delivery'
test('configured PDF choices are reused without accepting invalid board policy JSON', () => {
  assert.equal(configuredSchedulePdfLayout(null).colorTreatment, 'subtle')
  const layout = {...configuredSchedulePdfLayout(null), colorTreatment: 'strong' as const}
  assert.deepEqual(configuredSchedulePdfLayout({pdfLayout: layout}), layout)
  assert.throws(() => configuredSchedulePdfLayout({pdfLayout: {...layout, marginMm: -1}}))
})
