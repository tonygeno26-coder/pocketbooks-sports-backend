-- PocketBooks feedback / report-issue persistence (ADDITIVE ONLY).
-- DO NOT APPLY TO PRODUCTION until owner DB approval.
--
-- Isolation: no FKs to tickets/ledger/bankroll; ticket_id is a reference string only.
-- Access: backend service_role only (RLS deny anon/authenticated). Players CREATE via API;
-- no public SELECT/list endpoints in this migration.

CREATE TABLE IF NOT EXISTS public.feedback_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id text NOT NULL,
  player_id text NOT NULL,
  category text NOT NULL,
  message text NOT NULL,
  ticket_id text NULL,
  page text NULL,
  viewport text NULL,
  app_version text NULL,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_reports_category_check
    CHECK (category IN ('bug', 'ux', 'odds', 'ticket', 'other')),
  CONSTRAINT feedback_reports_status_check
    CHECK (status IN ('new', 'reviewed', 'resolved')),
  CONSTRAINT feedback_reports_message_len_check
    CHECK (char_length(message) >= 1 AND char_length(message) <= 1200),
  CONSTRAINT feedback_reports_ticket_id_len_check
    CHECK (ticket_id IS NULL OR char_length(ticket_id) <= 128),
  CONSTRAINT feedback_reports_page_len_check
    CHECK (page IS NULL OR char_length(page) <= 120),
  CONSTRAINT feedback_reports_viewport_len_check
    CHECK (viewport IS NULL OR char_length(viewport) <= 40),
  CONSTRAINT feedback_reports_app_version_len_check
    CHECK (app_version IS NULL OR char_length(app_version) <= 64)
);

CREATE INDEX IF NOT EXISTS feedback_reports_club_created_idx
  ON public.feedback_reports (club_id, created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_reports_player_created_idx
  ON public.feedback_reports (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_reports_status_created_idx
  ON public.feedback_reports (status, created_at DESC);

ALTER TABLE public.feedback_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feedback_reports_deny_anon ON public.feedback_reports;
CREATE POLICY feedback_reports_deny_anon ON public.feedback_reports
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS feedback_reports_deny_authenticated ON public.feedback_reports;
CREATE POLICY feedback_reports_deny_authenticated ON public.feedback_reports
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.feedback_reports FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback_reports TO service_role;

-- ROLLBACK (manual, owner-approved only):
--   DROP TABLE IF EXISTS public.feedback_reports;
