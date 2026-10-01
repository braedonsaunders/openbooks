# Organization workspace and employee update policy

The organization workspace is a manually composed view of native HR records. A new workspace is empty. Employees and open positions are placed from the searchable, paginated sidebar; departments, teams and roles can be represented by named placeholders. These placeholders describe the diagram and do not create employees, departments or reporting relationships.

The editor fills the app content area below the main menu without outer padding or a page-level search/filter row. The existing React Flow canvas, house controls, drawers and native employee editor provide pan, zoom, focus, collapse, card placement and effective-dated editing. Directory remains a native registered list. The canvas renders visible elements and the sidebar pages its results, so a large roster need not become thousands of DOM cards. The layout accepts up to 10,000 manually placed cards.

## Ownership and synchronization

`worker_employments`, their effective-dated assignments, and `reporting_relationships` own employee facts. The layout stores only native identifiers, coordinates, placeholders and presentation connections in the organization settings. A real employee reporting line is derived each time from HR data when both employees have been placed. It cannot be persisted as a second diagram relationship.

Dragging a card changes its position. Connecting employee cards identifies a proposed manager update and opens an employee editor showing the intended change. Saving goes through the canonical employment writer. A pending change leaves the current reporting line intact; an applied change appears at its effective date. Removing a card only removes its placement.

Layout writes require unrestricted employment read and manage permissions, validate references within the organization, serialize on the organization row, compare the saved revision and record the actor and before/after layout in the audit log. The dedicated `hrm.org_chart.read` permission provides a read-only canvas and basic person details without granting employment-record or directory access. Read-only viewers have no placement sidebar or editing controls. Restricted readers receive only placements for records visible in their native HR scope; unscoped placeholders are withheld. Historical views cannot save layouts.

## One native workflow engine

Employee editing presents **Save**, without requiring every business to work through formal approval screens. Native Flows determine the outcome. A flow for employment changes can explicitly choose **Apply immediately** when no approval step applies, or require approval steps. Flow creation offers this choice and creates a submission trigger for a direct policy; a new flow remains disabled until the administrator enables it.

Conditions can route by change kind, changed fields, proposed department, proposed manager and effective date. A single flow can apply routine edits immediately while routing selected changes through sequential or parallel approval gates. The existing graph engine supports additional approval layers without another HR-specific workflow engine. Reached gates in any enabled flow take precedence over direct application; any failed dispatch refuses the save. Missing policy is a named configuration refusal, not implicit approval.

Direct and approved paths share proposal validation, native authorization, aggregate revision checks, effective-dated writes and immutable application evidence. Direct application retains the completed flow execution, the exact policy graph, proposal digest, revision, actor and automatic decision mode; it does not invent a human approver. Human approval retains existing separation rules. A failure rolls back the complete application.

## Research informing the design

[Personio’s current org chart](https://support.personio.de/hc/en-us/articles/360017540757-Overview-of-the-Org-chart) uses graphical cards, search, pan and zoom, department/team views, and vacancies. [HiBob workforce planning](https://www.hibob.com/platform/planning/workforce-planning/) emphasizes interactive roles, vacancies, filtering and planning scenarios. These support a graphical workspace containing both people and organizational placeholders.

[Personio employee-data approvals](https://support.personio.de/hc/en-us/articles/21453114449053-Set-up-employee-data-change-approvals-in-Automations) separates editing permission from proposal permission and supports conditional approval routing. [BambooHR workflow customization](https://www.bamboohr.com/blog/hr-platform-customization) describes sequential, parallel and conditional approvals. The architectural inference is to configure workflow depth at the native policy layer while keeping the employee-editing experience consistent for small and large organizations.
