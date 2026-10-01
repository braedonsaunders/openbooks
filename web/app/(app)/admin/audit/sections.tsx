import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { BookOpen } from 'lucide-react'
import type { ComponentProps } from 'react'
import { AuditRows, type AuditListRow } from './AuditRows'
import type { AuditEvent } from './AuditEventDrawer'
import { AuditEventHost } from './AuditEventHost'

/** Shared paged rows and the URL-driven event drawer, placed by the page spec. */

export type { AuditListRow, AuditEvent }

export function AuditRowsTable({ rows, selectedId }: ComponentProps<typeof AuditRows>) {
  return <AuditRows rows={rows} selectedId={selectedId} />
}

export function AuditEventFlyout({ event }: { event: AuditEvent | null; closeHref: string }) {
  return <AuditEventHost event={event} />
}

/**
 * The audit log's documentation button.
 *
 * Deliberately NOT the `docs-link-button` the customization designer uses:
 * that one renders a 14px icon with no space before the label, this one a
 * 15px icon with one. They look like the same button and are not, and the
 * harness reads the difference — so each page keeps the markup it actually
 * has rather than a shared component growing a size prop and a spacing flag.
 */
export function AuditDocsLink({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href as never}>
        <BookOpen size={15} aria-hidden /> {label}
      </Link>
    </Button>
  )
}
