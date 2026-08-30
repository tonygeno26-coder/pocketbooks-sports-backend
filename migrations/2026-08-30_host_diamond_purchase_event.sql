-- Allow crypto diamond purchases to write HOST_DIAMOND_PURCHASE on the host ledger.
ALTER TABLE host_diamond_ledger DROP CONSTRAINT IF EXISTS host_diamond_ledger_event_type_check;
ALTER TABLE host_diamond_ledger ADD CONSTRAINT host_diamond_ledger_event_type_check
  CHECK (event_type IN (
    'HOST_DIAMOND_TOPUP',
    'HOST_ACTIVE_BETTOR_CHARGE',
    'HOST_DIAMOND_ADJUSTMENT',
    'HOST_DIAMOND_REFUND',
    'HOST_DIAMOND_PURCHASE'
  ));
