'use client'

/**
 * Shared presentational cells for /admin/extensions, used by the native page and
 * the ViewSpec path alike so the two renders stay byte-identical.
 */

export function AppKeyCell({ appKey }: { appKey: string }) {
  return <code className="text-xs text-slate-500">{appKey}</code>
}
