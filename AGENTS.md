# Repository Engineering Standards

## Financial-institution-grade ERP standard

All product, domain, data-model, code, API, UI, security, workflow, and architecture decisions in this repository must meet financial-institution-grade enterprise ERP standards. Prefer financial integrity, explicit controls, auditability, deterministic behavior, and long-term operability over implementation convenience.

At minimum, designs and implementations must preserve:

- strict organization and legal-entity isolation;
- balanced, deterministic, idempotent accounting and posting behavior;
- immutable posted history, with corrections performed through controlled reversals or adjusting entries;
- complete audit evidence for material configuration and transactional changes, including actor, timestamp, before/after state, and reason where appropriate;
- explicit lifecycle states, transition rules, approvals, permissions, segregation of duties, and safe concurrency controls;
- effective-dated configuration where changing a rule could otherwise reinterpret historical transactions;
- precise decimal and currency handling with no floating-point financial arithmetic;
- enforced invariants and feature dependencies at the domain/service and API boundaries, not only by hiding UI;
- backward-compatible migrations, preserved tenant data, and reversible operational rollout plans;
- clear ownership and a single source of truth for every financial policy and configuration value.

Do not introduce silent financial fallbacks, ambiguous overlapping configuration, UI-only enforcement, destructive feature toggles, or parallel sources of truth.

## Feature-gate hierarchy

Every organization-level feature gate must live on the single authoritative **Company Settings → Features** switchboard, without exceptions. Module-specific settings pages may display effective feature status and link to the Features page, but must not expose a second switch or persist a parallel gate. The main Projects gate on the Features page is the authoritative parent gate for the entire Projects domain.

Project capabilities such as job costing, project types, project billing, construction-style progress billing, schedules of values, change orders, applications for payment, retainage, labor costing/pricing, project reporting, and Field Tickets are subordinate Projects capabilities. Their gates, where a separate gate exists, must also live on the Features page and must not be independently available when the Projects parent gate is off. Enforce that dependency in the Features UI, navigation, pages, APIs, services/jobs, and configuration writes. Turning a feature off must preserve its data and audit history.
