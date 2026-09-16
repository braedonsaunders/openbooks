import Link from 'next/link'
import { Bot } from 'lucide-react'
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@openbooks/ui'
import { AgentsPackInstallButton } from './AgentsPackInstallButton'

export interface AgentsPackCardDetector {
  detectorKey: string
  title: string
  description: string
}

/**
 * One agent-pack marketplace card (the /apps/library ListingCard precedent):
 * a single neutral medallion for every pack (no per-pack branches — packs the
 * engine registers later appear with zero card changes), an installed badge,
 * reads/proposes, the module + permission requirements, the check list, and
 * the install/configure action in the footer. The install button is the small
 * client island; everything else is loader-resolved data.
 */
export function AgentsPackCard({
  agentKey,
  name,
  description,
  reads,
  proposes,
  installed,
  installedLabel,
  installLabel,
  installPolicy,
  featureEnabled,
  permissions,
  needsLabel,
  moduleLine,
  readsLabel,
  proposesLabel,
  checksTitle,
  checksNote,
  detectors,
  configureHref,
  configureLabel,
}: {
  agentKey: string
  name: string
  description: string
  reads: string
  proposes: string
  installed: boolean
  installedLabel: string
  installLabel: string
  installPolicy: Record<string, unknown>
  featureEnabled: boolean
  permissions: string[]
  needsLabel: string
  moduleLine: string
  readsLabel: string
  proposesLabel: string
  checksTitle: string
  checksNote: string
  detectors: AgentsPackCardDetector[]
  configureHref: string
  configureLabel: string
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="p-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300">
            <Bot size={20} aria-hidden />
          </span>
          <Badge variant={installed ? 'success' : 'secondary'}>
            {installed ? installedLabel : installLabel}
          </Badge>
        </div>
        <CardTitle className="mt-2 text-base">{name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-4 pb-4">
        <CardDescription className="line-clamp-3 min-h-[3.75rem]">{description}</CardDescription>
        <dl className="mt-3 grid gap-2 text-xs">
          <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/50">
            <dt className="font-semibold text-slate-700 dark:text-slate-200">{readsLabel}</dt>
            <dd className="mt-0.5 leading-5 text-slate-500 dark:text-slate-400">{reads}</dd>
          </div>
          <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/50">
            <dt className="font-semibold text-slate-700 dark:text-slate-200">{proposesLabel}</dt>
            <dd className="mt-0.5 leading-5 text-slate-500 dark:text-slate-400">{proposes}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">{moduleLine}</p>
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          {needsLabel}{' '}
          {permissions.map((permission) => (
            <code
              key={permission}
              className="mr-1 rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              {permission}
            </code>
          ))}
        </p>
        <div className="mt-3">
          <h3 className="px-1 text-xs font-semibold text-slate-700 dark:text-slate-200">{checksTitle}</h3>
          <ul className="mt-1.5 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            {detectors.map((detector) => (
              <li key={detector.detectorKey} className="px-3 py-2">
                <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{detector.title}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{detector.description}</p>
              </li>
            ))}
          </ul>
          <p className="mt-1 px-1 text-[11px] text-slate-400 dark:text-slate-500">{checksNote}</p>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <code className="truncate text-xs text-slate-400 dark:text-slate-500">{agentKey}</code>
          {installed ? (
            <Link href={configureHref} className="shrink-0 text-xs font-medium text-teal-700 underline dark:text-teal-300">
              {configureLabel}
            </Link>
          ) : (
            <AgentsPackInstallButton
              agentKey={agentKey}
              policy={installPolicy}
              packTitle={name}
              installed={installed}
              featureEnabled={featureEnabled}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}
