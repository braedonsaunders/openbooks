import type { DocArticle } from '../types'

export const apps: DocArticle = {
  slug: 'apps',
  title: 'Apps and the App Library',
  category: 'apps',
  order: 1,
  summary: 'Find, install, update, open, and administer extensions for your organization.',
  updated: '2026-07-31',
  related: ['app-builder', 'app-api-reference'],
  keywords: ['apps', 'extensions', 'library', 'install', 'update', 'app builder', 'marketplace', 'dashboard', 'navigation'],
  body: `# Apps and the App Library

Apps extend the platform with organization-specific workflows, screens, records,
and governed backend actions. Every installed app runs in an isolated sandbox and
can use only the permissions granted to it by an administrator.

## Open an installed app

Go to **Apps** from the main navigation. Search by app name, key, or description,
then select a card to open it. Only active, fully installed apps appear here.

If an app you expect is missing, ask an administrator to confirm that it is
installed and enabled for your organization.

## Add apps to navigation and dashboards

Installed apps participate in the same customizable surfaces as built-in
destinations:

- In **Settings → Navigation**, add an app shortcut to any workspace, move or
  rename it, hide it, or make it one of the four mobile shortcuts. Apps whose
  package enables navigation are added to **My Work** automatically the first
  time they appear.
- On **Dashboard → Customize**, choose an installed app from the widget drawer
  to add a resizable launcher card.
- The dashboard **Quick actions** editor includes installed apps in the same
  destination selector as built-in pages.

These are host-rendered shortcuts. Each shortcut opens the app on its isolated
screen, and placement on a menu or dashboard grants no additional app
permissions. Disabled or uninstalled apps disappear from these surfaces.

## Browse the App Library

Users with **Install and manage apps** permission can select **App Library** from
the Apps page. The library shows extensions that are available to the deployment.
Use search to narrow the list by name, key, or description.

- **Install** copies the published app package into your organization.
- **Update** installs the library version over an older installed version.
- **Installed** means your organization already has the current library version.

An install or update validates the package and its requested capabilities before
making the new version active. Installed app settings and permissions remain
scoped to your organization.

## Build and administer apps

Go to **Settings → Extend → App Builder** to create an app, import a package, edit
its files, review execution logs, control permissions, enable or disable it, and
publish an active version to the App Library. Authoring access is separate from
ordinary app use.

Before enabling an app, review its requested permissions and grant only the
capabilities it needs. Use the app's run history to investigate failed backend
actions.
`,
}
