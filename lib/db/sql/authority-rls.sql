BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pbs_app') THEN
    CREATE ROLE pbs_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'pbs_app'
      AND (
        rolcanlogin
        OR rolsuper
        OR rolcreatedb
        OR rolcreaterole
        OR rolinherit
        OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'pbs_app exists with unsafe role attributes; platform administrator action is required';
  END IF;
END
$$;

GRANT USAGE, CREATE ON SCHEMA public TO pbs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pbs_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO pbs_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pbs_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO pbs_app;

GRANT pbs_app TO CURRENT_USER;

ALTER TABLE public.ingestion_runs OWNER TO pbs_app;
ALTER TABLE public.drugs OWNER TO pbs_app;
ALTER TABLE public.pbs_items OWNER TO pbs_app;
ALTER TABLE public.predicted_reductions OWNER TO pbs_app;
ALTER TABLE public.schedule_changes OWNER TO pbs_app;
ALTER TABLE public.tga_shortage_observations OWNER TO pbs_app;
ALTER TABLE public.tga_shortage_matches OWNER TO pbs_app;

REVOKE CREATE ON SCHEMA public FROM pbs_app;

DROP POLICY IF EXISTS ingestion_runs_authority_policy ON public.ingestion_runs;
CREATE POLICY ingestion_runs_authority_policy ON public.ingestion_runs
  USING (authority_scope = 'production')
  WITH CHECK (authority_scope = 'production');

DROP POLICY IF EXISTS drugs_authority_policy ON public.drugs;
CREATE POLICY drugs_authority_policy ON public.drugs
  USING (authority_scope = 'production')
  WITH CHECK (authority_scope = 'production');

DROP POLICY IF EXISTS pbs_items_authority_policy ON public.pbs_items;
CREATE POLICY pbs_items_authority_policy ON public.pbs_items
  USING (authority_scope = 'production')
  WITH CHECK (authority_scope = 'production');

DROP POLICY IF EXISTS predicted_reductions_authority_policy ON public.predicted_reductions;
CREATE POLICY predicted_reductions_authority_policy ON public.predicted_reductions
  USING (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = predicted_reductions.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = predicted_reductions.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  );

DROP POLICY IF EXISTS schedule_changes_authority_policy ON public.schedule_changes;
CREATE POLICY schedule_changes_authority_policy ON public.schedule_changes
  USING (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = schedule_changes.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = schedule_changes.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  );

DROP POLICY IF EXISTS tga_shortage_observations_authority_policy ON public.tga_shortage_observations;
CREATE POLICY tga_shortage_observations_authority_policy ON public.tga_shortage_observations
  USING (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = tga_shortage_observations.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = tga_shortage_observations.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  );

DROP POLICY IF EXISTS tga_shortage_matches_authority_policy ON public.tga_shortage_matches;
CREATE POLICY tga_shortage_matches_authority_policy ON public.tga_shortage_matches
  USING (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = tga_shortage_matches.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.ingestion_runs authority_run
      WHERE authority_run.id = tga_shortage_matches.authority_run_id
        AND authority_run.authority_scope = 'production'
    )
  );

ALTER TABLE public.ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.drugs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drugs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pbs_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pbs_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.predicted_reductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predicted_reductions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tga_shortage_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tga_shortage_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tga_shortage_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tga_shortage_matches FORCE ROW LEVEL SECURITY;

COMMIT;