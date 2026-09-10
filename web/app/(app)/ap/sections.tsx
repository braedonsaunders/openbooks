import Link from 'next/link'
import { ScanLine } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { NewDocumentButton } from '../../../components/new-document-button'

/**
 * The AP header's action pair.
 *
 * This is a component rather than two widgets side by side because the native
 * header NESTS them: a `gap-2` row holding the capture link and the create
 * menu, sitting inside the `gap-3` actions wrapper alongside the module tabs.
 * Placing all three flat in the spec renders one wrapper instead of two and
 * spaces the pair differently — the harness caught exactly that. Moved out of
 * `page.tsx` and imported back, so both render paths share one implementation.
 *
 * `canCreate` omits the create menu, matching the native `undefined`.
 */
export function ApHeaderActions({
  captureHref,
  captureLabel,
  canCreate,
  newItems,
  newBasePath,
  newTriggerLabel,
  newCreatingLabel,
  newFailedLabel,
}: {
  captureHref: string
  captureLabel: string
  canCreate: boolean
  newItems: { kind: string; label: string }[]
  newBasePath: string
  newTriggerLabel: string
  newCreatingLabel: string
  newFailedLabel: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" asChild>
        <Link href={captureHref}>
          <ScanLine size={14} />
          {captureLabel}
        </Link>
      </Button>
      {canCreate ? (
        <NewDocumentButton
          items={newItems}
          basePath={newBasePath}
          triggerLabel={newTriggerLabel}
          creatingLabel={newCreatingLabel}
          failedLabel={newFailedLabel}
        />
      ) : undefined}
    </div>
  )
}
