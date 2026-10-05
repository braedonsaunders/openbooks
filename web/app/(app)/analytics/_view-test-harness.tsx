import type { ReactElement } from 'react'

/**
 * Shared render harness for the Analytics dashboard view tests: jsdom boot,
 * module stubs, providers, act-wrapped clicks, mounted hosts and
 * CSV-download capture. One copy so the spend and vendor suites do not each
 * carry it (and the test-line budget counts it once, here, outside any
 * *.test.* file).
 */

export async function bootViewTests(url: string): Promise<void> {
  const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
  await bootJsdomEnvironment({ url, matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@openbooks/analytics/viz') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,export function InsightChart(){return null}export function InsightResultView(){return null}',
        }
      }
      // Configuration tabs host the shared threshold editor, which reads
      // the Next app router: outside a mounted router it gets a no-op stub.
      if (specifier === 'next/navigation') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,export function useRouter(){return{refresh(){},push(){},replace(){},prefetch(){},back(){},forward(){}}}export function usePathname(){return"/"}export function useSearchParams(){return new URLSearchParams()}',
        }
      }
      return next(specifier, context)
    },
  })
  const React = await import('react')
  Object.assign(globalThis, { React })
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountedProviders(): Promise<{
  providers: (ui: ReactElement) => ReactElement
  click: (el: Element) => Promise<void>
  createRoot: (typeof import('react-dom/client'))['createRoot']
  act: (typeof import('react'))['act']
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { NextIntlClientProvider } = await import('next-intl')
  const messages = (await import('../../../messages/en')).default
  const { MoneyProvider } = await import('../../../components/money-provider')
  const { BusinessDateProvider } = await import('../../../components/business-date-provider')
  return {
    providers: (ui: ReactElement) => (
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-08-28">{ui}</BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>
    ),
    click: async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await tick()
      })
      await tick()
    },
    createRoot,
    act,
  }
}

/** Mounted view host plus interaction and teardown, optionally on a named tab. */
export async function mountView(
  ui: ReactElement,
  tab?: string,
): Promise<{ host: HTMLElement; click: (el: Element) => Promise<void>; cleanup: () => Promise<void> }> {
  const { providers, click, createRoot, act } = await mountedProviders()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(providers(ui))
    await tick()
  })
  await tick()
  if (tab) {
    const tabButton = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === tab || b.textContent?.startsWith(tab),
    )
    if (!tabButton) throw new Error(`the ${tab} tab must exist`)
    await click(tabButton)
  }
  return {
    host,
    click,
    cleanup: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

/** Capture the next CSV download: the blob text, filename and object URL. */
export async function captureCsvDownload(
  clickExport: () => Promise<void>,
  blobUrl = 'blob:captured-export-test',
): Promise<{ text: string; downloadedFile: string; clickedHref: string }> {
  let blob: Blob | undefined
  let downloadedFile = ''
  let clickedHref = ''
  const realCreateObjectURL = URL.createObjectURL
  const realRevokeObjectURL = URL.revokeObjectURL
  const realCreate = document.createElement.bind(document)
  URL.createObjectURL = (value: Blob) => {
    blob = value
    return blobUrl
  }
  URL.revokeObjectURL = () => {}
  document.createElement = ((tag: string, opts?: ElementCreationOptions) => {
    const el = realCreate(tag, opts)
    if (tag === 'a') {
      const anchor = el as HTMLAnchorElement
      anchor.click = () => {
        clickedHref = anchor.href
        downloadedFile = anchor.download
      }
    }
    return el
  }) as typeof document.createElement
  try {
    await clickExport()
  } finally {
    document.createElement = realCreate
    URL.createObjectURL = realCreateObjectURL
    URL.revokeObjectURL = realRevokeObjectURL
  }
  if (!blob) throw new Error('the export must produce a download blob')
  return { text: await blob.text(), downloadedFile, clickedHref }
}
