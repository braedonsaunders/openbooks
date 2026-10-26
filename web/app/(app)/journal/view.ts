import { accountingPreferences } from "@openbooks/engine/organization/accounting-preferences";
import { sourceAmortizationOptions } from "@/lib/amortization-options";
import "server-only";

import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  page,
  pageHeader,
  panel,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { mergeHref, pickString } from "../../../lib/list-params";
import { can, requirePermission } from "../../../lib/authz";
import {
  customFieldViewerFor,
  loadFieldDefs,
  visibleCustomFieldDefs,
} from "../../../lib/custom-fields";
import { isMultiSubsidiary, subsidiaryOptions } from "../../../lib/subsidiaries";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";
import { loadJournalDoc, redactJournalHeaderCustom } from "../../../lib/journals";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { isIsoCalendarDate } from "@openbooks/engine/platform/civil-date";
import {
  JOURNAL_ENTRY_TABLE,
  journalScopeWhere,
  journalDraftScopeWhere,
} from "../../../lib/customization/entity-list-query/journal-entries";
import { resolveFormLayout } from "../../../lib/customization/resolve";
import { customSegmentOptions } from "../../../lib/segments";
import type { JournalDrawer } from "./JournalDrawer";
import type { ModuleHomeTab } from "../../../components/module-home/tab-types";
import { journalBookOptions } from "../../../lib/journal-book";
import { isFeatureEnabled } from "../../../lib/features";

interface PickerResult<T> {
  rows: T[];
}
interface PartyPickerRow {
  id: string;
  display_name: string;
}
interface AccountPickerRow {
  id: string;
  number: string | null;
  name: string;
}
interface NamePickerRow {
  id: string;
  name: string;
}

type JournalDrawerProps = Parameters<typeof JournalDrawer>[0];

export interface JournalData {
  title: string;
  description: string;
  /** The New button posts through gl.post — without it the button hides
   * rather than opening a drawer the loader refuses to fill. */
  canPost: boolean;
  scopeUnavailable: boolean;
  scopeUnavailableMessage: string;
  currentParams: Record<string, string | string[] | undefined>;
  draftsView: boolean;
  tabs: ModuleHomeTab[];
  drawerOpen: boolean;
  drawer: JournalDrawerProps | null;
}

export async function loadJournal(
  sp: Record<string, string | string[] | undefined>,
): Promise<JournalData> {
  const t = await getTranslations("journal");
  const authz = await requirePermission("gl.read");
  const allowedSubsidiaries = authz.allowedSubsidiaryIds;
  const canCreate =
    can(authz, "gl.post") && (allowedSubsidiaries === null || allowedSubsidiaries.size > 0);
  const scopeUnavailable =
    can(authz, "gl.post") && allowedSubsidiaries !== null && allowedSubsidiaries.size === 0;

  // ?entry= selects a manual-journal document; posted entries open through
  // the shared journal-entry drawer.
  const entryParam = pickString(sp.entry);
  // Unsaved-create: ?entryNew=1 opens an editable drawer on no persisted
  // row. The loader ships pickers plus an empty payload; opening writes
  // nothing, Cancel writes nothing, and the drawer's explicit Save is the
  // single idempotent POST. Gated on gl.post like the draft flow was.
  const creating = pickString(sp.entryNew) === "1" && canCreate;
  // Save & new and Post & new carry the previous journal's date forward
  // (?entryDate=YYYY-MM-DD) so a batch for one date needs no retyping. Any
  // other value is ignored and the create opens on the business date.
  const requestedEntryDate = pickString(sp.entryDate);
  const carriedEntryDate =
    requestedEntryDate && isIsoCalendarDate(requestedEntryDate) ? requestedEntryDate : null;
  const draftsView = pickString(sp.journalTab) === "drafts";
  const [draftCount, openJournal, pickers, postedCount] = await Promise.all([
    db.execute<{ n: string }>(
      sql`
      select count(*) as n from documents e
       where ${journalDraftScopeWhere(authz.user.orgId, allowedSubsidiaries)}`,
      "objects",
    ),
    entryParam
      ? loadJournalDoc(entryParam, authz.user.orgId, allowedSubsidiaries).then(async (journal) => {
          if (
            !journal ||
            (allowedSubsidiaries && !allowedSubsidiaries.has(String(journal.doc.subsidiary_id)))
          )
            return null;
          return redactJournalHeaderCustom(journal, customFieldViewerFor(authz));
        })
      : null,
    entryParam || creating
      ? Promise.all([
          db.execute(
            sql`select id, display_name from parties where org_id = ${authz.user.orgId} and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaries, { orgWideNull: true })} order by display_name`,
          ) as unknown as PickerResult<PartyPickerRow>,
          db.execute(
            sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active and not is_summary ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaries, { orgWideNull: true })} order by number nulls last`,
          ) as unknown as PickerResult<AccountPickerRow>,
          db.execute(
            sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaries, { orgWideNull: true })} order by name`,
          ) as unknown as PickerResult<NamePickerRow>,
          db.execute(
            sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaries, { orgWideNull: true })} order by name`,
          ) as unknown as PickerResult<NamePickerRow>,
          loadFieldDefs("documents", "journal"),
          loadFieldDefs("document_lines", "journal"),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
            if (!multi) return null;
            const options = await subsidiaryOptions();
            return allowedSubsidiaries
              ? options.filter((option) => allowedSubsidiaries.has(option.id))
              : options;
          }),
          customSegmentOptions(authz.user.orgId, authz.allowedSubsidiaryIds),
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
    db.execute(
      sql`select count(*) as n from ${sql.raw(`${JOURNAL_ENTRY_TABLE} e`)} where ${journalScopeWhere(authz.user.orgId, allowedSubsidiaries)}`,
      "objects",
    ),
  ]);
  const total = Number(postedCount[0]?.n ?? 0);
  const resolvedForm =
    (openJournal || creating) && pickers
      ? await resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: "journal",
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs: pickers[4],
          lineDefs: pickers[5],
          explicitLayoutId: pickString(sp.form),
          subsidiaryDefaultLayoutId:
            openJournal?.doc.subsidiary_id && typeof openJournal.doc.subsidiary_id === "string"
              ? (
                  await accountingPreferences(
                    db,
                    authz.user.orgId,
                    openJournal.doc.subsidiary_id,
                    String(openJournal.doc.document_date),
                  )
                ).defaultJournalFormId
              : pickers[6]?.[0]?.id
                ? (
                    await accountingPreferences(
                      db,
                      authz.user.orgId,
                      pickers[6][0].id,
                      await businessToday(authz.user.orgId),
                    )
                  ).defaultJournalFormId
                : null,
        })
      : null;

  // Tab changes reset view-specific filters and close competing drawers.
  const tabParams = {
    ...sp,
    page: undefined,
    sort: undefined,
    dir: undefined,
    status: undefined,
    origin: undefined,
    view: undefined,
    q: undefined,
    entry: undefined,
    entryNew: undefined,
    entryDate: undefined,
    journalEntry: undefined,
    txn: undefined,
    reportRecord: undefined,
    reportRecordKind: undefined,
    accountRegister: undefined,
    reportDrill: undefined,
    drawerReturn: undefined,
    mode: undefined,
    form: undefined,
  };
  const tabs: ModuleHomeTab[] = [
    {
      label: t("list.entriesTab"),
      href: mergeHref("/journal", tabParams, { journalTab: undefined }),
      active: !draftsView,
      count: total,
    },
    {
      label: t("list.draftsTab"),
      href: mergeHref("/journal", tabParams, { journalTab: "drafts" }),
      active: draftsView,
      count: Number(draftCount[0]?.n ?? 0),
    },
  ];

  // The unsaved-create payload: no row exists, so the drawer edits blanks
  // and posts them once. Draft by default, dated today, homed to the first
  // allowed subsidiary — and with NO document number: opening the drawer
  // allocates nothing, the number arrives with the Save response.
  const closeHref = mergeHref("/journal", sp, {
    entry: undefined,
    entryNew: undefined,
    entryDate: undefined,
    mode: undefined,
    form: undefined,
    journalEntry: undefined,
    txn: undefined,
    reportRecord: undefined,
    reportRecordKind: undefined,
    drawerReturn: undefined,
  });
  const newJournalPayload =
    creating && pickers
      ? (() => {
          const defaults = pickers[8];
          const today = carriedEntryDate ?? defaults?.[0] ?? "";
          const root = defaults?.[1].rows[0];
          const homeSub = (pickers[6] ?? [])[0] as
            { id: string; baseCurrency?: string } | undefined;
          return {
            doc: {
              id: "",
              status: "draft",
              currency: homeSub?.baseCurrency ?? root?.base_currency ?? "",
              subsidiary_id: homeSub?.id ?? null,
              reference_number: null,
              party_id: null,
              party_name: null,
              memo: null,
              document_date: today,
              updated_at: "",
              entry_id: null,
              document_number: null,
              custom: {},
              extra_dims: {},
            },
            lines: [],
          };
        })()
      : null;

  // The book selector appears only when Multi-book accounting offers a choice.
  const books =
    (openJournal || newJournalPayload) &&
    pickers &&
    (await isFeatureEnabled(authz.user.orgId, "multiBookAccounting"))
      ? await journalBookOptions(authz.user.orgId)
      : [];
  const selectedJournal = newJournalPayload ?? openJournal;
  const amortizationTemplates = selectedJournal
    ? await sourceAmortizationOptions(authz.user.orgId, selectedJournal)
    : undefined;
  const drawer: JournalDrawerProps | null =
    (openJournal || newJournalPayload) && pickers
      ? {
          journal: (newJournalPayload ?? openJournal)!,
          initialMode: creating || pickString(sp.mode) === "edit" ? "edit" : "view",
          parties: pickers[0].rows,
          accounts: pickers[1].rows.map((account) => ({
            ...account,
            number: account.number ?? undefined,
          })),
          departments: pickers[2].rows,
          projects: pickers[3].rows,
          subsidiaries: pickers[6] ?? undefined,
          books: books.length > 1 ? books : undefined,
          canPostBookSpecific: can(authz, "gl.post_book_specific"),
          amortizationTemplates,
          headerDefs: visibleCustomFieldDefs(
            pickers[4],
            customFieldViewerFor(authz),
          ) as unknown as import("../../../components/custom-field-inputs").CustomFieldDefClient[],
          customFieldViewer: customFieldViewerFor(authz),
          lineDefs:
            pickers[5] as unknown as import("../../../components/custom-field-inputs").CustomFieldDefClient[],
          layout: resolvedForm?.layout,
          segments: pickers[7],
          createMode: creating,
          // Every drawer mutation (save, post, delete, void) requires
          // gl.post server-side — the drawer hides them all without it.
          canPost: can(authz, "gl.post"),
          // Save & new / Post & new open the next unsaved journal, which
          // this loader fills only for viewers who may create one.
          canCreate,
          closeHref,
        }
      : null;

  return {
    title: t("list.title"),
    description: t("list.description", { count: total }),
    canPost: canCreate,
    scopeUnavailable,
    scopeUnavailableMessage: t("list.noAvailableSubsidiary"),
    currentParams: sp,
    draftsView,
    tabs,
    drawerOpen: Boolean(drawer),
    drawer,
  };
}

const f = ref<JournalData>();

export function journalSpec(data: JournalData): PageSpec {
  return page({
    route: "/journal",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        // The create button shows iff the server would allow the save:
        // ?entryNew=1 opens nothing without gl.post, so offering it would
        // be a dead click. The drawer's explicit Save enforces gl.post too.
        actions: [
          widget("new-journal", {}, f("canPost")),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      {
        ...panel({
          title: f("scopeUnavailableMessage"),
          iconKey: "triangle-alert",
          bodyClassName: "p-0",
          className: "shrink-0",
          blocks: [
            widgetBlock("attention-list", {
              items: [{ tone: "warning", text: f("scopeUnavailableMessage") }],
              allClear: "",
            }),
          ],
        }),
        when: f("scopeUnavailable"),
      },
      widgetBlock("entity-list-view", {
        recordType: data.draftsView ? "journal_draft" : "journal",
        sp: data.currentParams,
        drawer: { widget: "journal-drawer", props: { drawer: data.drawer } },
        // The empty-state New is the same dead click without gl.post, and
        // the slot carries no `when` — the loader flag decides at build.
        emptyAction: data.canPost ? { widget: "new-journal", props: {} } : null,
      }),
    ],
  });
}
