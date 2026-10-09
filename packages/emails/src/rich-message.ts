import { richTextDocumentSchema, richTextPlainText, type RichTextDocument } from '@openbooks/forms-core'
import { esc } from './shell'

/** Typed content is revalidated at delivery; only escaped text and allow-listed formatting are emitted. */
export function richMessageParts(value: RichTextDocument): { html: string; text: string } {
  const document = richTextDocumentSchema.parse(value)
  let list: 'bullet' | 'number' | null = null
  let html = ''
  for (const block of document.blocks) {
    if (list !== block.kind) {
      if (list) html += list === 'bullet' ? '</ul>' : '</ol>'
      list = block.kind === 'paragraph' ? null : block.kind
      if (list) html += list === 'bullet' ? '<ul>' : '<ol>'
    }
    const content = block.spans.map(span => {
      let text = esc(span.text).replace(/\n/g, '<br>')
      if (span.bold) text = `<strong>${text}</strong>`
      if (span.italic) text = `<em>${text}</em>`
      if (span.underline) text = `<u>${text}</u>`
      if (span.href) text = `<a href="${esc(span.href)}" rel="noopener noreferrer">${text}</a>`
      return text
    }).join('')
    html += list ? `<li>${content || '<br>'}</li>` : `<p>${content || '<br>'}</p>`
  }
  if (list) html += list === 'bullet' ? '</ul>' : '</ol>'
  return {html, text: richTextPlainText(document)}
}
