'use client'

import { useEffect } from 'react'

/**
 * Keeps the browser tab aligned with the title already rendered by a page.
 *
 * Applications can set `data-application-name` on the root `<html>` element
 * to retain their brand in the tab title. Keeping the page title as the input
 * means callers continue to use their existing translated or record-derived
 * heading instead of maintaining a second title registry.
 */
export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    const applicationName = document.documentElement.dataset.applicationName
    document.title = applicationName ? `${title} · ${applicationName}` : title
  }, [title])

  return null
}
