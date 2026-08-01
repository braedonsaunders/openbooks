import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { EntityListView } from '../../../../components/entity-list-view'
import { ListPageLayout } from '../../../../components/page-layout'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { summarizeGroup, type FieldDef } from '../../../../lib/conditions'
import { RuleDrawer, NewRuleButton, RunRulesButton } from './RuleDrawer'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('rules.title') }
}

export default async function BankingRules({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.reconcile')
  const t = await getTranslations('banking')
  const sp = await searchParams
  const openId = pickString(sp.rule)
  const fromLine = pickString(sp.fromLine)

  const [offsetAccounts, reconAccounts, departments, locations, classes, taxCodes, parties, open, seedLine] =
    (await Promise.all([
      db.execute(sql`
        select id, number, name from accounts
         where org_id = ${authz.user.orgId} and is_active and not is_summary
         order by number nulls last limit 2000
      `),
      db.execute(sql`
        select id, number, name from accounts
         where org_id = ${authz.user.orgId} and reconcilable and not is_summary and is_active
         order by number nulls last
      `),
      db.execute(sql`select id, code, name from departments where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute(sql`select id, code, name from locations where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute(sql`select id, code, name from classes where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute(sql`select id, code, name from tax_codes where org_id = ${authz.user.orgId} and is_active order by code limit 500`),
      db.execute(sql`select id, display_name from parties where org_id = ${authz.user.orgId} and is_active order by display_name limit 2000`),
      openId && openId !== 'new' && isUuid(openId)
        ? db.execute(sql`
            select id, name, criteria, outcome, priority, is_active
              from bank_match_rules where id = ${openId} and org_id = ${authz.user.orgId}
          `)
        : Promise.resolve({ rows: [] }),
      fromLine && isUuid(fromLine)
        ? db.execute(sql`
            select l.description, l.amount from bank_statement_lines l
             where l.id = ${fromLine} and l.org_id = ${authz.user.orgId} limit 1
          `)
        : Promise.resolve({ rows: [] }),
    ])) as unknown as { rows: any[] }[]

  const accountOpts = offsetAccounts.rows.map((account: any) => ({
    value: account.id,
    label: [account.number, account.name].filter(Boolean).join(' · '),
  }))
  const reconAccountOpts = reconAccounts.rows.map((account: any) => ({
    id: account.id,
    label: [account.number, account.name].filter(Boolean).join(' · '),
  }))
  const dimensionOptions = (rows: any[]) => rows.map((dimension: any) => ({
    value: dimension.id,
    label: [dimension.code, dimension.name].filter(Boolean).join(' · '),
  }))
  const accountLabel = new Map(accountOpts.map((account) => [account.value, account.label]))
  const openRule = openId === 'new' ? null : (open.rows[0] ?? null)
  const drawerOpen = openId === 'new' || Boolean(open.rows[0])
  const seed = seedLine.rows[0]
    ? { description: seedLine.rows[0].description, amount: seedLine.rows[0].amount }
    : null

  const summaryCatalog: FieldDef[] = [
    { key: 'description', label: t('rules.fields.description'), kind: 'text' },
    { key: 'payee', label: t('rules.fields.payee'), kind: 'text' },
    { key: 'anyText', label: t('rules.fields.anyText'), kind: 'text' },
    { key: 'reference', label: t('rules.fields.reference'), kind: 'text' },
    { key: 'amount', label: t('rules.fields.amount'), kind: 'number' },
    { key: 'flow', label: t('rules.fields.flow'), kind: 'flow', options: [{ value: 'in', label: t('rules.signIn') }, { value: 'out', label: t('rules.signOut') }] },
    { key: 'date', label: t('rules.fields.date'), kind: 'date' },
  ]
  const operatorLabels = Object.fromEntries(
    ['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'isBlank', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is', 'on', 'before', 'after', 'withinDays']
      .map((key) => [key, t(`rules.ops.${key}`)]),
  )
  const whenSummary = (criteria: any) => summarizeGroup(criteria?.match, summaryCatalog, {
    and: t('rules.summary.and'),
    or: t('rules.summary.or'),
    operatorLabels,
  }) || t('rules.summary.anyLine')
  const outcomeSummary = (outcome: any) => {
    if (outcome?.action === 'exclude') return t('rules.summary.exclude')
    if (outcome?.action !== 'categorize') return '—'
    const first = accountLabel.get(outcome.lines?.[0]?.accountId) ?? '—'
    const extra = (outcome.lines?.length ?? 1) - 1
    return extra > 0
      ? t('rules.summary.categorizeSplit', { account: first, count: extra })
      : t('rules.summary.categorize', { account: first })
  }

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('home.title') }}
          title={t('rules.title')}
          description={t('rules.description')}
          actions={
            <div className="flex items-center gap-2">
              <RunRulesButton accounts={reconAccountOpts} />
              <NewRuleButton />
            </div>
          }
        />
      }
    >
      <EntityListView
        recordType="bank_rule"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        emptyAction={<NewRuleButton />}
        formatValue={(_row, columnKey, value) => {
          if (columnKey === 'criteria_summary') return whenSummary(value)
          if (columnKey === 'outcome_summary') return outcomeSummary(value)
          return undefined
        }}
      />

      {drawerOpen ? (
        <RuleDrawer
          rule={openRule}
          accounts={accountOpts}
          reconAccounts={reconAccountOpts}
          departments={dimensionOptions(departments.rows)}
          locations={dimensionOptions(locations.rows)}
          classes={dimensionOptions(classes.rows)}
          taxCodes={dimensionOptions(taxCodes.rows)}
          parties={parties.rows.map((party: any) => ({ value: party.id, label: party.display_name }))}
          seedFromLine={seed}
        />
      ) : null}
    </ListPageLayout>
  )
}
