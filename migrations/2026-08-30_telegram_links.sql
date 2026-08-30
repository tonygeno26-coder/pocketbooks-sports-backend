-- Telegram chat_id ↔ survivor player mapping for pick reminders.
CREATE TABLE IF NOT EXISTS public.telegram_links (
  player_id text PRIMARY KEY,
  username text NOT NULL,
  chat_id text NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_links_chat_id ON public.telegram_links(chat_id);

-- Backend uses service_role; lock down like other survivor tables.
ALTER TABLE public.telegram_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_links TO service_role;
