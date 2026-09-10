import { Library } from 'lucide-react'
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@openbooks/ui'
import { InstallListingButton } from './InstallListingButton'

/**
 * Shared presentational cells for /apps/library, used by the native page and
 * the ViewSpec path alike so the two renders stay byte-identical.
 */

/**
 * One marketplace-listing card: icon medallion + version badge + title over
 * a three-line description plus the key and the install/update button. The
 * footer row couples a plain `<code>` with a client button, so the whole
 * card is one component placed per item by the spec's `repeat` — the same
 * call the /apps launcher made for its cards.
 */
export function ListingCard({
  listingId,
  listingKey,
  name,
  versionLine,
  description,
  installed,
  current,
}: {
  listingId: string
  listingKey: string
  name: string
  versionLine: string
  description: string
  installed: boolean
  current: boolean
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="p-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
            <Library size={20} aria-hidden />
          </span>
          <Badge variant="secondary">{versionLine}</Badge>
        </div>
        <CardTitle className="mt-2 text-base">{name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-4 pb-4">
        <CardDescription className="line-clamp-3 min-h-[3.75rem]">{description}</CardDescription>
        <div className="mt-4 flex items-center justify-between gap-3">
          <code className="truncate text-xs text-slate-400 dark:text-slate-500">{listingKey}</code>
          <InstallListingButton
            listingId={listingId}
            name={name}
            installed={installed}
            current={current}
          />
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The empty/no-results medallion. The native page renders it inline in a
 * plain span, but the badge span is its own named component so the registry
 * entry stays a one-liner — the same split the /apps launcher uses. NOT
 * `apps-empty-icon`: that one renders Boxes; this page renders Library.
 */
export function LibraryEmptyIcon() {
  return (
    <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <Library size={21} aria-hidden />
    </span>
  )
}
