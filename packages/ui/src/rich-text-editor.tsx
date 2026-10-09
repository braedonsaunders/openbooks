'use client'
import { useLayoutEffect, useRef, useState } from 'react'
import { richTextDocumentSchema, safeRichTextLink, type RichTextDocument, type RichTextSpan } from '@openbooks/forms-core'
import { Button } from './button'
import { Input } from './input'

/** Read only text and explicit formatting. Pasted resources, event attributes and styles are discarded. */
export function readRichTextDocument(root: HTMLElement): RichTextDocument {
  const blocks: RichTextDocument['blocks'] = []
  function spans(node: Node, marks: Omit<RichTextSpan, 'text'> = {}): RichTextSpan[] {
    if (node.nodeType === 3) return node.textContent ? [{...marks, text: node.textContent}] : []
    if (node.nodeType !== 1) return []
    const element = node as HTMLElement, tag = element.tagName.toLowerCase()
    if (['script','style','iframe','object','svg','img','video','audio','template'].includes(tag)) return []
    if (tag === 'br') return [{...marks, text: '\n'}]
    const href = element.getAttribute('href')
    const next = {...marks,
      ...(['b','strong'].includes(tag) ? {bold: true} : {}),
      ...(['i','em'].includes(tag) ? {italic: true} : {}),
      ...(tag === 'u' ? {underline: true} : {}),
      ...(tag === 'a' && href && safeRichTextLink(href) ? {href} : {}),
    }
    return [...node.childNodes].flatMap(child => spans(child, next))
  }
  let inline: RichTextSpan[] = []
  function flush() { if (inline.length) { blocks.push({kind: 'paragraph', spans: inline}); inline = [] } }
  for (const node of root.childNodes) {
    const element = node.nodeType === 1 ? node as HTMLElement : null
    if (element && ['UL','OL'].includes(element.tagName)) {
      flush()
      for (const child of element.children) if (child.tagName === 'LI') blocks.push({kind: element.tagName === 'UL' ? 'bullet' : 'number', spans: spans(child)})
    } else if (element && ['P','DIV'].includes(element.tagName)) {
      flush(); blocks.push({kind: 'paragraph', spans: spans(element)})
    } else inline.push(...spans(node))
  }
  flush()
  return richTextDocumentSchema.parse({version: 1, blocks})
}
function writeDocument(root: HTMLElement, value: RichTextDocument) {
  root.replaceChildren()
  let list: HTMLElement | null = null, kind: string | null = null
  for (const block of value.blocks) {
    if (block.kind !== kind) { list = null; kind = block.kind }
    if (block.kind !== 'paragraph' && !list) { list = document.createElement(block.kind === 'bullet' ? 'ul' : 'ol'); root.append(list) }
    const line = document.createElement(list ? 'li' : 'p')
    for (const span of block.spans) {
      let child: Node = document.createTextNode(span.text)
      for (const [mark, tag] of [['bold','strong'],['italic','em'],['underline','u']] as const) if (span[mark]) { const wrapper = document.createElement(tag); wrapper.append(child); child = wrapper }
      if (span.href && safeRichTextLink(span.href)) { const link = document.createElement('a'); link.href = span.href; link.append(child); child = link }
      line.append(child)
    }
    if (!line.childNodes.length) line.append(document.createElement('br'))
    ;(list ?? root).append(line)
  }
}
export function RichTextEditor({value, onChange, disabled = false, label, labels, onValidityChange}: {
  value: RichTextDocument; onChange: (value: RichTextDocument) => void; disabled?: boolean; label: string
  onValidityChange?: (valid: boolean) => void
  labels: {bold: string; italic: string; underline: string; bullets: string; numbered: string; link: string; linkAddress: string; apply: string; invalid: string}
}) {
  const ref = useRef<HTMLDivElement>(null), last = useRef('')
  const selection = useRef<Range | null>(null)
  const [linkOpen, setLinkOpen] = useState(false), [href, setHref] = useState(''), [error, setError] = useState(false)
  useLayoutEffect(() => {
    const serialized = JSON.stringify(value)
    if (ref.current && serialized !== last.current) { writeDocument(ref.current, value); last.current = serialized }
  }, [value])
  function changed() {
    if (!ref.current || disabled) return
    try { const next = readRichTextDocument(ref.current); last.current = JSON.stringify(next); onChange(next); setError(false); onValidityChange?.(true) }
    catch { setError(true); onValidityChange?.(false) }
  }
  function rememberSelection() {
    const current = window.getSelection()
    const range = current?.rangeCount ? current.getRangeAt(0) : null
    selection.current = range && ref.current?.contains(range.commonAncestorContainer) ? range.cloneRange() : null
  }
  function command(name: string, argument?: string) {
    if (disabled || !ref.current) return
    ref.current.focus()
    if (selection.current && ref.current.contains(selection.current.commonAncestorContainer)) { const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(selection.current) }
    if (typeof document.execCommand !== 'function') { setError(true); onValidityChange?.(false); return }
    document.execCommand(name, false, argument)
    changed()
  }
  return <div className="space-y-2">
    <div role="toolbar" aria-label={label} className="flex flex-nowrap gap-1 overflow-x-auto">
      {([['bold', labels.bold], ['italic', labels.italic], ['underline', labels.underline], ['insertUnorderedList', labels.bullets], ['insertOrderedList', labels.numbered]] as const).map(([name, text]) =>
        <Button key={name} type="button" size="sm" variant="ghost" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => command(name)}>{text}</Button>)}
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { rememberSelection(); setLinkOpen(value => !value) }}>{labels.link}</Button>
    </div>
    {linkOpen ? <div className="flex min-w-0 gap-2"><Input aria-label={labels.linkAddress} value={href} disabled={disabled} onChange={event => setHref(event.target.value)} /><Button type="button" size="sm" variant="outline" disabled={disabled || !safeRichTextLink(href)} onClick={() => { command('createLink', href); setLinkOpen(false); setHref('') }}>{labels.apply}</Button></div> : null}
    <div ref={ref} role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled} aria-invalid={error} tabIndex={disabled ? -1 : 0} contentEditable={!disabled} suppressContentEditableWarning
      className="min-h-28 break-words rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-teal-500/40 dark:border-slate-700 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_a]:text-teal-600 [&_a]:underline"
      onInput={changed} onMouseUp={rememberSelection} onKeyUp={rememberSelection}
      onPaste={event => { event.preventDefault(); if (!disabled) { rememberSelection(); command('insertText', event.clipboardData.getData('text/plain')) } }} onDrop={event => event.preventDefault()} />
    {error ? <p role="alert" className="text-sm text-red-600">{labels.invalid}</p> : null}
  </div>
}
