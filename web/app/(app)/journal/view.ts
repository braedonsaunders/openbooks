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
import { buildListDrawerHref, mergeHref, pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { loadJournalDoc } from '../../../lib/journals'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
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
  /** The New button posts through gl.post — without it the button hides
   * rather than opening a drawer the loader refuses to fill. */
  canPost: boolean
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
  // Unsaved-create: ?entryNew=1 opens an editable drawer on no persisted
  // row. The loader ships pickers plus an empty payload; opening writes
  // nothing, Cancel writes nothing, and the drawer's explicit Save is the
  // single idempotent POST. Gated on gl.post like the draft flow was.
  const creating = pickString(sp.entryNew) === '1' && can(authz, 'gl.post')
  if (entryParam === 'new') {
    // The legacy deep link minted a server-side draft on GET. It now lands
    // on the same unsaved drawer the New button opens — still zero writes.
    redirect(can(authz, 'gl.post') ? '/journal?entryNew=1&mode=edit' : '/journal')
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
    entryParam || creating
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
          // Unsaved-create defaults: today's date plus the home subsidiary
          // (root for unrestricted callers, first allowed entity otherwise).
          // Read-only lookups — opening the drawer still writes nothing.
          creating
            ? Promise.all([
                businessToday(authz.user.orgId),
                db.execute<{ id: string; base_currency: string }>(sql`
                  select id, base_currency from subsidiaries
                   where org_id = ${authz.user.orgId} and parent_id is null`),
              ])
            : null,
        ])
      : null,
    (db.execute(sql`select count(*) as n from ${sql.raw(`${JOURNAL_ENTRY_TABLE} e`)} where ${journalScopeWhere(authz.user.orgId, allowedSubsidiaries)}`)),
  ])
  const total = Number(postedCount.rows[0]?.n ?? 0)
  const resolvedForm = (openJournal || creating) && pickers
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

  // The unsaved-create payload: no row exists, so the drawer edits blanks
  // and posts them once. Draft by default, dated today, homed to the first
  // allowed subsidiary — and with NO document number: opening the drawer
  // allocates nothing, the number arrives with the Save response.
  const closeHref = mergeHref('/journal', sp, {
    entry: undefined,
    entryNew: undefined,
    mode: undefined,
    form: undefined,
  })
  const newJournalPayload = creating && pickers
    ? (() => {
        const defaults = pickers[8]
        const today = defaults?.[0] ?? ''
        const root = defaults?.[1].rows[0]
        const homeSub = (pickers[6] ?? [])[0] as { id: string; baseCurrency?: string } | undefined
        return {
          doc: {
            id: '',
            status: 'draft',
            currency: homeSub?.baseCurrency ?? root?.base_currency ?? '',
            subsidiary_id: homeSub?.id ?? null,
            reference_number: null,
            party_id: null,
            party_name: null,
            memo: null,
            document_date: today,
            updated_at: '',
            entry_id: null,
            document_number: null,
            custom: {},
            extra_dims: {},
          },
          lines: [],
        }
      })()
    : null

  const drawer: JournalDrawerProps | null =
    (openJournal || newJournalPayload) && pickers
      ? {
          journal: (newJournalPayload ?? openJournal)!,
          initialMode: creating || pickString(sp.mode) === 'edit' ? 'edit' : 'view',
          parties: pickers[0].rows,
          accounts: pickers[1].rows.map((account) => ({ ...account, number: account.number ?? undefined })),
          departments: pickers[2].rows,
          projects: pickers[3].rows,
          subsidiaries: pickers[6] ?? undefined,
          headerDefs: pickers[4] as unknown as import('../../../components/custom-field-inputs').CustomFieldDefClient[],
          lineDefs: pickers[5] as unknown as import('../../../components/custom-field-inputs').CustomFieldDefClient[],
          layout: resolvedForm?.layout,
          segments: pickers[7],
          createMode: creating,
          // Every drawer mutation (save, post, delete, void) requires
          // gl.post server-side — the drawer hides them all without it.
          canPost: can(authz, 'gl.post'),
          closeHref,
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description', { count: total }),
    canPost: can(authz, 'gl.post'),
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
        // The create button shows iff the server would allow the save:
        // ?entryNew=1 opens nothing without gl.post, so offering it would
        // be a dead click. The drawer's explicit Save enforces gl.post too.
        actions: [widget('new-journal', {}, f('canPost'))],
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
        // The empty-state New is the same dead click without gl.post, and
        // the slot carries no `when` — the loader flag decides at build.
        emptyAction: data.canPost ? { widget: 'new-journal', props: {} } : null,
      }),
    ],
  })
}
