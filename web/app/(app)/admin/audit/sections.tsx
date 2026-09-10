import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { BookOpen } from 'lucide-react'
import type { ComponentProps } from 'react'
import { AuditRows, type AuditListRow } from './AuditRows'
import { AuditEventDrawer, type AuditEvent } from './AuditEventDrawer'

/**
 * The audit log's bespoke interactive surfaces, re-exported for the spec.
 *
 * Both stay whole components rather than becoming spec vocabulary, for the
 * same reason the org-users table does: the rows table is a hand-rolled
 * client `<table>` whose rows navigate via the router on click/keydown, and
 * the event drawer is client chrome with tab state, JSON expansion and diff
 * computation. The spec places them; it never re-expresses them.
 *
 * No markup is moved or duplicated here: page.tsx renders these same two
 * components on the native path, so both renders share one implementation.
 */

export type { AuditListRow, AuditEvent }

export function AuditRowsTable({ rows, selectedId }: ComponentProps<typeof AuditRows>) {
  return <AuditRows rows={rows} selectedId={selectedId} />
}

// The drawer takes a discriminated union (closeHref XOR onClose); the URL
// variant is the one both render paths use here.
export function AuditEventFlyout({ event, closeHref }: { event: AuditEvent; closeHref: string }) {
  return <AuditEventDrawer event={event} closeHref={closeHref} />
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
