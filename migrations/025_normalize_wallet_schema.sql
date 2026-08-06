-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '002_normalize_wallet_schema.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- ============================================================
-- Migration 002: Normalize wallet schema (additive only)
-- Run this in the Supabase SQL editor when ready.
-- wallet_currencies.balance is kept as-is.
-- This migration only ADDS new columns and constraints.
-- ============================================================

-- 1. Add pending and locked balance columns to wallet_currencies
--    (these are new — balance stays as the spendable balance column)
ALTER TABLE wallet_currencies
  ADD COLUMN IF NOT EXISTS pending_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_balance  NUMERIC(12,2) NOT NULL DEFAULT 0;

-- 2. Add currency_code to wallet_transactions for per-currency ledger accuracy
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS currency_code CHARACTER(3) REFERENCES currencies(code) ON DELETE RESTRICT;

-- 3. Add currency_code to p2p_transfers with FK (if the column is currently named 'currency')
DO $$
BEGIN
  -- Rename if old column 'currency' exists and 'currency_code' does not
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'p2p_transfers' AND column_name = 'currency'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'p2p_transfers' AND column_name = 'currency_code'
  ) THEN
    ALTER TABLE p2p_transfers RENAME COLUMN currency TO currency_code;
  END IF;
END $$;

-- 4. wallet_balances conflicts with the multi-currency model.
--    Uncomment and run ONLY after confirming no live code reads this table.
-- DROP TABLE IF EXISTS wallet_balances;
