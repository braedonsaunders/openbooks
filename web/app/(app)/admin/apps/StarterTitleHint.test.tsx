import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import enMessages from '../../../../messages/en'
import { createAppStarter } from '../../../../lib/apps/starter'
import { StarterTitleHint } from './StarterTitleHint'

/**
 * UX-04: the package editor guides the author from the General name field to
 * the separate screen-title surface. The hint names which heading renaming
 * will move (or that the heading is custom), per renderer.
 */

function render(
  renderer: 'native' | 'sandbox',
  mutate?: (files: { path: string; content: string }[]) => void,
): string {
  const starter = createAppStarter(renderer)
  const files = starter.files.map((file) => ({ ...file }))
  mutate?.(files)
  const manifest = {
    ...(starter.manifest as Record<string, unknown>),
    frontend: {
      renderer,
      entry: renderer === 'native' ? 'frontend/ui.json' : 'frontend/index.html',
    },
  }
  // The provider's overloads only accept children inside the props object.
  /* eslint-disable react/no-children-prop */
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: enMessages,
      timeZone: 'UTC',
      children: createElement(StarterTitleHint, {
        files,
        manifest: manifest as never,
      }),
    }),
    /* eslint-enable react/no-children-prop */
  )
}

test('UX-04: a fresh native starter hints that the heading follows the app name', () => {
  const html = render('native')
  assert.match(html, /follows the app name/)
  assert.match(html, /under Screens/)
})

test('UX-04: a fresh sandbox starter hints at the marker binding', () => {
  const html = render('sandbox')
  assert.match(html, /follows the app name/)
  assert.match(html, /data-app-title/)
})

test('UX-04: a customized title hints that renaming leaves it unchanged', () => {
  const html = render('native', (files) => {
    const ui = files.find((file) => file.path === 'frontend/ui.json')!
    const parsed = JSON.parse(ui.content) as {
      screens: { spec: { header: { title: unknown }[] } }[]
    }
    parsed.screens[0]!.spec.header[0]!.title = 'Acme dashboard'
    ui.content = JSON.stringify(parsed)
  })
  assert.match(html, /custom text/)
  assert.match(html, /leaves the heading unchanged/)
})

test('UX-04: no hint renders when the entry cannot be recognized', () => {
  const html = render('native', (files) => {
    const index = files.findIndex(
      (file) => file.path === 'frontend/ui.json',
    )
    files.splice(index, 1)
  })
  assert.equal(html, '')
})
