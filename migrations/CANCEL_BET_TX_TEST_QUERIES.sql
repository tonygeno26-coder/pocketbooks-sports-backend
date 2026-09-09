-- Designated-test-account matrix for cancel_bet_tx isolation.
-- Replace placeholders with OWNER-APPROVED test club/player/ticket IDs only.
-- DO NOT run against ordinary production users.
--
-- Placeholders:
--   :club_a          correct club for the test ticket
--   :club_b          different club (wrong club)
--   :player_a        correct owner of the test ticket
--   :player_b        different player (wrong player)
--   :ticket_active   active/open ticket owned by player_a @ club_a (membership EXISTS)
--   :ticket_settled  won/lost/push ticket owned by player_a @ club_a
--   :ticket_canceled already canceled ticket owned by player_a @ club_a
--   :orphan_ticket   active ticket whose club_members row does NOT exist
--                    (create only in a designated test club; do not leave orphaned)

-- A) Valid cancel — correct club + player + ticket → ok, refund = risk_amount
-- SELECT public.cancel_bet_tx(
--   :ticket_active, :club_a, :player_a,
--   'TEST_CANCEL_VALID_' || gen_random_uuid()::text,
--   'prod_gate_valid', 'prod_gate'
-- );

-- B) Wrong club → ticket_club_mismatch (no status change, no ledger)
-- SELECT public.cancel_bet_tx(
--   :ticket_active, :club_b, :player_a,
--   'TEST_CANCEL_WRONG_CLUB_' || gen_random_uuid()::text,
--   'prod_gate_wrong_club', 'prod_gate'
-- );

-- C) Wrong player → ticket_player_mismatch
-- SELECT public.cancel_bet_tx(
--   :ticket_active, :club_a, :player_b,
--   'TEST_CANCEL_WRONG_PLAYER_' || gen_random_uuid()::text,
--   'prod_gate_wrong_player', 'prod_gate'
-- );

-- D) Missing membership → no_club_member_balance_found (NO phantom $1000)
-- SELECT public.cancel_bet_tx(
--   :orphan_ticket, :club_a, :player_a,
--   'TEST_CANCEL_NO_MEMBER_' || gen_random_uuid()::text,
--   'prod_gate_no_member', 'prod_gate'
-- );

-- E) Nonexistent ticket → ticket_not_found
-- SELECT public.cancel_bet_tx(
--   'NO_SUCH_TICKET', :club_a, :player_a,
--   'TEST_CANCEL_NF_' || gen_random_uuid()::text,
--   'prod_gate_nf', 'prod_gate'
-- );

-- F) Already canceled → ok + idempotent + refund 0 (no second ledger)
-- SELECT public.cancel_bet_tx(
--   :ticket_canceled, :club_a, :player_a,
--   'TEST_CANCEL_ALREADY_' || gen_random_uuid()::text,
--   'prod_gate_already', 'prod_gate'
-- );

-- G) Settled ticket → invalid_transition (cannot incorrectly refund)
-- SELECT public.cancel_bet_tx(
--   :ticket_settled, :club_a, :player_a,
--   'TEST_CANCEL_SETTLED_' || gen_random_uuid()::text,
--   'prod_gate_settled', 'prod_gate'
-- );

-- H) Cross-club balance proof (read-only after a Club B cancel attempt)
-- Compare club_members.balance_start and open risk aggregates for club_a vs club_b
-- for the same player — Club A bankroll presentation must be unchanged by a
-- rejected Club B cancel call.
--
-- SELECT m.club_id, m.player_id, m.balance_start,
--        (SELECT coalesce(sum(risk_amount),0) FROM tickets t
--          WHERE t.player_id = m.player_id AND t.club_id = m.club_id
--            AND lower(t.status) IN ('active','open')) AS open_risk
-- FROM club_members m
-- WHERE m.player_id = :player_a
--   AND m.club_id IN (:club_a, :club_b);

-- I) Idempotent key replay (same key twice after valid cancel)
-- SELECT public.cancel_bet_tx(:ticket_active, :club_a, :player_a, :same_key, 'replay', 'prod_gate');
-- SELECT public.cancel_bet_tx(:ticket_active, :club_a, :player_a, :same_key, 'replay', 'prod_gate');
