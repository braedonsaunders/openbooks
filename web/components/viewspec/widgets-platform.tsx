import { type ComponentProps } from 'react'
import { IdentityCell, ActingCell, AccessControlCell } from '../../app/(app)/platform/access/sections'
import { GrantAccessForm } from '../../app/(app)/platform/_components/GrantAccessForm'
import { EmailSubjectCell, EmailEvidenceCell } from '../../app/(app)/platform/email-log/sections'
import { PlatformUserHeader, GrantActingCell, GrantControlCell, NoGrantsBody, IdentityRecordCard } from '../../app/(app)/platform/users/[id]/sections'
import { AdminRolesTable } from '../../app/(app)/admin/roles/sections'
import { NewRoleButton } from '../../app/(app)/admin/roles/RoleEditor'
import { AuditRowsTable, AuditEventFlyout, AuditDocsLink } from '../../app/(app)/admin/audit/sections'
import { NotificationsInbox, NotificationsMarkAllRead } from '../../app/(app)/notifications/NotificationsInbox'
import { AdminHubCard } from '../../app/(app)/admin/sections'
import { AdminUsersTable } from '../../app/(app)/admin/users/sections'
import { InviteUserButton } from '../../app/(app)/admin/users/InviteDialog'
import { UserIdentityCell, UserRolesCell, UserGrantsCell, UserManageCell } from '../../app/(app)/platform/users/sections'
import { OrgNameCell, OrgEnvironmentCell, OrgLocaleCell, OrgUsersCell, OrgOpenCell } from '../../app/(app)/platform/organizations/sections'
import { NewKeyButton, KeyDrawer } from '../../app/(app)/admin/api-keys/KeyDrawer'
import { str, num, type WidgetRenderer } from './widget-props'

/** Platform identity, access and administration adapters. Compose native components without changing their props or boundaries. */
export const PLATFORM_WIDGETS = {

  'new-api-key': () => <NewKeyButton />,

  'api-key-drawer': (props) => (
    <KeyDrawer keyRow={(props.keyRow as ComponentProps<typeof KeyDrawer>['keyRow']) ?? null} />
  ),


  'platform-user-header': (props) => (
    <PlatformUserHeader
      userId={str(props, 'userId') ?? ''}
      name={str(props, 'name') ?? ''}
      subtitle={str(props, 'subtitle') ?? ''}
      isActive={props.isActive === true}
      isSuperAdmin={props.isSuperAdmin === true}
      isSelf={props.isSelf === true}
      backHref={str(props, 'backHref') ?? '/platform/users'}
      backLabel={str(props, 'backLabel') ?? ''}
    />
  ),

  'grant-acting-cell': (props) => (
    <GrantActingCell name={str(props, 'name') ?? ''} email={str(props, 'email') ?? ''} />
  ),

  'grant-control-cell': (props) => (
    <GrantControlCell grantId={str(props, 'grantId') ?? ''} isActive={props.isActive === true} />
  ),

  'no-grants-body': () => <NoGrantsBody />,

  'identity-record-card': (props) => (
    <IdentityRecordCard
      title={str(props, 'title') ?? ''}
      facts={(props.facts as ComponentProps<typeof IdentityRecordCard>['facts']) ?? []}
    />
  ),

  /* --- org roles ------------------------------------------------------------- */
  /** Same doctrine as `admin-users-table`: the native page hand-rolls a plain
   *  `<table>` the spec's table vocabulary cannot name, so one component
   *  serves the page and the widget registry. */

  'admin-roles-table': (props) => (
    <AdminRolesTable
      roles={(props.roles as ComponentProps<typeof AdminRolesTable>['roles']) ?? []}
      subsidiaries={
        (props.subsidiaries as ComponentProps<typeof AdminRolesTable>['subsidiaries']) ?? null
      }
      basePath={str(props, 'basePath') ?? '/admin/roles'}
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
      sort={str(props, 'sort') ?? 'name'}
      dir={str(props, 'dir') === 'desc' ? 'desc' : 'asc'}
      labels={props.labels as ComponentProps<typeof AdminRolesTable>['labels']}
    />
  ),

  'new-role': (props) => (
    <NewRoleButton
      subsidiaries={(props.subsidiaries as ComponentProps<typeof NewRoleButton>['subsidiaries']) ?? null}
    />
  ),

  /* --- audit log ------------------------------------------------------------- */
  /** Not `docs-link-button`: that one is a 14px icon with no space before the
   *  label, this one a 15px icon with one. Same-looking buttons that are not
   *  the same button. */

  'audit-docs-link': (props) => (
    <AuditDocsLink href={str(props, 'href') ?? ''} label={str(props, 'label') ?? ''} />
  ),

  'audit-rows-table': (props) => (
    <AuditRowsTable
      rows={(props.rows as ComponentProps<typeof AuditRowsTable>['rows']) ?? []}
      selectedId={
        (str(props, 'selectedId') ?? undefined) as ComponentProps<typeof AuditRowsTable>['selectedId']
      }
    />
  ),

  'audit-event-drawer': (props) => {
    const drawer = props.drawer as {
      event: ComponentProps<typeof AuditEventFlyout>['event']
      closeHref: string
    } | null
    if (!drawer) return null
    return <AuditEventFlyout event={drawer.event} closeHref={drawer.closeHref} />
  },

  /* --- notifications inbox ---------------------------------------------------- */
  /** Not a `table` block: the inbox is a read/unread list whose rows mark
   *  themselves read on the way to the record they point at. */

  'notifications-inbox': (props) => (
    <NotificationsInbox
      rows={(props.rows as ComponentProps<typeof NotificationsInbox>['rows']) ?? []}
    />
  ),

  'notifications-mark-all-read': (props) => (
    <NotificationsMarkAllRead unread={num(props, 'unread') ?? 0} />
  ),

  'admin-hub-card': (props) => (
    <AdminHubCard
      href={str(props, 'href') ?? '#'}
      iconKey={str(props, 'iconKey') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      accent={
        (['teal', 'violet', 'amber', 'sky'] as const).find((a) => a === str(props, 'accent')) ??
        'teal'
      }
    />
  ),

  /* --- org users ------------------------------------------------------------ */
  /** A widget, not a `table` block: this page hand-rolls a plain <table> with
   *  its own classes, and the spec's table block offers only the two real
   *  table variants the app has. */

  'admin-users-table': (props) => (
    <AdminUsersTable
      users={(props.users as ComponentProps<typeof AdminUsersTable>['users']) ?? []}
      allRoles={(props.allRoles as ComponentProps<typeof AdminUsersTable>['allRoles']) ?? []}
      basePath={str(props, 'basePath') ?? '/admin/users'}
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
      sort={str(props, 'sort') ?? 'name'}
      dir={str(props, 'dir') === 'desc' ? 'desc' : 'asc'}
      labels={props.labels as ComponentProps<typeof AdminUsersTable>['labels']}
    />
  ),
  /** Invite entry point for the Users page header. The button owns its own
   *  drawer and strings (like the roles page's `new-role`), so the widget
   *  carries only the role picker options. */

  'invite-user': (props) => (
    <InviteUserButton
      allRoles={(props.allRoles as ComponentProps<typeof InviteUserButton>['allRoles']) ?? []}
    />
  ),
  /** A link wrapped in a Button — the plain form several admin headers use,
   *  distinct from `link-button` only in that the Link is on the OUTSIDE. */

  'email-subject-cell': (props) => (
    <EmailSubjectCell subject={str(props, 'subject') ?? ''} category={str(props, 'category') ?? ''} />
  ),

  'email-evidence-cell': (props) => (
    <EmailEvidenceCell summary={str(props, 'summary') ?? ''} error={str(props, 'error') ?? ''} />
  ),

  'user-identity-cell': (props) => (
    <UserIdentityCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      email={str(props, 'email') ?? ''}
      isSuperAdmin={props.isSuperAdmin === true}
      isActive={props.isActive === true}
    />
  ),

  'user-roles-cell': (props) => <UserRolesCell roles={(props.roles as string[]) ?? []} />,

  'user-grants-cell': (props) => (
    <UserGrantsCell label={str(props, 'label') ?? ''} emphasised={props.emphasised === true} />
  ),

  'user-manage-cell': (props) => <UserManageCell href={str(props, 'href') ?? ''} />,

  'org-name-cell': (props) => (
    <OrgNameCell name={str(props, 'name') ?? ''} subtitle={str(props, 'subtitle') ?? ''} />
  ),

  'org-environment-cell': (props) => (
    <OrgEnvironmentCell
      envKind={str(props, 'envKind') ?? ''}
      variant={(str(props, 'variant') ?? 'secondary') as ComponentProps<typeof OrgEnvironmentCell>['variant']}
      parentNote={str(props, 'parentNote') ?? ''}
    />
  ),

  'org-locale-cell': (props) => (
    <OrgLocaleCell country={str(props, 'country') ?? ''} currency={str(props, 'currency') ?? ''} />
  ),

  'org-users-cell': (props) => (
    <OrgUsersCell active={str(props, 'active') ?? ''} total={str(props, 'total') ?? ''} />
  ),

  'org-open-cell': (props) => <OrgOpenCell orgId={str(props, 'orgId') ?? ''} />,

  'identity-cell': (props) => (
    <IdentityCell name={str(props, 'name') ?? ''} detail={str(props, 'detail') ?? ''} />
  ),

  'acting-cell': (props) => (
    <ActingCell name={str(props, 'name') ?? ''} email={str(props, 'email') ?? ''} />
  ),

  'access-control-cell': (props) => (
    <AccessControlCell grantId={str(props, 'grantId') ?? ''} isActive={props.isActive === true} />
  ),
  /** Two callers, two shapes: the access list hands over the whole options
   *  bundle, the user record spreads its own fields and adds a default
   *  member. Accepting either keeps ONE entry in front of one component
   *  rather than a second entry that would drift from it. */

  'grant-access-form': (props) => {
    const options = (props.options as ComponentProps<typeof GrantAccessForm> | undefined) ?? {
      members: (props.members as ComponentProps<typeof GrantAccessForm>['members']) ?? [],
      organizations:
        (props.organizations as ComponentProps<typeof GrantAccessForm>['organizations']) ?? [],
      actingUsers: (props.actingUsers as ComponentProps<typeof GrantAccessForm>['actingUsers']) ?? [],
    }
    return (
      <GrantAccessForm {...options} defaultMemberUserId={str(props, 'defaultMemberUserId') ?? ''} />
    )
  },
} satisfies Record<string, WidgetRenderer>
