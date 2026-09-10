import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  page,
  pageHeader,
  ref,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'

/**
 * The reconciliations list, split into a loader and a spec.
 *
 * The whole page is the universal entity list (`bank_reconciliation` record
 * type); the native page passes no drawer and no formatValue, so the spec
 * passes neither — rows link out to the per-account reconcile workspace via
 * the source's own rowHref, and every cell is registry-typed (reference /
 * amount / status / date). The list arrives through the shared
 * `entity-list-view` widget and its slot: the slot re-derives org id, user
 * id and permissions from the session, so the spec carries only the record
 * type and the current params, never a capability or an org id.
 *
 * The empty action (a Button-as-child Link back to /banking) is a widget
 * ref (`choose-recon-account`, INTEGRATION.md): a spec cannot express JSX.
 * The native page passes it unconditionally, so the spec does too — there
 * is no permission gate on it to reproduce.
 */

export interface BankingReconciliationsData {
  title: string
  description: string
  homeTitle: string
  currentParams: Record<string, string | string[] | undefined>
  chooseAccountHref: string
  chooseAccountLabel: string
}

export async function loadBankingReconciliations(
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingReconciliationsData> {
  // Permission gate copied verbatim from page.tsx. The org/user ids the
  // list needs stay server-side: the entity-list slot re-derives them from
  // the session rather than receiving them through the spec.
  await requirePermission('banking.reconcile')
  const t = await getTranslations('banking')

  return {
    title: t('reconsPage.title'),
    description: t('reconsPage.description'),
    homeTitle: t('home.title'),
    currentParams: sp,
    chooseAccountHref: '/banking',
    chooseAccountLabel: t('reconsPage.chooseAccount'),
  }
}

const f = ref<BankingReconciliationsData>()

export function bankingReconciliationsSpec(data: BankingReconciliationsData): PageSpec {
  const chooseAccount = {
    widget: 'choose-recon-account',
    props: { href: data.chooseAccountHref, label: data.chooseAccountLabel },
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        back: { href: '/banking', label: f('homeTitle') },
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'bank_reconciliation',
        sp: data.currentParams,
        emptyAction: chooseAccount,
      }),
    ],
  })
}
