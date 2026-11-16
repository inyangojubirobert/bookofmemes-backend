-- 052: Remove the financial services layer from the Book of Memes database
--
-- Deposits, cashouts, bank details, wallet-to-wallet transfers, trade agents,
-- currencies/FX and the BASC token waitlist now belong to Bascardo Oxygen
-- (Desktop/Bascardo Oxygen/backend/migrations/000 + 001). Book of Memes keeps
-- only closed-loop credits: wallets, wallet_transactions, wallet_holds,
-- wallet_ledger, revenue_sources/transactions, spend_vouchers, subscriptions,
-- play_purchases.
--
-- ⚠ IRREVERSIBLE. Before running:
--   1. Oxygen's 000_oxygen_financial_schema.sql and 001_oxygen_financial_data.sql
--      have been run in Oxygen's own Supabase project (001 holds every row of
--      these tables, exported 2026-11-12).
--   2. Take a Supabase backup (Database → Backups) of this project.
--   3. The Oxygen backend no longer points at this project.

-- ── 1. Views over financial tables ──────────────────────────────────────────
DROP VIEW IF EXISTS public.active_trade_agents CASCADE;
DROP VIEW IF EXISTS public.user_wallet_summary CASCADE;

-- ── 2. Financial tables ─────────────────────────────────────────────────────
-- CASCADE also removes foreign keys that point at them from kept tables
-- (wallet_transactions.currency_code → currencies,
--  spend_vouchers.transfer_id → p2p_transfers); the columns themselves stay.
DROP TABLE IF EXISTS
  public.trade_disputes,
  public.trade_escrow,
  public.agent_orders,
  public.agent_security_deposits,
  public.agent_stats,
  public.agent_rates,
  public.agent_liquidity,
  public.agent_kyc,
  public.agent_accounts,
  public.agents,
  public.token_waitlist,
  public.platform_cashout_revenue,
  public.transaction_reconciliation,
  public.wallet_balances,
  public.wallet_currencies,
  public.p2p_transfers,
  public.cashout_requests,
  public.provider_orders,
  public.deposit_notifications,
  public.deposit_requests,
  public.deposits,
  public.deposit_providers,
  public.withdrawal_requests,
  public.withdrawal_methods,
  public.bank_details,
  public.exchange_rates,
  public.currencies
CASCADE;

-- ── 3. Financial functions (every overload) ─────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'agent_confirm_cashout_paid', 'calculate_fee', 'cancel_agent_cashout',
        'cashout_platform_margin_pct', 'confirm_pair_device_transfer',
        'convert_currency_to_usd', 'credit_wallet_currency', 'get_fee_preview',
        'get_pair_device_requests', 'increment_wallet_balance',
        'lookup_wallet_for_transfer', 'lookup_wallet_profile',
        'open_cashout_dispute', 'preview_cashout_rate', 'process_transfer',
        'request_agent_cashout', 'sweep_expired_agent_orders',
        'refresh_agent_active_status', 'on_security_deposit_confirmed',
        'sync_deposit_status_on_request_change'
      ])
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig);
  END LOOP;
END;
$$;

-- ── 4. Financial column on a kept table (empty in production) ───────────────
ALTER TABLE public.wallets DROP COLUMN IF EXISTS bank_account;
