-- cancel-old-smoke-tickets.sql
-- Idempotent cleanup for stale May/June 2026 smoke/test tickets on Test Club.
--
-- Intended effect (only when status='active'):
--   1) Cancel ticket
--   2) Insert bet_canceled refund into ledger_entries (positive risk_amount)
--
-- Prefer the Node path when balances must move:
--   node scripts/cleanup-orphan-tickets.js --club=d616dc2a-95a6-473a-97b1-7da330878479 --before=2026-08-01
--   node scripts/cleanup-orphan-tickets.js --club=d616dc2a-95a6-473a-97b1-7da330878479 --before=2026-08-01 --confirm
--
-- Dry-run (2026-09-01): 0 active tickets matched; May smoke tickets were already
-- canceled with bet_canceled refund ledger rows present.

-- ── DRY RUN ────────────────────────────────────────────────────────────────
SELECT id, player_id, player_username, status, type, risk_amount, placed_at
FROM tickets
WHERE status = 'active'
  AND placed_at < '2026-08-01'
  AND club_id = 'd616dc2a-95a6-473a-97b1-7da330878479'
ORDER BY placed_at ASC;

-- ── CANCEL (no-op when none are active) ────────────────────────────────────
UPDATE tickets
SET status = 'canceled',
    canceled_at = COALESCE(canceled_at, now()),
    cancellation_reason = COALESCE(cancellation_reason, 'smoke_test_cleanup')
WHERE status = 'active'
  AND placed_at < '2026-08-01'
  AND club_id = 'd616dc2a-95a6-473a-97b1-7da330878479'
RETURNING id, player_id, risk_amount, placed_at;

-- ── REFUND LEDGER (skip tickets that already have a cancel refund) ─────────
INSERT INTO ledger_entries (
  id, club_id, player_id, ticket_id,
  type, amount, reason, created_at, created_by
)
SELECT
  'SMOKE_REFUND_' || t.id,
  t.club_id,
  t.player_id,
  t.id,
  'bet_canceled',
  t.risk_amount,
  'smoke_test_cleanup_refund',
  now(),
  'cancel-old-smoke-tickets'
FROM tickets t
WHERE t.club_id = 'd616dc2a-95a6-473a-97b1-7da330878479'
  AND t.status = 'canceled'
  AND t.placed_at < '2026-08-01'
  AND COALESCE(t.cancellation_reason, '') IN ('smoke_test_cleanup', '')
  AND NOT EXISTS (
    SELECT 1 FROM ledger_entries le
    WHERE le.ticket_id = t.id
      AND le.type IN ('bet_canceled', 'bet_cancelled', 'BET_CANCELED_REFUND')
  )
ON CONFLICT (id) DO NOTHING;
