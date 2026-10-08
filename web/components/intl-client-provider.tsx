'use client'

import { use, type ReactNode } from 'react'
import { NextIntlClientProvider } from 'next-intl'

type Messages = Record<string, unknown>

/**
 * Client message provider. The catalog travels as a separately cached,
 * content-versioned resource instead of inside every server-rendered payload:
 * a document load, a refresh and every server-action response would otherwise
 * carry the whole catalog again.
 *
 * Server rendering reads the catalog the root layout published for this
 * version. The browser fetches it once per version; the HTTP cache serves
 * every later load until the catalog changes.
 */
export function IntlClientProvider({
  locale,
  timeZone,
  version,
  url,
  children,
}: {
  locale: string
  timeZone: string
  version: string
  url: string
  children: ReactNode
}) {
  const messages = typeof window === 'undefined' ? publishedCatalog(version) : use(browserCatalog(url))
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone} messages={messages}>
      {children}
    </NextIntlClientProvider>
  )
}

const PUBLISHED_CATALOGS = Symbol.for('openbooks.i18n.client-catalogs')

function publishedCatalog(version: string): Messages {
  const catalogs = (globalThis as { [PUBLISHED_CATALOGS]?: Map<string, Messages> })[PUBLISHED_CATALOGS]
  const messages = catalogs?.get(version)
  if (!messages) throw new Error(`Message catalog ${version} was not published for server rendering`)
  return messages
}

const browserCatalogs = new Map<string, Promise<Messages>>()

function browserCatalog(url: string): Promise<Messages> {
  let catalog = browserCatalogs.get(url)
  if (!catalog) {
    catalog = fetch(url, { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) throw new Error(`Message catalog request failed with status ${response.status}`)
      return (await response.json()) as Messages
    })
    browserCatalogs.set(url, catalog)
    // A failed load is retried by the next render rather than remembered.
    catalog.catch(() => browserCatalogs.delete(url))
  }
  return catalog
}
