import Link from 'next/link'
import { Badge } from '@openbooks/ui'
import type { ComponentProps } from 'react'
import { AutomationApprovalSettings, AutomationRowActions, NewAutomationButton } from './AutomationsClient'

/**
 * The automations list's composite cells, mirroring the flows list cells:
 * the name link, the status chip, the last-run badge pair, the error text,
 * and the row actions (enable/disable/run-now). One implementation shared
 * by the page and the widget registry — never a second copy.
 */

export function AutomationNameCell({ name, href }: { name: string; href: string }) {
  return (
    <Link
      href={href}
      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
    >
      {name}
    </Link>
  )
}

export function AutomationStatusCell({
  status,
  label,
  variant,
}: {
  status: string
  label: string
  variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
}) {
  void status
  return <Badge variant={variant}>{label}</Badge>
}

export function AutomationLastRunCell({
  at,
  fallback,
}: {
  at: string | null
  fallback: string
}) {
  if (at === null) return <>{fallback}</>
  return <span className="tabular-nums">{at}</span>
}

export function AutomationRowActionsCell({
  id,
  status,
  runLabel,
  enableLabel,
  disableLabel,
  actionFailed,
}: {
  id: string
  status: string
  runLabel: string
  enableLabel: string
  disableLabel: string
  actionFailed: string
}) {
  return (
    <AutomationRowActions
      id={id}
      status={status}
      runLabel={runLabel}
      enableLabel={enableLabel}
      disableLabel={disableLabel}
      actionFailed={actionFailed}
    />
  )
}

export function NewAutomationListButton({ label }: { label: string }) {
  return <NewAutomationButton label={label} />
}

export function AutomationApprovalSettingsSection(props: ComponentProps<typeof AutomationApprovalSettings>) {
  return <AutomationApprovalSettings {...props} />
}
