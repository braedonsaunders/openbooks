import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { buildListDrawerHref, pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { createDraftJournal, loadJournalDoc } from '../../../lib/journals'
import { JOURNAL_ENTRY_TABLE, journalScopeWhere } from '../../../lib/customization/entity-list-query/journal-entries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'
import type { JournalDrawer } from './JournalDrawer'
import type { JournalDraftRow } from './sections'

/**
 * The journal list, split into a loader and a spec.
 *
 * The body is two blocks: an optional draft-manual-journals panel (a
 * conditional composite, so a shared component both paths render) and the
 * universal entity list, which arrives through the `entity-list-view` widget
 * and its slot — the slot re-derives org id, user id and permissions from
 * the session because a spec must never carry a capability or an org id.
 *
 * The drawer is the manual-journal flyout over DOCUMENT ids (?entry=); the
 * entity list's own row links (?txn=) are a separate surface the list owns,
 * via the shared `related-txn-drawer` widget. Posted-entry links to
 * /journal/[id] are a third, untouched surface.
 */

interface DraftJournalRow {
  id: string
  document_number: string
  document_date: string
  memo: string | null
  total: string | number
}

interface PickerResult<T> { rows: T[] }
interface PartyPickerRow { id: string; display_name: string }
interface AccountPickerRow { id: string; number: string | null; name: string }
interface NamePickerRow { id: string; name: string }

type JournalDrawerProps = Parameters<typeof JournalDrawer>[0]

export interface JournalData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  hasDrafts: boolean
  draftsHeading: string
  drafts: JournalDraftRow[]
  drawerOpen: boolean
  drawer: JournalDrawerProps | null
}

export async function loadJournal(
  sp: Record<string, string | string[] | undefined>,
): Promise<JournalData> {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('journal')
  const authz = await requirePermission('gl.read')
  const allowedSubsidiaries = authz.allowedSubsidiaryIds
  const allowedIds = allowedSubsidiaries ? [...allowedSubsidiaries] : []

  // ?entry= drives the manual-journal drawer over DOCUMENT ids;
  // posted-entry links to /journal/[id] are a separate, untouched surface.
  const entryParam = pickString(sp.entry)
  if (entryParam === 'new') {
    // deep-linkable instant draft: create it server-side, land on its drawer
    if (!can(authz, 'gl.post')) redirect('/journal')
    const draft = await createDraftJournal(authz.user.orgId, authz.user.id)
    redirect(`/journal?entry=${draft.id}&mode=edit`)
  }

  // The header counts the list's own backing relation (JOURNAL_ENTRY_TABLE)
  // through the shared journalScopeWhere — same scope, same subsidiary
  // fence, no status filter — so the header total and the list total agree
  // by construction (F-t11-010). The old journalsOnly predicate counted a
  // narrower scope (it dropped native entries carrying a subledger document,
  // e.g. migrated bills) with no status filter, which is why the header
  // read 25,943 against the list's 47,625.
  // draft manual journals are documents (not entries yet) — surfaced separately
  const [draftDocs, openJournal, pickers, postedCount] = await Promise.all([
    (db.execute(sql`
      select id, document_number, document_date, memo, total
        from documents
       where org_id = ${authz.user.orgId} and kind = 'journal' and status = 'draft'
         ${allowedSubsidiaries
           ? allowedIds.length
             ? sql`and subsidiary_id = any(${`{${allowedIds.join(',')}}`}::uuid[])`
             : sql`and false`
           : sql``}
       order by created_at desc
       limit 20
    `)),
    entryParam ? loadJournalDoc(entryParam, authz.user.orgId).then((journal) => {
      if (!journal || !allowedSubsidiaries) return journal
      return allowedSubsidiaries.has(String(journal.doc.subsidiary_id)) ? journal : null
    }) : null,
    entryParam
      ? Promise.all([
          db.execute(sql`select id, display_name from parties where org_id = ${authz.user.orgId} and is_active order by display_name limit 2000`) as unknown as PickerResult<PartyPickerRow>,
          db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last`) as unknown as PickerResult<AccountPickerRow>,
          db.execute(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`) as unknown as PickerResult<NamePickerRow>,
          db.execute(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`) as unknown as PickerResult<NamePickerRow>,
          loadFieldDefs('documents', 'journal'),
          loadFieldDefs('document_lines', 'journal'),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
            if (!multi) return null
            const options = await subsidiaryOptions()
            return allowedSubsidiaries ? options.filter((option) => allowedSubsidiaries.has(option.id)) : options
          }),
          customSegmentOptions(authz.user.orgId),
        ])
      : null,
    (db.execute(sql`select count(*) as n from ${sql.raw(`${JOURNAL_ENTRY_TABLE} e`)} where ${journalScopeWhere(authz.user.orgId, allowedSubsidiaries)}`)),
  ])
  const total = Number(postedCount.rows[0]?.n ?? 0)
  const resolvedForm = openJournal && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: 'journal',
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: (pickers[4]),
        lineDefs: (pickers[5]),
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const drafts = (draftDocs.rows as unknown as DraftJournalRow[]).map((d) => ({
    id: String(d.id),
    href: buildListDrawerHref('/journal', sp, 'entry', String(d.id)),
    documentNumber: d.document_number,
    documentDate: d.document_date,
    memo: d.memo,
    total: money(d.total),
  }))

  const drawer: JournalDrawerProps | null =
    openJournal && pickers
      ? {
          journal: openJournal,
          initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view',
          parties: pickers[0].rows,
          accounts: pickers[1].rows.map((account) => ({ ...account, number: account.number ?? undefined })),
          departments: pickers[2].rows,
          projects: pickers[3].rows,
          subsidiaries: pickers[6] ?? undefined,
          headerDefs: pickers[4] as unknown as import('../../../components/custom-field-inputs').CustomFieldDefClient[],
          lineDefs: pickers[5] as unknown as import('../../../components/custom-field-inputs').CustomFieldDefClient[],
          layout: resolvedForm?.layout,
          segments: pickers[7],
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description', { count: total }),
    currentParams: sp,
    hasDrafts: drafts.length > 0,
    draftsHeading: t('list.draftsHeading'),
    drafts,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<JournalData>()

export function journalSpec(data: JournalData): PageSpec {
  return page({
    route: '/journal',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        // The create button checks nothing client-side; the draft endpoint
        // enforces gl.post, exactly as on the native path.
        actions: [widget('new-journal', {})],
      }),
    ],
    body: [
      {
        ...widgetBlock('journal-drafts', {
          heading: data.draftsHeading,
          drafts: data.drafts,
        }),
        when: f('hasDrafts'),
      },
      widgetBlock('entity-list-view', {
        recordType: 'journal',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'journal-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: { widget: 'new-journal', props: {} },
      }),
    ],
  })
}
