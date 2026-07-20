-- Clean cutover: remove the legacy approval engine. Approvals are owned
-- entirely by the Flows engine (flows / flow_runs / flow_gates); the
-- approval_policies / approval_requests / approval_steps tables and their
-- runtime (engine/src/approvals.ts) are deleted. CASCADE drops their foreign
-- keys, indexes, and RLS policies. Documents keep the shared 'pending_approval'
-- status, which the Flows engine sets.

drop table if exists approval_steps cascade;
drop table if exists approval_requests cascade;
drop table if exists approval_policies cascade;
