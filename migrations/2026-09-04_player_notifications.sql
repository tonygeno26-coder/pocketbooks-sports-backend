-- In-app notifications for survivor pool events (and general player alerts).
CREATE TABLE IF NOT EXISTS player_notifications (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  player_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_notifications_player_created_idx
  ON player_notifications (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS player_notifications_player_unread_idx
  ON player_notifications (player_id) WHERE read = false;
