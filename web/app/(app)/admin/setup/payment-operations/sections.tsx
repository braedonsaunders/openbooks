'use client'

import Link from 'next/link'
import { useViewerFormat } from '../../../../../lib/viewer-format'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { SetupEditor } from './PaymentOperationsSetup'
import type { PaymentOperationsData } from './view'

/**
 * Client composites the payment setup page specs place by name:
 *
 * - `PaymentScheduleNextRun`: the schedules "Next run" cell, formatted in the
 *   viewer's locale and timezone from the raw ISO value the loader passes.
 * - `NewSetupRecordButton`: the per-view "New …" button with its plus icon.
 * - `PaymentOperationsEditor`: the create/edit drawer with its per-view field
 *   sets. It owns fetch flows and client form state a spec cannot name, so
 *   the spec places it whole over loader-resolved props.
 */

/**
 * The schedules "Next run" cell. The native row formats `next_run_at`
 * client-side with `new Date(value).toLocaleString()`, falling back to an
 * em-dash — browser locale and timezone, not the server's. This cell runs
 * the identical expression so the spec render matches byte for byte.
 */
export function PaymentScheduleNextRun({ value }: { value: string | null }) {
  const { dateTime } = useViewerFormat()
  return <>{value ? dateTime(new Date(value)) : '—'}</>
}

export function NewSetupRecordButton({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild>
      <Link href={href as never}><Plus size={15} />{label}</Link>
    </Button>
  )
}

export function PaymentOperationsEditor({
  editor,
}: {
  editor: NonNullable<PaymentOperationsData['editor']>
}) {
  return (
    <SetupEditor
      view={editor.view}
      row={editor.row}
      creating={editor.creating}
      options={editor.options}
      closeHref={editor.closeHref}
      multiCurrency={editor.multiCurrency}
    />
  )
}
