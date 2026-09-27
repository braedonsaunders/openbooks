-- OpenBooks forward migration 0445_single_switch_modules.
--
-- Field time capture and every HRM module are now ONE feature switch each.
-- Their former sub-switches are retired: what they gated is on whenever the
-- module is on, and what a tenant may tune lives in the module's own setup
-- (geofences declared per project, photo rules in Timesheets setup and on
-- each kiosk, action and reason codes in the change-request vocabulary).
-- The HRM "AI assistance" switches are retired as well: each capability
-- follows the module that owns its data, and AI surfaces follow the
-- assistant's own permission.
--
-- (1) STORED SWITCHES. orgs.settings.features may still hold the retired
-- keys. They are removed outright. No module is switched on or off here: a
-- sub-switch could only ever take effect while its module was on, so the
-- module's own stored value already says everything that still matters.
-- The preflight names every org that had a retired switch explicitly off,
-- because that behaviour now follows the module.
--
-- (2) CREW BATCH APPROVAL. Approval routing for crew batches (and
-- timesheets) is authored in Flows; the bespoke per-org stage chain is
-- retired, so a batch is simply submitted, then approved once every flow
-- gate on it has resolved (or directly by a time approver when no flow
-- governs it). The two stage statuses collapse: approved_stage_2 was the
-- completed approval and becomes approved; approved_stage_1 was part-way
-- through a chain and returns to submitted, awaiting its approval. The
-- append-only event kinds collapse the same way to approved.
--
-- (3) STAGE CHAINS. time_approval_stages held the retired chains and is
-- dropped with its index and RLS policy. The preflight names every declared
-- chain so it can be re-authored as a flow.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- (1) Retired sub-feature switches.
UPDATE public.orgs
   SET settings = jsonb_set(
         settings,
         '{features}',
         (settings -> 'features') - ARRAY[
           'fieldTimeGeofence', 'fieldTimePhoto', 'fieldTimeKiosk', 'fieldTimeCrewEntry',
           'fieldTimeEquipment', 'fieldTimeMultiStageApproval',
           'hrmMeritCycles', 'hrmHeadcountPlans', 'hrmPayTransparency',
           'hrmOneOnOnes', 'hrmFeedback', 'hrmCompetencies', 'hrmCalibration', 'hrmSuccession',
           'hrmCelebrations', 'hrmManagerNudges', 'hrmActionReasons', 'hrmEventVerbs', 'hrmOrgChart',
           'hrmPrevailingWage', 'hrmCertifiedPayroll', 'hrmWorkersCompClasses', 'hrmApprenticeRatios', 'hrmPerDiem',
           'hrmDispatchGating', 'hrmEquipmentQualifications', 'hrmCertificationAlerts',
           'hrmDocumentRetention', 'hrmDataSubjectExport', 'hrmPulseSurveys',
           'hrmStructuredInterviews', 'hrmInterviewScheduling', 'hrmOfferSigning', 'hrmJobBoards',
           'hrmCandidateRetention', 'hrmTalentPool',
           'hrmAiAssist', 'hrmExplainPay', 'hrmPayrollAnomalies', 'hrmTimeAnomalies', 'hrmDrafting', 'hrmNlReports'
         ]::text[])
 WHERE jsonb_typeof(settings -> 'features') = 'object'
   AND (settings -> 'features') ?| ARRAY[
         'fieldTimeGeofence', 'fieldTimePhoto', 'fieldTimeKiosk', 'fieldTimeCrewEntry',
         'fieldTimeEquipment', 'fieldTimeMultiStageApproval',
         'hrmMeritCycles', 'hrmHeadcountPlans', 'hrmPayTransparency',
         'hrmOneOnOnes', 'hrmFeedback', 'hrmCompetencies', 'hrmCalibration', 'hrmSuccession',
         'hrmCelebrations', 'hrmManagerNudges', 'hrmActionReasons', 'hrmEventVerbs', 'hrmOrgChart',
         'hrmPrevailingWage', 'hrmCertifiedPayroll', 'hrmWorkersCompClasses', 'hrmApprenticeRatios', 'hrmPerDiem',
         'hrmDispatchGating', 'hrmEquipmentQualifications', 'hrmCertificationAlerts',
         'hrmDocumentRetention', 'hrmDataSubjectExport', 'hrmPulseSurveys',
         'hrmStructuredInterviews', 'hrmInterviewScheduling', 'hrmOfferSigning', 'hrmJobBoards',
         'hrmCandidateRetention', 'hrmTalentPool',
         'hrmAiAssist', 'hrmExplainPay', 'hrmPayrollAnomalies', 'hrmTimeAnomalies', 'hrmDrafting', 'hrmNlReports'
       ]::text[];

-- (2) Crew batch statuses and event kinds.
ALTER TABLE public.crew_time_batches DROP CONSTRAINT IF EXISTS crew_time_batches_status;
UPDATE public.crew_time_batches SET status = 'approved' WHERE status = 'approved_stage_2';
UPDATE public.crew_time_batches SET status = 'submitted' WHERE status = 'approved_stage_1';
ALTER TABLE public.crew_time_batches
  ADD CONSTRAINT crew_time_batches_status CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected', 'posted'));

ALTER TABLE public.crew_time_batch_events DROP CONSTRAINT IF EXISTS crew_time_batch_events_kind;
UPDATE public.crew_time_batch_events
   SET kind = 'approved'
 WHERE kind IN ('approved_stage_1', 'approved_stage_2');
ALTER TABLE public.crew_time_batch_events
  ADD CONSTRAINT crew_time_batch_events_kind CHECK (
    kind IN ('created', 'line_edited', 'submitted', 'approved', 'rejected', 'withdrawn', 'posted', 'voided'));

-- (3) Retired stage chains. DROP TABLE carries the unique index and the
-- org_isolation policy with it.
DROP TABLE IF EXISTS public.time_approval_stages;
