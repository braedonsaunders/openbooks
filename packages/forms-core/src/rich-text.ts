import { z } from 'zod'

/** Explicit formatting over text; arbitrary HTML, images and styles are never message input. */
export function safeRichTextLink(value: string): boolean {
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}
export const richTextSpanSchema = z.strictObject({
  text: z.string().max(4000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  href: z.string().max(2048).refine(safeRichTextLink, 'Choose an explicit HTTPS, HTTP or mail link.').optional(),
})
export const richTextDocumentSchema = z.strictObject({
  version: z.literal(1),
  blocks: z.array(z.strictObject({
    kind: z.enum(['paragraph', 'bullet', 'number']),
    spans: z.array(richTextSpanSchema).max(200),
  })).max(200),
}).refine(value => value.blocks.reduce((total, block) => total + block.spans.length, 0) <= 500, 'The message has too many formatting segments.').refine(value => richTextPlainText(value).length <= 4000, 'The message must contain at most 4000 characters.')
export type RichTextDocument = z.infer<typeof richTextDocumentSchema>
export type RichTextSpan = z.infer<typeof richTextSpanSchema>
export function richTextPlainText(value: { blocks: { kind: string; spans: { text: string; href?: string }[] }[] }): string {
  let number = 0
  return value.blocks.map(block => {
    number = block.kind === 'number' ? number + 1 : 0
    const prefix = block.kind === 'bullet' ? '• ' : block.kind === 'number' ? `${number}. ` : ''
    return prefix + block.spans.map(span => span.text + (span.href && span.href !== span.text ? ` (${span.href})` : '')).join('')
  }).join('\n')
}
export function plainTextDocument(text: string): RichTextDocument {
  return { version: 1, blocks: text.split('\n').map(text => ({kind: 'paragraph', spans: [{text}]})) }
}
