import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveText } from '@braedonsaunders/appkit-viewspec'
import { createAppStarter, starterTitleState } from './starter'
import { parseNativeExtension } from './native-ui'

/**
 * UX-04: renaming a fresh app starter must move the visible title, while a
 * deliberately customized title must survive a rename. The native starter
 * binds its page header to the app name at render time; the sandbox starter
 * binds its heading through a marker the runtime fills from the bridge
 * context. Neither path rewrites author-owned strings.
 */

const RENAMED = 'Acme Widgets'

function nativeHeaderTitle(starter: ReturnType<typeof createAppStarter>) {
  const uiFile = starter.files.find((file) => file.path === 'frontend/ui.json')
  assert.ok(uiFile, 'native starter ships frontend/ui.json')
  // The starter document must satisfy the same schema the runtime enforces.
  const ui = parseNativeExtension(uiFile.content)
  const home = ui.screens[0]
  assert.ok(home && home.kind === 'page', 'starter opens on a page screen')
  const header = home.spec.header[0]
  assert.ok(header, 'starter page has a header')
  assert.equal(header.kind, 'page-header')
  return header.title
}

test('UX-04: a renamed native starter renders the new app name as its heading', () => {
  const title = nativeHeaderTitle(createAppStarter('native'))
  // Runtime scope is { name, description, key }; see NativeScreens.
  assert.equal(
    resolveText(title, { name: RENAMED, description: null, key: 'acme' }),
    RENAMED,
  )
})

test('UX-04: a customized native screen title survives a rename', () => {
  const starter = createAppStarter('native')
  const uiFile = starter.files.find((file) => file.path === 'frontend/ui.json')!
  const customized = JSON.parse(uiFile.content) as {
    screens: { kind: string; spec?: { header?: { title?: unknown }[] } }[]
  }
  customized.screens[0]!.spec!.header![0]!.title = 'Acme dashboard'
  const ui = parseNativeExtension(JSON.stringify(customized))
  const home = ui.screens[0]
  assert.ok(home && home.kind === 'page')
  const header = home.spec.header[0]
  assert.ok(header)
  assert.equal(header.kind, 'page-header')
  assert.equal(
    resolveText(header.title, {
      name: RENAMED,
      description: null,
      key: 'acme',
    }),
    'Acme dashboard',
  )
})

interface FakeHeading {
  textContent: string | null
}

interface FakeDocument {
  readyState: string
  title: string
  heading: FakeHeading | null
  listeners: Record<string, () => void>
  querySelector(selector: string): FakeHeading | null
  addEventListener(event: string, listener: () => void): void
}

function fakeDocument(
  headingText: string | null,
  title: string,
  markerPresent = true,
): FakeDocument {
  const document: FakeDocument = {
    readyState: 'complete',
    title,
    heading: headingText === null ? null : { textContent: headingText },
    listeners: {},
    querySelector(selector: string) {
      // No marker in the document, no match — mirroring querySelector.
      if (!markerPresent) return null
      return selector === '[data-app-title]' ? document.heading : null
    },
    addEventListener(event: string, listener: () => void) {
      document.listeners[event] = listener
    },
  }
  return document
}

/** Run the starter app.js against a minimal DOM with the given bridge name. */
function runStarterScript(
  starter: ReturnType<typeof createAppStarter>,
  document: FakeDocument,
  appName: string | null,
) {
  const appJs = starter.files.find((file) => file.path === 'frontend/app.js')
  assert.ok(appJs, 'sandbox starter ships frontend/app.js')
  const window = {
    openbooks:
      appName === null
        ? undefined
        : { context: { app: { name: appName } } },
  }
  new Function('window', 'document', appJs.content)(
    window,
    document as unknown as Document,
  )
}

test('UX-04: a renamed sandbox starter renders the new app name', () => {
  const starter = createAppStarter('sandbox')
  const entry = starter.files.find(
    (file) => file.path === 'frontend/index.html',
  )!
  assert.match(entry.content, /data-app-title/, 'heading carries the binding marker')
  const document = fakeDocument('My app', 'My app')
  runStarterScript(starter, document, RENAMED)
  assert.equal(document.heading?.textContent, RENAMED)
  assert.equal(document.title, RENAMED)
})

test('UX-04: a customized sandbox heading and document title survive a rename', () => {
  const starter = createAppStarter('sandbox')
  const entry = starter.files.find(
    (file) => file.path === 'frontend/index.html',
  )!
  // The author customized the heading and dropped the binding marker.
  const customized = entry.content.replace(' data-app-title', '')
  assert.doesNotMatch(customized, /data-app-title/)
  const starterFiles = starter.files.map((file) =>
    file.path === 'frontend/index.html'
      ? { ...file, content: customized }
      : file,
  )
  assert.equal(starterTitleState(starterFiles, { renderer: 'sandbox', entry: entry.path }), 'custom')
  const document = fakeDocument('Acme dispatch board', 'Acme dispatch', false)
  runStarterScript({ ...starter, files: starterFiles }, document, RENAMED)
  assert.equal(document.heading?.textContent, 'Acme dispatch board')
  assert.equal(document.title, 'Acme dispatch')
})

test('UX-04: the starter detector reports follows-name for both fresh starters', () => {
  const native = createAppStarter('native')
  assert.equal(
    starterTitleState(native.files, { renderer: 'native', entry: 'frontend/ui.json' }),
    'follows-name',
  )
  const sandbox = createAppStarter('sandbox')
  assert.equal(
    starterTitleState(sandbox.files, { renderer: 'sandbox', entry: 'frontend/index.html' }),
    'follows-name',
  )
})

test('UX-04: the starter detector reports unknown when the entry is missing', () => {
  const native = createAppStarter('native')
  assert.equal(
    starterTitleState(
      native.files.filter((file) => file.path !== 'frontend/ui.json'),
      { renderer: 'native', entry: 'frontend/ui.json' },
    ),
    'unknown',
  )
})

test('UX-04: the sandbox detector reports custom once the binder is gone', () => {
  const sandbox = createAppStarter('sandbox')
  // Marker kept but the script that fills it deleted: the heading no longer
  // follows, so the editor must not promise that it does.
  const withoutBinder = sandbox.files.filter(
    (file) => file.path !== 'frontend/app.js',
  )
  assert.equal(
    starterTitleState(withoutBinder, {
      renderer: 'sandbox',
      entry: 'frontend/index.html',
    }),
    'custom',
  )
})
