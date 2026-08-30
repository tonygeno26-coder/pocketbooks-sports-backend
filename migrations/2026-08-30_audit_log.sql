-- Daily automated audit history. Backend service_role only; never auto-fixes balances.
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  audit_type text NOT NULL,
  checks_run integer NOT NULL DEFAULT 0,
  issues_found integer NOT NULL DEFAULT 0,
  critical_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  results_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggered_by text NOT NULL,
  CONSTRAINT audit_log_audit_type_check CHECK (audit_type IN ('daily', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_run_at ON public.audit_log (run_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_deny_anon ON public.audit_log;
CREATE POLICY audit_log_deny_anon ON public.audit_log
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS audit_log_deny_authenticated ON public.audit_log;
CREATE POLICY audit_log_deny_authenticated ON public.audit_log
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.audit_log FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_log TO service_role;
