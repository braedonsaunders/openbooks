# Application navigation

Navigation has three responsibilities, with shared rendering and organization preferences.

| Surface | Responsibility | Component and source |
| --- | --- | --- |
| Main menu | Discover workspaces and destinations across the application | `SidebarNav`, `TopNav`, mobile navigation; `engine/src/navigation/nav-registry.ts` |
| Local route navigation | Switch between closely related working pages or URL views | `ModuleHomeTabs`, `PageViewTabs`; `engine/src/navigation/local-navigation.ts` |
| Record panels | Switch content within a record or analytical workspace | `RecordTabs` over the house `SubtabNav`; native form-layout metadata |

The default workspace order is My Work, Customers, Purchasing, Operations, People, Banking, Accounting, Insights, and Settings. Company-defined ordering and placements take precedence. The top bar reserves overflow space for More and keeps the same logical order as the sidebar and mobile drawer. Grouped dropdowns use two independent, balanced columns, keeping each section intact and the configured reading order contiguous. Tall menus scroll within the viewport.

Workspace labels with a homepage are direct links. A separate, labelled menu button opens their destinations. Menu buttons support Arrow Down and Arrow Up, menus support Home, End and vertical arrows, and Escape returns focus to the opener. This preserves direct access to the homepage without requiring pointer hover. Local route links expose `aria-current`; they do not claim to be ARIA tabs. They use the global pill switch in the top-right page-header action rail. Their order remains stable at narrow widths; measured overflow folds into the shared More menu and names the active overflow destination. `RecordTabs` provides roving focus, disabled-choice skipping, RTL-aware arrows, Home and End. When given panel content, it associates the selected control with its labelled panel. Existing pressed-button selectors remain appropriate where the surrounding drawer does not own a tabpanel.

## Workspace ownership

Broad workspace menus are not repeated as page-level tab strips. Customers, Purchasing, Banking, and Accounting use their homepage cockpits and main menus for cross-module discovery. A working page may still have a bounded local switch, such as journal entries and drafts, chart-of-accounts list and hierarchy, or inventory views.

People links directly to `/hrm`. Human Resources is not repeated as a Workforce destination. Workforce contains the employee directory and employment administration; Time Off, Talent, Rewards, Payroll, and Payroll Controls form separate sections. Talent groups recruitment with performance and development. Talent has two default main-menu entries: Recruiting and Performance. Positions, interviews, offers, postings, and pools remain inside Recruiting. Review cycles, calibration, talent and succession, retention, surveys, and settings remain inside Performance. These detailed views keep their stable registry identities and access requirements; companies can explicitly promote them to menu shortcuts in the Navigation editor without removing their local tabs. Independent Positions and Surveys entries remain discoverable when Recruiting or Performance is unavailable through features or permissions. The Performance entry names the workspace; Cycles names its review-cycle view. HR working pages have one local route strip. Process checklists and Checklist templates are adjacent Workforce destinations; templates require the process-management grant. Each page owns one contextual New action. Template drawers retain the list filters when closed. The HR feature does not become a dependency of Payroll. If HR is disabled, Employees and enabled Payroll destinations appear under Operations; HR-owned destinations disappear. Turning features off changes presentation without deleting records or saved navigation preferences.

Payroll configuration uses a shared family selector followed by the selected family's local row, avoiding two competing tab strips. The dashboard uses the same `ListPageLayout` and `PageHeader` composition as Customers, AR, and AP while retaining its authorized, user-configurable widget canvas.

## Configuration and access

`OrgNavConfig` remains version 2. The optional `architectureVersion` marker distinguishes reconciled defaults; `localNavigation` stores presentation preferences keyed by stable workspace IDs and hrefs. Reconciliation adds newly shipped destinations and promotes recognizable legacy People defaults while preserving custom groups, labels, links, visibility, mobile pins and deliberate placements. Explicit editor moves carry `placement: custom`.

The Navigation editor owns workspace and destination ordering, names, visibility, custom links, installed app shortcuts, four mobile pins, and registered local-view preferences. Native destination renames are shared with their route strips. Query-view and installed-app screen names can be customized locally. Resetting local order and visibility retains names. Page-owned inline choices retain their counts, active state, authorized choices and effective URLs.

Menus and local route strips use the same organization-scoped configuration snapshot. Product metadata owns permissions and feature requirements. Presentation preferences cannot create destinations or grant access. Permission and feature filtering happens before local preferences are applied. Hiding the current destination does not select a different page, and hiding every local choice cannot restore a legacy strip. Domain, API, and page guards remain responsible for access enforcement; menu visibility is only presentation.

Navigation saves validate registered hrefs, reject duplicates and unsafe links, hold an organization-scoped row lock, compare the editor revision, and write before/after audit evidence in the transaction. A zero-row configuration write refuses explicitly. Unchanged preferences for retired extension screens may be retained, while new or edited preferences must refer to the live catalog.

## Extension integration

Installed shortcuts remain explicit company placements; installation alone does not add an app to the menu. Active navigation contributions may specify `workspaceKey` for a registered route workspace, subject to their permission and an active placed shortcut. Inline native view switches are page-owned and do not accept extension route injection. Native app screens use `app:<app-key>` preferences, resolved against the organization's installed, active package version and rendered through `ModuleHomeTabs`. User-authored app titles and menu names remain literal content.

## Internationalization

Registry defaults reference translation keys rather than display slugs. All shipped menu destinations, group headings, local workspace names, editor controls, and navigation accessibility labels have English, French, Spanish, German, Brazilian Portuguese, Chinese, and Japanese catalogs. Translation conformance tests traverse the registry and resolve actual catalog keys. A readable product label is the defensive fallback for a new main-menu destination; key echoes are never treated as successful translations. User-authored names are not translated.

## Design references

The distinction between broad navigation and bounded related views follows [Nielsen Norman Group's tab guidance](https://www.nngroup.com/articles/tabs-used-right/), [Carbon's tab usage](https://carbondesignsystem.com/components/tabs/usage/), and [Carbon's UI shell](https://carbondesignsystem.com/components/UI-shell-left-panel/usage/). Record-panel keyboard behavior follows the [WAI-ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). Organization-specific presentation remains separate from access rights, consistent with [SAP Fiori navigation guidance](https://www.sap.com/design-system/fiori-design-web/v1-96/foundations/best-practices/global-patterns/navigation/navigation).
