'use client'

// Operator console for the in-app issue reporter. The form itself belongs to
// @braedonsaunders/appkit-feedback (the same package the header control comes
// from, so the two can never disagree about what a destination is); this
// wrapper owns the host's half: the server actions, the saved/failed status,
// and the token-removal control the package deliberately leaves to the host.

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  FeedbackSettingsForm,
  type FeedbackSettingsValue,
} from '@braedonsaunders/appkit-feedback/react'
import { Button } from '@openbooks/ui'
import { PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { clearFeedbackTokenAction, saveFeedbackSettingsAction } from './actions'
import type { FeedbackSettingsView } from '../../../../lib/feedback/config'

function toFormValue(settings: FeedbackSettingsView): FeedbackSettingsValue {
  return {
    enabled: settings.enabled,
    owner: settings.owner,
    repo: settings.repo,
    // Never round-trips: the stored token is sealed, and an empty field means
    // "keep what is stored".
    token: '',
    hasToken: settings.hasToken,
    labels: settings.labels,
    searchDuplicates: settings.searchDuplicates,
  }
}

export function PlatformFeedbackClient({ settings }: { settings: FeedbackSettingsView }) {
  const [value, setValue] = useState<FeedbackSettingsValue>(() => toFormValue(settings))
  const [hasToken, setHasToken] = useState(settings.hasToken)
  const [pending, startTransition] = useTransition()

  function apply(result: Awaited<ReturnType<typeof saveFeedbackSettingsAction>>, success: string) {
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    setValue(toFormValue(result.settings))
    setHasToken(result.settings.hasToken)
    toast.success(success)
  }

  // The same operator shell the sibling platform pages render through
  // (ListPageLayout/PageContainer): the shell owns the scroll container,
  // page padding and max-width; PageHeader owns the title and the way back.
  // The AppShell main is overflow-hidden, so a bare div here can never
  // scroll — which is exactly the defect. Title and description repeat the
  // console nav entry for this module, the way the access page repeats its
  // own.
  return (
    <PageContainer>
      <div className="space-y-5">
        <PageHeader
          title="Issue reporting"
          description="Where in-app product reports are filed, for the whole deployment."
          back={{ href: '/platform', label: 'Back to platform' }}
        />
        <div className="flex flex-col gap-4">
          <FeedbackSettingsForm
            value={value}
            onChange={setValue}
            saving={pending}
            onSave={(next) =>
              startTransition(async () => {
                apply(
                  await saveFeedbackSettingsAction({
                    enabled: next.enabled,
                    owner: next.owner,
                    repo: next.repo,
                    labels: next.labels,
                    searchDuplicates: next.searchDuplicates,
                    token: next.token.trim() || undefined,
                  }),
                  'Issue reporting settings saved',
                )
              })
            }
            labels={{
              settingsDescription:
                'One destination for the whole deployment. People report from any page; reports are generalized — personal and company details removed — before an issue is filed.',
              tokenHelp:
                'Needs Issues: Read and write (fine-grained) or repo (classic). Leave blank to keep the stored token. Saving with reporting enabled verifies the token against the repository first.',
            }}
          />
          {hasToken ? (
            <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              <div>
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Stored access token
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  Removing it also turns reporting off — a destination with no credential can only
                  fail. Existing filed issues are unaffected.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    apply(await clearFeedbackTokenAction(), 'Access token removed')
                  })
                }
              >
                Remove token
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </PageContainer>
  )
}
