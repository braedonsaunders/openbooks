import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { BookOpen } from "lucide-react";
import { Button } from "@openbooks/ui";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { can, requirePermission } from "../../../../../lib/authz";
import { subsidiaryFeatureEnabled } from "../../../../../lib/features";
import { requireProjectsFeature } from "../../../../../lib/projects-gate";
import {
  isUuid,
  parseListParams,
  pickString,
} from "../../../../../lib/list-params";
import { resolveFormLayout } from "../../../../../lib/customization/resolve";
import { loadFieldDefs } from "../../../../../lib/custom-fields";
import {
  LaborBillRateCards,
  type BillCardDetail,
  type BillCardRow,
} from "../labor-costing/LaborBillRateCards";

export const dynamic = "force-dynamic";

export default async function LaborPricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("admin.setup.manage");
  await requireProjectsFeature(authz.user.orgId);
  const orgId = authz.user.orgId;
  const subsidiaryUiEnabled = await subsidiaryFeatureEnabled(orgId);
  const sp = await searchParams;
  const t = await getTranslations("laborPricing");
  const list = parseListParams(sp, {
    sort: "effective",
    allowedSorts: ["effective"] as const,
    dir: "desc",
    perPage: 25,
  });
  const cardParam = pickString(sp.card);
  const selectedId =
    cardParam && cardParam !== "new" && isUuid(cardParam) ? cardParam : null;
  const timeParam = pickString(sp.time);
  const timeFilter = timeParam === "scheduled" || timeParam === "expired" || timeParam === "all" ? timeParam : "active";
  const dimensionParam = pickString(sp.dimension);
  const dimensionTypes = ["department", ...(subsidiaryUiEnabled ? ["subsidiary"] : []), "location", "class", "trade", "job_title", "other"] as const;
  const dimensionFilter = dimensionParam === "unscoped" || (dimensionTypes as readonly string[]).includes(dimensionParam ?? "") ? dimensionParam! : "all";
  const effectiveFilter = timeFilter === "active"
    ? sql`and v.status = 'active' and v.effective_from <= current_date and (v.effective_to is null or v.effective_to >= current_date)`
    : timeFilter === "scheduled"
      ? sql`and v.status <> 'retired' and v.effective_from > current_date`
      : timeFilter === "expired"
        ? sql`and (v.status = 'retired' or v.effective_to < current_date)`
        : sql``;
  const scopeFilter = dimensionFilter === "all"
    ? sql``
    : dimensionFilter === "unscoped"
      ? sql`and not exists (select 1 from labor_rate_version_scopes fs where fs.version_id = v.id)`
      : sql`and exists (select 1 from labor_rate_version_scopes fs where fs.version_id = v.id and fs.scope_type = ${dimensionFilter})`;

  const [
    cardsRes,
    countRes,
    selectedRes,
    itemsRes,
    timeTypesRes,
    departmentsRes,
    subsidiariesRes,
    locationsRes,
    classesRes,
    tradesRes,
    jobTitlesRes,
    projectsRes,
    customersRes,
    kindsRes,
    categoriesRes,
    txnTypesRes,
    orgRes,
  ] = await Promise.all([
    db.execute(sql`
      select v.id, v.rate_book_id, b.code, b.name, b.currency, v.effective_from::text,
             v.effective_to::text, v.status, p.derivation_policy,
             (select count(*)::int from item_rate_lines l where l.version_id=v.id) as line_count,
             (select count(*)::int from item_rate_book_assignments a where a.rate_book_id=b.id and a.is_active) as assignment_count
        from item_rate_versions v
        join item_rate_books b on b.id=v.rate_book_id
        join labor_rate_version_policies p on p.version_id=v.id
       where v.org_id=${orgId}
         ${effectiveFilter} ${scopeFilter}
         ${list.q ? sql`and (b.name ilike ${`%${list.q}%`} or b.code ilike ${`%${list.q}%`} or b.currency ilike ${`%${list.q}%`})` : sql``}
       order by v.effective_from desc,b.name
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
    db.execute(sql`
      select count(*)::int n from item_rate_versions v
      join item_rate_books b on b.id=v.rate_book_id
      join labor_rate_version_policies p on p.version_id=v.id
      where v.org_id=${orgId}
        ${effectiveFilter} ${scopeFilter}
        ${list.q ? sql`and (b.name ilike ${`%${list.q}%`} or b.code ilike ${`%${list.q}%`} or b.currency ilike ${`%${list.q}%`})` : sql``}`),
    selectedId
      ? db.execute(sql`
      select v.id,v.rate_book_id,b.code,b.name,b.currency,v.effective_from::text,v.effective_to::text,
             v.status,p.derivation_policy,v.custom,
        coalesce((select jsonb_agg(jsonb_build_object(
          'id',s.id,'scopeType',s.scope_type,'scopeValueId',s.scope_value_id,
          'scopeValueText',s.scope_value_text,'scopeLabel',coalesce(s.scope_value_text,
            case s.scope_type
              when 'department' then (select name from departments x where x.id=s.scope_value_id and x.org_id=v.org_id)
              when 'subsidiary' then (select name from subsidiaries x where x.id=s.scope_value_id and x.org_id=v.org_id)
              when 'location' then (select name from locations x where x.id=s.scope_value_id and x.org_id=v.org_id)
              when 'class' then (select name from classes x where x.id=s.scope_value_id and x.org_id=v.org_id)
              when 'trade' then (select name from trades x where x.id=s.scope_value_id and x.org_id=v.org_id)
            end),'includeChildren',s.include_children) order by s.created_at)
          from labor_rate_version_scopes s where s.version_id=v.id),'[]'::jsonb) scopes,
        coalesce((select jsonb_agg(jsonb_build_object(
          'id',a.id,'code',a.code,'name',a.name,'category',a.category,'calculation',a.calculation,
          'value',a.value,'unit',a.unit,'presentation',a.presentation,'threshold',a.threshold,
          'thresholdUnit',a.threshold_unit,'referenceText',a.reference_text,
          'targets',coalesce((select jsonb_agg(jsonb_build_object(
            'id',at.id,'targetType',at.target_type,'targetValueId',at.target_value_id,
            'targetValueText',at.target_value_text,'includeChildren',at.include_children,
            'targetLabel',coalesce(at.target_value_text,
              case at.target_type
                when 'item' then (select name from items x where x.id=at.target_value_id and x.org_id=v.org_id)
                when 'department' then (select name from departments x where x.id=at.target_value_id and x.org_id=v.org_id)
                when 'subsidiary' then (select name from subsidiaries x where x.id=at.target_value_id and x.org_id=v.org_id)
                when 'location' then (select name from locations x where x.id=at.target_value_id and x.org_id=v.org_id)
                when 'class' then (select name from classes x where x.id=at.target_value_id and x.org_id=v.org_id)
                when 'trade' then (select name from trades x where x.id=at.target_value_id and x.org_id=v.org_id)
                when 'project' then (select name from projects x where x.id=at.target_value_id and x.org_id=v.org_id)
                when 'customer' then (select display_name from parties x where x.id=at.target_value_id and x.org_id=v.org_id)
              end)) order by at.created_at) from labor_rate_adjustment_targets at where at.adjustment_id=a.id),'[]'::jsonb))
          order by a.sort_order,a.id) from labor_rate_adjustments a where a.version_id=v.id and a.is_active),'[]'::jsonb) adjustments,
        coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'code',t.code,'label',t.label,'content',t.content,'placement',t.placement) order by t.sort_order,t.id) from labor_rate_terms t where t.version_id=v.id),'[]'::jsonb) terms,
        coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'itemId',l.item_id,'itemName',i.name,'regular',l.bill_rate,'timeTypeRates',l.time_type_bill_rates) order by l.sort_order,l.id) from item_rate_lines l join items i on i.id=l.item_id where l.version_id=v.id),'[]'::jsonb) lines
      from item_rate_versions v
      join item_rate_books b on b.id=v.rate_book_id
      join labor_rate_version_policies p on p.version_id=v.id
      where v.id=${selectedId} and v.org_id=${orgId}`)
      : Promise.resolve({ rows: [] }),
    db.execute(
      sql`select id,name,kind,category from items where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(
      sql`select id,name,bill_multiplier from time_types where org_id=${orgId} and is_active order by bill_multiplier,name`,
    ),
    db.execute(
      sql`select id,name from departments where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(
      sql`select id,name,base_currency as currency from subsidiaries where org_id=${orgId} and is_active and not is_elimination order by name`,
    ),
    db.execute(
      sql`select id,name from locations where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(
      sql`select id,name from classes where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(
      sql`select id,name from trades where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(
      sql`select distinct trim(job_title) name from employee_roles where org_id=${orgId} and is_active and nullif(trim(job_title),'') is not null order by name`,
    ),
    db.execute(
      sql`select id,name from projects where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(
      sql`select p.id,p.display_name name from parties p join customer_roles c on c.party_id=p.id and c.org_id=${orgId} and c.is_active where p.org_id=${orgId} and p.is_active order by p.display_name`,
    ),
    db.execute(
      sql`select distinct kind value from items where org_id=${orgId} and is_active and nullif(trim(kind),'') is not null order by value`,
    ),
    db.execute(
      sql`select distinct category value from items where org_id=${orgId} and is_active and nullif(trim(category),'') is not null order by value`,
    ),
    db.execute(
      sql`select distinct kind value from documents where org_id=${orgId} order by value`,
    ),
    db.execute(
      sql`select base_currency, settings->'currencies' as currencies from orgs where id=${orgId}`,
    ),
  ]);

  const selected =
    (selectedRes as unknown as { rows: BillCardDetail[] }).rows[0] ?? null;
  const headerDefs = selected ? await loadFieldDefs("item_rate_versions") : [];
  const resolvedForm = selected
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: "labor_rate_card",
        userRoles: [authz.user.role],
        headerDefs,
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
    : null;
  const named = (rows: unknown) =>
    (rows as { rows: { id: string; name: string }[] }).rows;
  const org = (
    orgRes as unknown as {
      rows: { base_currency: string; currencies: string[] | null }[];
    }
  ).rows[0];
  const subsidiaryRows = (
    subsidiariesRes as unknown as {
      rows: { id: string; name: string; currency: string }[];
    }
  ).rows;
  const baseCurrency = org?.base_currency ?? "CAD";
  const currencies = [
    baseCurrency,
    ...Array.from(
      new Set([
        ...(Array.isArray(org?.currencies) ? org.currencies : []),
        ...subsidiaryRows.map((x) => x.currency).filter(Boolean),
      ]),
    )
      .filter((code) => code !== baseCurrency)
      .sort(),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {t("title")}
          </h2>
          <p className="max-w-4xl text-sm text-slate-500 dark:text-slate-400">
            {t("description")}
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/docs/labor-pricing">
            <BookOpen size={14} aria-hidden /> {t("docs")}
          </Link>
        </Button>
      </div>
      <LaborBillRateCards
        cards={(cardsRes as unknown as { rows: BillCardRow[] }).rows}
        selected={selected}
        creating={cardParam === "new"}
        total={Number(
          (countRes as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0,
        )}
        page={list.page}
        perPage={list.perPage}
        currentParams={sp}
        timeFilter={timeFilter}
        dimensionFilter={dimensionFilter}
        items={
          (
            itemsRes as unknown as {
              rows: {
                id: string;
                name: string;
                kind: string;
                category: string | null;
              }[];
            }
          ).rows
        }
        timeTypes={
          (
            timeTypesRes as unknown as {
              rows: { id: string; name: string; bill_multiplier: string }[];
            }
          ).rows
        }
        options={{
          department: named(departmentsRes),
          subsidiary: subsidiaryUiEnabled ? named(subsidiariesRes) : [],
          location: named(locationsRes),
          class: named(classesRes),
          trade: named(tradesRes),
          job_title: (
            jobTitlesRes as unknown as { rows: { name: string }[] }
          ).rows.map((x) => ({ id: x.name, name: x.name })),
          project: named(projectsRes),
          customer: named(customersRes),
          item_kind: (
            kindsRes as unknown as { rows: { value: string }[] }
          ).rows.map((x) => ({ id: x.value, name: x.value })),
          item_category: (
            categoriesRes as unknown as { rows: { value: string }[] }
          ).rows.map((x) => ({ id: x.value, name: x.value })),
          transaction_type: (
            txnTypesRes as unknown as { rows: { value: string }[] }
          ).rows.map((x) => ({ id: x.value, name: x.value })),
        }}
        currencies={currencies}
        layout={resolvedForm?.layout}
        forms={resolvedForm?.available ?? []}
        currentFormId={resolvedForm?.row?.id ?? null}
        customFieldDefs={
          headerDefs as unknown as import("../../../../../components/custom-field-inputs").CustomFieldDefClient[]
        }
        canCustomize={can(authz, "admin.customization.manage")}
      />
    </div>
  );
}
