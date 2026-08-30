\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE authority_test_drugs ON COMMIT DROP AS
SELECT id
FROM public.drugs
WHERE
  (
    name LIKE 'Regression ingredient %'
    AND active_ingredient LIKE 'Regression ingredient %'
    AND sponsor = 'PBS'
    AND first_pbs_listing_date = DATE '2020-01-01'
  )
  OR
  (
    name IN ('Task 32 fixture drug', 'Task 33 fixture drug')
    AND active_ingredient = 'Task 32 fixture ingredient'
    AND sponsor IN ('Task 32 fixture', 'Task 33 fixture')
    AND first_pbs_listing_date = DATE '2090-01-01'
  );

DO $$
DECLARE
  total_drugs integer;
  test_drugs integer;
  test_dependents integer;
  total_items integer;
  total_predictions integer;
  total_changes integer;
  total_runs integer;
  known_test_runs integer;
  known_test_run_dependents integer;
BEGIN
  SELECT count(*) INTO total_drugs FROM public.drugs WHERE authority_scope IS NULL;
  SELECT count(*) INTO test_drugs FROM authority_test_drugs;
  SELECT
    (SELECT count(*) FROM public.pbs_items WHERE drug_id IN (SELECT id FROM authority_test_drugs))
    + (SELECT count(*) FROM public.predicted_reductions WHERE drug_id IN (SELECT id FROM authority_test_drugs))
    + (SELECT count(*) FROM public.schedule_changes WHERE drug_id IN (SELECT id FROM authority_test_drugs))
  INTO test_dependents;
  SELECT count(*) INTO total_items FROM public.pbs_items WHERE authority_scope IS NULL;
  SELECT count(*) INTO total_predictions FROM public.predicted_reductions WHERE authority_run_id IS NULL;
  SELECT count(*) INTO total_changes FROM public.schedule_changes WHERE authority_run_id IS NULL;
  SELECT count(*) INTO total_runs FROM public.ingestion_runs WHERE authority_scope IS NULL;
  SELECT count(*) INTO known_test_runs
  FROM public.ingestion_runs
  WHERE id IN (749, 750)
    AND records_processed = 0
    AND pages_fetched = 0
    AND snapshot_complete = false
    AND finished_at IS NULL
    AND status IN ('completed', 'cancelled');
  SELECT
    (SELECT count(*) FROM public.raw_schedule_staging WHERE request_key LIKE '%:run-749' OR request_key LIKE '%:run-750')
    + (SELECT count(*) FROM public.predicted_reductions WHERE authority_run_id IN (749, 750))
    + (SELECT count(*) FROM public.schedule_changes WHERE authority_run_id IN (749, 750))
  INTO known_test_run_dependents;

  IF total_drugs <> 113 OR test_drugs <> 103 OR test_dependents <> 0 THEN
    RAISE EXCEPTION
      'Drug preflight changed: total %, test %, test dependents %',
      total_drugs, test_drugs, test_dependents;
  END IF;
  IF total_items <> 1284 OR total_predictions <> 828 OR total_changes <> 925 THEN
    RAISE EXCEPTION
      'Derived preflight changed: items %, predictions %, changes %',
      total_items, total_predictions, total_changes;
  END IF;
  IF total_runs <> 20 OR known_test_runs <> 2 OR known_test_run_dependents <> 0 THEN
    RAISE EXCEPTION
      'Run preflight changed: total %, known test %, test dependents %',
      total_runs, known_test_runs, known_test_run_dependents;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ingestion_runs WHERE id = -1) THEN
    RAISE EXCEPTION 'Legacy backfill authority root already exists';
  END IF;
END
$$;

INSERT INTO public.ingestion_runs (
  id,
  started_at,
  last_progress_at,
  finished_at,
  status,
  records_processed,
  pages_fetched,
  request_urls,
  mode,
  schedules_processed,
  snapshot_complete,
  authority_scope
) VALUES (
  -1,
  TIMESTAMPTZ '1970-01-01 00:00:00+00',
  TIMESTAMPTZ '1970-01-01 00:00:00+00',
  TIMESTAMPTZ '1970-01-01 00:00:00+00',
  'completed',
  0,
  0,
  '[]'::jsonb,
  'legacy_backfill',
  0,
  false,
  'production'
);

UPDATE public.drugs
SET authority_scope = 'test:legacy-shared-schema'
WHERE id IN (SELECT id FROM authority_test_drugs);

UPDATE public.drugs
SET authority_scope = 'production'
WHERE authority_scope IS NULL;

UPDATE public.pbs_items
SET authority_scope = 'production'
WHERE authority_scope IS NULL;

UPDATE public.ingestion_runs
SET authority_scope = CASE
  WHEN id IN (749, 750) THEN 'test:legacy-shared-schema'
  ELSE 'production'
END
WHERE authority_scope IS NULL;

UPDATE public.predicted_reductions
SET authority_run_id = -1
WHERE authority_run_id IS NULL;

UPDATE public.schedule_changes
SET authority_run_id = -1
WHERE authority_run_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.drugs
    WHERE authority_scope IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.pbs_items
    WHERE authority_scope IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.ingestion_runs
    WHERE authority_scope IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.predicted_reductions
    WHERE authority_run_id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.schedule_changes
    WHERE authority_run_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Authority backfill left NULL authority values';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.predicted_reductions pr
    LEFT JOIN public.ingestion_runs ir ON ir.id = pr.authority_run_id
    WHERE ir.authority_scope <> 'production' OR ir.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.schedule_changes sc
    LEFT JOIN public.ingestion_runs ir ON ir.id = sc.authority_run_id
    WHERE ir.authority_scope <> 'production' OR ir.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Derived rows do not resolve to production authority';
  END IF;
END
$$;

COMMIT;