import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactNode } from 'react'
import { stubModules } from '../../testing/stub-modules'
stubModules({navigation: true})
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
import { scheduleWindow } from '../../testing/schedule-window'
await bootJsdomEnvironment({event: 'jsdom'})
const React = await import('react')
Object.assign(globalThis, {React})
const {createRoot} = await import('react-dom/client'), {act} = React
const {NextIntlClientProvider} = await import('next-intl')
const messages = (await import('../../messages/en')).default
const {EmailScheduleDrawer} = await import('./EmailScheduleDrawer')
const {DownloadScheduleDrawer} = await import('./DownloadScheduleDrawer')
const {RichTextEditor, readRichTextDocument} = await import('@openbooks/ui')
const {plainTextDocument} = await import('@openbooks/forms-core')
const labels = messages.scheduling.distribution
async function mount(t: {after: (cb: () => Promise<void>) => void}, element: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages}>{element}</NextIntlClientProvider>))
  t.after(async () => {await act(async () => root.unmount()); host.remove()})
  return {host, root}
}
function nativeSelect(label: string): HTMLSelectElement {
  const control = document.querySelector(`[aria-label="${label}"]`)!
  return control.tagName === 'SELECT' ? control as HTMLSelectElement : control.parentElement!.querySelector('select')!
}
async function select(label: string, value: string) {
  const control = nativeSelect(label)
  await act(async () => {control.value = value; control.dispatchEvent(new window.Event('change', {bubbles: true}))})
}
function button(text: string) { return [...document.querySelectorAll('button')].find(button => button.textContent === text)! }

test('email recipients stay in one borderless native section before PDF/message; rich drafts survive recipient changes and reviewed selectors stay in that section', async t => {
  const original = globalThis.fetch, requests: Record<string, any>[] = []
  const board = {...scheduleWindow(), canManage: true}
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({contacts: [], roles: [{key: 'manager', name: 'Managers'}], more: false})
    const body = JSON.parse(String(init.body)); requests.push(body)
    return Response.json({boardId: board.board.id, boardName: 'Crew', organizationName: 'Org', from: board.from, through: board.through, timeZone: 'UTC', version: 'a'.repeat(64), generatedAt: new Date().toISOString(), audience: body.audience, recipients: [{partyId: board.rows[0]!.subjectId, name: 'Alex', email: 'alex@example.test', contacts: [], subjects: [{id: board.rows[0]!.subjectId, name: 'Alex', kind: 'person'}], lines: []}], refusals: []})
  }
  t.after(() => {globalThis.fetch = original})
  await mount(t, <EmailScheduleDrawer window={board} onClose={() => {}} />)
  const section = document.querySelector('[data-schedule-recipients]')!
  const attachment = document.querySelector('[data-schedule-attachment]')!
  const message = document.querySelector('[data-schedule-message]')!
  assert.equal(section.nextElementSibling, attachment)
  assert.equal(attachment.nextElementSibling, message)
  assert.ok(!section.className.includes('rounded'))
  assert.ok(!attachment.querySelector('fieldset')!.className.includes('rounded'))
  assert.equal(section.querySelectorAll('input[type="checkbox"]').length, board.rows.length)
  const editor = message.querySelector('[role="textbox"]') as HTMLElement
  await act(async () => {editor.innerHTML = '<p><strong>Bring &lt;tools&gt;</strong></p>'; editor.dispatchEvent(new window.Event('input', {bubbles: true}))})
  await select(labels.sharing, 'board')
  await select(labels.recipientMode, 'combined')
  assert.ok(section.contains(document.querySelector(`[aria-label="${labels.nativeContacts}"]`)))
  assert.ok(section.contains(document.querySelector(`[aria-label="${labels.additionalRoles}"]`)))
  assert.equal(editor.textContent, 'Bring <tools>')
  await act(async () => {button(labels.preview).click()})
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.audience.message, 'Bring <tools>')
  assert.equal(requests[0]!.audience.messageContent.blocks[0].spans[0].bold, true)
  assert.ok(section.querySelector('[data-reviewed-recipients]'))
  assert.ok(section.querySelector('[data-reviewed-recipients] select'))
  assert.ok(document.querySelector('iframe')!.getAttribute('sandbox') === '')
  await act(async () => {editor.innerHTML = '<p>Changed draft</p>'; editor.dispatchEvent(new window.Event('input', {bubbles: true}))})
  assert.equal(section.querySelector('[data-reviewed-recipients]'), null)
  assert.equal(button(labels.send).disabled, true)
})

test('shared editor reads actual formatting without resources/executable links and busy mode preserves draft while preventing changes', async t => {
  const probe = document.createElement('div')
  probe.innerHTML = '<p onclick="x()"><b>Bold</b><img src=x onerror=x()><script>secret()</script><a href="javascript:x()">Bad link</a><a href="https://example.test">Safe</a></p><ul><li><i>Item</i></li></ul>'
  const doc = readRichTextDocument(probe)
  assert.equal(doc.blocks[0]!.spans.map(span => span.text).join(''), 'BoldBad linkSafe')
  assert.equal(doc.blocks[0]!.spans[0]!.bold, true)
  assert.equal(doc.blocks[0]!.spans.find(span => span.text === 'Bad link')!.href, undefined)
  assert.equal(doc.blocks[0]!.spans.find(span => span.text === 'Safe')!.href, 'https://example.test')
  assert.equal(doc.blocks[1]!.kind, 'bullet')
  let writes = 0
  const {host, root} = await mount(t, <RichTextEditor label="Message" value={doc} labels={labels.editor} onChange={() => {writes++}} />)
  const editable = host.querySelector('[role="textbox"]')!
  assert.equal(editable.querySelectorAll('script,img').length, 0)
  await act(async () => root.render(<RichTextEditor label="Message" value={doc} labels={labels.editor} disabled onChange={() => {writes++}} />))
  assert.equal(editable.getAttribute('contenteditable'), 'false')
  assert.ok([...host.querySelectorAll('button')].every(button => button.disabled))
  await act(async () => {editable.dispatchEvent(new window.Event('input', {bubbles: true}))})
  assert.equal(writes, 0)
  assert.equal(editable.textContent, 'BoldBad linkSafeItem')
  assert.equal(readRichTextDocument(Object.assign(document.createElement('div'), {textContent: '<b>Literal</b>'})).blocks[0]!.spans[0]!.text, plainTextDocument('<b>Literal</b>').blocks[0]!.spans[0]!.text)
})

test('standalone PDF host uses board report only, keeps one drawer and invalidates version when configured layout changes', async t => {
  const original = globalThis.fetch, requests: {url: string; body: any}[] = []
  const board = scheduleWindow()
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({url: String(url), body})
    return Response.json({boardId: board.board.id, boardName: 'Crew', ...body, timeZone: 'UTC', version: 'b'.repeat(64), lines: [{date: board.from, subject: 'Alex', assignment: 'SHOP/ N', hours: 'Hours unknown'}]})
  }
  t.after(() => {globalThis.fetch = original})
  await mount(t, <DownloadScheduleDrawer window={board} onClose={() => {}} />)
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
  assert.equal(document.querySelector('[data-schedule-recipients]'), null)
  assert.equal(button(labels.downloadPdf).disabled, true)
  await act(async () => {button(labels.preview).click()})
  assert.equal(requests.length, 1)
  assert.ok(requests[0]!.url.endsWith('/report'))
  assert.equal(requests[0]!.body.audience, undefined)
  assert.equal(requests[0]!.body.partyId, undefined)
  assert.equal(requests[0]!.body.from, board.from)
  assert.equal(button(labels.downloadPdf).disabled, false)
  assert.ok(document.body.textContent?.includes('Hours unknown'))
  await select(labels.pdfFields.colorTreatment, 'strong')
  assert.equal(button(labels.downloadPdf).disabled, true)
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
})


test('shared editor contains formatting/link selections and pastes plain text; invalid rich input blocks review without losing its editable draft', async t => {
  const originalCommand = document.execCommand
  const calls: string[] = []
  // Browser editing commands are the external boundary; document extraction/schema/rendering are actual.
  document.execCommand = ((command: string, _show?: boolean, value?: string) => {
    calls.push(command)
    const selection = window.getSelection()!, range = selection.getRangeAt(0)
    const fragment = range.extractContents()
    let node: Node
    if (command === 'insertText') node = document.createTextNode(value ?? '')
    else {const wrapper = document.createElement(command === 'bold' ? 'strong' : 'a'); if (command === 'createLink') wrapper.setAttribute('href', value ?? ''); wrapper.append(fragment); node = wrapper}
    range.insertNode(node); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range)
    return true
  }) as typeof document.execCommand
  t.after(() => {document.execCommand = originalCommand})
  let value = plainTextDocument('Draft'), valid = true
  const {host} = await mount(t, <RichTextEditor label="Message" value={value} labels={labels.editor} onChange={next => {value = next}} onValidityChange={next => {valid = next}} />)
  const editor = host.querySelector('[role="textbox"]') as HTMLElement
  function selectText() {const range = document.createRange(); range.selectNodeContents(editor.querySelector('p')!); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); editor.dispatchEvent(new window.MouseEvent('mouseup', {bubbles: true}))}
  await act(async () => {selectText(); button(labels.editor.bold).click()})
  assert.equal(value.blocks[0]!.spans[0]!.bold, true)
  assert.equal(valid, true)
  await act(async () => {selectText(); button(labels.editor.link).click()})
  const link = host.querySelector(`input[aria-label="${labels.editor.linkAddress}"]`) as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(link, 'https://example.test/crew')
    link.dispatchEvent(new window.Event('input', {bubbles: true}))
  })
  await act(async () => {button(labels.editor.apply).click()})
  assert.equal(value.blocks[0]!.spans[0]!.href, 'https://example.test/crew')
  const paste = new window.Event('paste', {bubbles: true, cancelable: true})
  Object.defineProperty(paste, 'clipboardData', {value: {getData: (type: string) => type === 'text/plain' ? '<img src=x onerror=bad()>' : '<b>unsafe resource</b>'}})
  await act(async () => {selectText(); editor.dispatchEvent(paste)})
  assert.equal(editor.querySelector('img'), null)
  assert.equal(value.blocks[0]!.spans.map(span => span.text).join(''), '<img src=x onerror=bad()>')
  assert.deepEqual(calls, ['bold', 'createLink', 'insertText'])
  await act(async () => {editor.textContent = 'x'.repeat(4001); editor.dispatchEvent(new window.Event('input', {bubbles: true}))})
  assert.equal(valid, false)
  assert.equal(editor.textContent!.length, 4001, 'invalid text remains editable rather than silently truncated')
  assert.equal(host.querySelectorAll('[role="alert"]').length, 1)
  await act(async () => {editor.textContent = 'Corrected'; editor.dispatchEvent(new window.Event('input', {bubbles: true}))})
  assert.equal(valid, true)
  assert.equal(value.blocks[0]!.spans[0]!.text, 'Corrected')
})
