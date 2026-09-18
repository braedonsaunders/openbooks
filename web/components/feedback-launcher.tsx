'use client'

// Header chrome for the in-app issue reporter. The control, the dialog, the
// triage conversation and the redaction all belong to
// @braedonsaunders/appkit-feedback; this file supplies the three things the
// package deliberately does not own — where to POST, what page the person is
// on, and the translated labels.
//
// It renders only when an operator has finished configuring a destination
// (see web/lib/feedback/config.ts), so nobody is offered a report button that
// can only fail.

import { useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createHttpFeedbackClient } from '@braedonsaunders/appkit-feedback'
import { FeedbackLauncher as AppKitFeedbackLauncher } from '@braedonsaunders/appkit-feedback/react'

export function FeedbackLauncher({ appVersion }: { appVersion: string }) {
  const t = useTranslations('shell.feedback')
  const pathname = usePathname() ?? '/'
  const client = useMemo(() => createHttpFeedbackClient({ url: '/api/feedback/turn' }), [])

  return (
    <AppKitFeedbackLauncher
      client={client}
      context={{ pathname, appVersion }}
      unavailableMessage={t('unavailableBody')}
      labels={{
        launcherAria: t('launcherAria'),
        title: t('title'),
        description: t('description'),
        close: t('close'),
        placeholder: t('placeholder'),
        send: t('send'),
        sending: t('sending'),
        pageChip: t('pageChip'),
        removePage: t('removePage'),
        thatHelped: t('thatHelped'),
        stillABug: t('stillABug'),
        continue: t('continue'),
        filedTitle: t('filedTitle'),
        filedBody: t('filedBody'),
        openIssue: t('openIssue'),
        strippedHeading: t('strippedHeading'),
        unavailableTitle: t('unavailableTitle'),
        workingHelp: t('workingHelp'),
        workingIssues: t('workingIssues'),
        workingFile: t('workingFile'),
        workingDefault: t('workingDefault'),
      }}
    />
  )
}
