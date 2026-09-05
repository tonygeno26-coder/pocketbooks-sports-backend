-- Durable team logo mappings (ESPN-backed). Extends player_photos pattern for teams.
CREATE TABLE IF NOT EXISTS public.team_logos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  provider text NOT NULL DEFAULT 'espn',
  provider_team_id text NOT NULL,
  canonical_name text NOT NULL,
  display_name text NOT NULL,
  abbreviation text,
  mascot text,
  location text,
  conference text,
  classification text,
  logo_url text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_logos_sport_provider_id_uq UNIQUE (sport, provider, provider_team_id)
);

CREATE INDEX IF NOT EXISTS team_logos_sport_canonical_idx
  ON public.team_logos (sport, lower(canonical_name));
CREATE INDEX IF NOT EXISTS team_logos_sport_display_idx
  ON public.team_logos (sport, lower(display_name));
CREATE INDEX IF NOT EXISTS team_logos_sport_abbrev_idx
  ON public.team_logos (sport, lower(abbreviation));
CREATE INDEX IF NOT EXISTS team_logos_aliases_gin_idx
  ON public.team_logos USING gin (aliases);
CREATE INDEX IF NOT EXISTS team_logos_sport_active_idx
  ON public.team_logos (sport, active);

ALTER TABLE public.team_logos ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'team_logos' AND policyname = 'team_logos_select_active'
  ) THEN
    CREATE POLICY team_logos_select_active ON public.team_logos
      FOR SELECT TO authenticated
      USING (active = true);
  END IF;
END $$;

COMMENT ON TABLE public.team_logos IS 'Canonical team logo mappings synced from ESPN (and future providers).';
