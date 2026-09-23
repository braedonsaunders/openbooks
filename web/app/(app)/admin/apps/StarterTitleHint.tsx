'use client'

import { useTranslations } from 'next-intl'
import { starterTitleState } from '@/lib/apps/starter'
import type { AppManifest } from '@/lib/apps/manifest'
import type { AppPackageFile } from '@/lib/apps/package-files'

/**
 * General-tab guidance answering "will renaming this app move its screen
 * heading?" A starter heading follows the app name until the author
 * customizes it; a custom heading is left alone by a rename. Renders nothing
 * when the entry cannot be recognized, rather than guessing.
 */
export function StarterTitleHint({
  files,
  manifest,
}: {
  files: Pick<AppPackageFile, 'path' | 'content' | 'isBinary'>[]
  manifest: AppManifest
}) {
  const t = useTranslations('apps.editor')
  const state = starterTitleState(files, manifest.frontend)
  if (state === 'unknown') return null
  if (state === 'custom')
    return <p className="text-xs text-slate-500">{t('titleCustom')}</p>
  return (
    <p className="text-xs text-slate-500">
      {t(
        manifest.frontend.renderer === 'sandbox'
          ? 'titleFollowsNameSandbox'
          : 'titleFollowsNameNative',
      )}
    </p>
  )
}
