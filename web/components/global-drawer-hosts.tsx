'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState, type ComponentProps } from 'react'
import { useSearchParams } from 'next/navigation'
import { useReportOverlay } from './navigation-provider'

/**
 * The shell's URL-driven overlays. Their record drawers compose most of the
 * party, transaction and report UI, so the shell mounts each host only once
 * the URL first asks for it and fetches the code while the browser is idle.
 * A host stays mounted after its first open so its close transition runs.
 */

const loadPartyHost = () => import('./global-party-drawer-host')
const loadReportHost = () => import('./global-report-drawer-host')

const PartyDrawerHost = dynamic(() => loadPartyHost().then((m) => m.GlobalPartyDrawerHost), { ssr: false })
const ReportDrawerHost = dynamic(() => loadReportHost().then((m) => m.GlobalReportDrawerHost), { ssr: false })

function useOpenedOnce(requested: boolean, preload: () => Promise<unknown>): boolean {
  const [opened, setOpened] = useState(requested)
  if (requested && !opened) setOpened(true)
  useEffect(() => {
    if (opened) return
    const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => void preload())
    return () => cancel(handle)
  }, [opened, preload])
  return opened
}

export function GlobalPartyDrawer(props: ComponentProps<typeof PartyDrawerHost>) {
  const opened = useOpenedOnce(useSearchParams().has('relatedParty'), loadPartyHost)
  return opened ? <PartyDrawerHost {...props} /> : null
}

export function GlobalReportDrawer() {
  const { search } = useReportOverlay()
  const params = new URLSearchParams(search)
  const opened = useOpenedOnce(params.has('reportDrill') || params.has('reportRecord'), loadReportHost)
  return opened ? <ReportDrawerHost /> : null
}
