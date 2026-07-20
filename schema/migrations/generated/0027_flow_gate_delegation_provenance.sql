-- Structured delegation provenance on flow_gates. Replaces the forgeable,
-- decision-overwritten comment-string markers ([delegated …] / [on behalf of …])
-- with typed columns a financial audit can trust:
--   delegated_from_user_id — the original assignee a gate was reassigned FROM
--   on_behalf_of_user_id   — the principal a delegate decided on behalf of
-- Table-level SELECT grants already cover new columns.

alter table flow_gates
  add column if not exists delegated_from_user_id uuid,
  add column if not exists on_behalf_of_user_id uuid;

alter table flow_gates
  add foreign key (delegated_from_user_id) references users(id),
  add foreign key (on_behalf_of_user_id) references users(id);
