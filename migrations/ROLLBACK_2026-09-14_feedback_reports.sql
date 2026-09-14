-- Rollback for 2026-09-14_feedback_reports.sql
-- Owner-approved only. Drops the isolated feedback_reports table.
-- Does not touch tickets, ledger, bankroll, settlement, or Diamonds tables.

DROP TABLE IF EXISTS public.feedback_reports;
