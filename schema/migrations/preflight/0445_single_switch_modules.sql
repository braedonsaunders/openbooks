-- OpenBooks upgrade preflight for 0445_single_switch_modules.
--
-- Read-only notices (never a refusal: every row the migration rewrites has
-- one honest landing). Each row names behaviour that changes on upgrade:
-- a retired sub-switch that was explicitly off now follows its module, a
-- declared approval chain must be re-authored as a flow, and a crew batch
-- part-way through a chain returns to submitted. Zero rows means nothing
-- an org configured changes behaviour.
WITH retired(feature_key) AS (
  VALUES
    ('fieldTimeGeofence'), ('fieldTimePhoto'), ('fieldTimeKiosk'), ('fieldTimeCrewEntry'),
    ('fieldTimeEquipment'), ('fieldTimeMultiStageApproval'),
    ('hrmMeritCycles'), ('hrmHeadcountPlans'), ('hrmPayTransparency'),
    ('hrmOneOnOnes'), ('hrmFeedback'), ('hrmCompetencies'), ('hrmCalibration'), ('hrmSuccession'),
    ('hrmCelebrations'), ('hrmManagerNudges'), ('hrmActionReasons'), ('hrmEventVerbs'), ('hrmOrgChart'),
    ('hrmPrevailingWage'), ('hrmCertifiedPayroll'), ('hrmWorkersCompClasses'), ('hrmApprenticeRatios'), ('hrmPerDiem'),
    ('hrmDispatchGating'), ('hrmEquipmentQualifications'), ('hrmCertificationAlerts'),
    ('hrmDocumentRetention'), ('hrmDataSubjectExport'), ('hrmPulseSurveys'),
    ('hrmStructuredInterviews'), ('hrmInterviewScheduling'), ('hrmOfferSigning'), ('hrmJobBoards'),
    ('hrmCandidateRetention'), ('hrmTalentPool'),
    ('hrmAiAssist'), ('hrmExplainPay'), ('hrmPayrollAnomalies'), ('hrmTimeAnomalies'), ('hrmDrafting'), ('hrmNlReports')
)
SELECT '0445.retired_switch_was_off' AS code,
       'notice' AS severity,
       format('organization %s switch %s', o.id, r.feature_key) AS subject,
       format('organization %s has %s switched off; the switch is retired and what it gated now follows its module switch', o.id, r.feature_key) AS detail,
       'Review the module under Admin → Setup → Features and in its own setup: switch the whole module off, or tune its configuration, if the behaviour is not wanted.' AS remedy
  FROM public.orgs o
  JOIN retired r ON (o.settings -> 'features') -> r.feature_key = 'false'::jsonb
UNION ALL
SELECT '0445.approval_chain_retired' AS code,
       'notice' AS severity,
       format('organization %s %s approval chain', s.org_id, s.subject_kind) AS subject,
       format('organization %s declared a %s-stage %s approval chain; the chain is removed and approvals route through Flows', s.org_id, jsonb_array_length(s.stages), s.subject_kind) AS detail,
       'Author a flow on the timesheet week or crew time batch record in Flows with one approval step per former stage.' AS remedy
  FROM public.time_approval_stages s
 WHERE jsonb_typeof(s.stages) = 'array'
   AND jsonb_array_length(s.stages) > 0
UNION ALL
SELECT '0445.partially_approved_crew_batch' AS code,
       'notice' AS severity,
       format('crew batch %s', b.id) AS subject,
       format('crew batch %s of organization %s is part-way through a retired approval chain and returns to submitted', b.id, b.org_id) AS detail,
       'Approve or reject the batch on the crew page, or through its flow, after the upgrade.' AS remedy
  FROM public.crew_time_batches b
 WHERE b.status = 'approved_stage_1'
 ORDER BY 1, 3;
