-- OpenBooks forward migration 0363_hrm_survey_response_unique_questions.
-- Survey answers are one vote per question; reject duplicate ids at the storage boundary.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE FUNCTION public.hrm_survey_answers_have_unique_question_ids(p_answers jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT pg_catalog.jsonb_typeof(p_answers) = 'array'
     AND pg_catalog.jsonb_array_length(p_answers) = (
       SELECT count(DISTINCT answer ->> 'questionId')
         FROM pg_catalog.jsonb_array_elements(p_answers) AS elems(answer)
     )
$$;

CREATE FUNCTION public.trg_hrm_survey_response_unique_questions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT public.hrm_survey_answers_have_unique_question_ids(NEW.answers) THEN
    RAISE EXCEPTION 'survey response must contain at most one answer per question'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'hrm_survey_responses_unique_question_ids';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hrm_survey_responses_unique_question_ids
  BEFORE INSERT ON public.hrm_survey_responses
  FOR EACH ROW EXECUTE FUNCTION public.trg_hrm_survey_response_unique_questions();
