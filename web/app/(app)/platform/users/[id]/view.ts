import 'server-only'

import { notFound } from 'next/navigation'
import {
  badge,
  column,
  field,
  frame,
  grid,
  heading,
  page,
  ref,
  rootRef,
  table,
  text,
  textBlock,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { isUuid } from '../../../../../lib/list-params'
import { platformGrantOptions, platformUser } from '../../../../../lib/platform-admin'
import { requireSuperAdmin } from '../../../../../lib/super-admin'

/**
 * A platform login identity and its cross-organization grants, split into a
 * loader and a spec.
 *
 * Everything interactive on this page is a bound SERVER ACTION — make/revoke
 * super admin, revoke a grant. A bound action is a capability and can never
 * travel through a spec, so each control is a widget that takes ids and binds
 * the action itself. The spec says WHICH user; the host decides what may be
 * done to them, and `requireSuperAdmin` still gates the whole loader.
 */

function formatDate(value: string | Date | null): string {
  if (!value) return 'Never'
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export interface PlatformGrantRow {
  id: string
  orgName: string
  actingName: string
  actingEmail: string
  statusLabel: string
  statusVariant: 'success' | 'secondary'
  isActive: boolean
}

export interface PlatformUserData {
  userId: string
  name: string
  subtitle: string
  isActive: boolean
  isSuperAdmin: boolean
  isSelf: boolean
  backHref: string
  backLabel: string
  accessTitle: string
  accessDescription: string
  grantFormMembers: unknown
  grantFormOrganizations: unknown
  grantFormActingUsers: unknown
  defaultMemberUserId: string
  noGrants: boolean
  hasGrants: boolean
  columnOrganization: string
  columnActsAs: string
  columnStatus: string
  columnControl: string
  grants: PlatformGrantRow[]
  identityTitle: string
  facts: { label: string; value: string; mono?: boolean }[]
}

export async function loadPlatformUser(id: string): Promise<PlatformUserData> {
  if (!isUuid(id)) notFound()
  const authz = await requireSuperAdmin()
  const [record, options] = await Promise.all([platformUser(id), platformGrantOptions()])
  if (!record) notFound()
  const { user, grants } = record

  return {
    userId: user.id,
    name: user.name,
    subtitle: `${user.email} · ${user.orgName}`,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin,
    isSelf: user.id === authz.user.homeUserId,
    backHref: '/platform/users',
    backLabel: 'Users',
    accessTitle: 'Cross-organization access',
    accessDescription:
      'Explicit production-organization mappings for this login identity. Super admins do not require grants.',
    grantFormMembers: options.members,
    // The user's own home org is never a grant target.
    grantFormOrganizations: options.organizations.filter(
      (organization) => organization.id !== user.orgId,
    ),
    grantFormActingUsers: options.actingUsers,
    defaultMemberUserId: user.id,
    noGrants: grants.length === 0,
    hasGrants: grants.length > 0,
    columnOrganization: 'Organization',
    columnActsAs: 'Acts as',
    columnStatus: 'Status',
    columnControl: 'Control',
    grants: grants.map((grant) => ({
      id: grant.id,
      orgName: grant.orgName,
      actingName: grant.actingName,
      actingEmail: grant.actingEmail,
      statusLabel: grant.isActive ? 'active' : 'revoked',
      statusVariant: grant.isActive ? ('success' as const) : ('secondary' as const),
      isActive: grant.isActive,
    })),
    identityTitle: 'Identity record',
    facts: [
      { label: 'User ID', value: user.id, mono: true },
      { label: 'Home organization', value: user.orgName },
      { label: 'Organization roles', value: user.roles.join(', ') },
      { label: 'Last login', value: formatDate(user.lastLoginAt) },
      { label: 'Created', value: formatDate(user.createdAt) },
    ],
  }
}

const f = ref<PlatformUserData>()
const item = field
const rootF = rootRef<PlatformUserData>()

export function platformUserSpec(data: PlatformUserData): PageSpec {
  return page({
    layout: 'detail',
    header: [
      widgetBlock('platform-user-header', {
        userId: data.userId,
        name: data.name,
        subtitle: data.subtitle,
        isActive: data.isActive,
        isSuperAdmin: data.isSuperAdmin,
        isSelf: data.isSelf,
        backHref: data.backHref,
        backLabel: data.backLabel,
      }),
    ],
    body: [
      grid('grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]', [
        grid('space-y-5', [
          grid(
            'space-y-3',
            [
              grid('', [
                heading(2, f('accessTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
                textBlock(f('accessDescription'), {
                  className: 'mt-1 text-sm text-slate-500 dark:text-slate-400',
                }),
              ]),
              widgetBlock('grant-access-form', {
                members: data.grantFormMembers,
                organizations: data.grantFormOrganizations,
                actingUsers: data.grantFormActingUsers,
                defaultMemberUserId: data.defaultMemberUserId,
              }),
              frame('card', [
                { ...widgetBlock('no-grants-body', {}), when: f('noGrants') },
                {
                  ...table({
                    variant: 'app',
                    rows: f('grants'),
                    rowKey: item('id'),
                    columns: [
                      column(rootF('columnOrganization'), text(item('orgName')), {
                        className: 'font-medium',
                      }),
                      column(
                        rootF('columnActsAs'),
                        widgetCell('grant-acting-cell', {
                          name: item('actingName'),
                          email: item('actingEmail'),
                        }),
                      ),
                      column(
                        rootF('columnStatus'),
                        badge(item('statusLabel'), { variant: item('statusVariant') }),
                      ),
                      column(
                        rootF('columnControl'),
                        widgetCell('grant-control-cell', {
                          grantId: item('id'),
                          isActive: item('isActive'),
                        }),
                        { align: 'right' },
                      ),
                    ],
                  }),
                  when: f('hasGrants'),
                },
              ]),
            ],
            { as: 'section' },
          ),
        ]),
        widgetBlock('identity-record-card', {
          title: data.identityTitle,
          facts: data.facts,
        }),
      ]),
    ],
  })
}
