-- wallet_transactions has RLS enabled (per database-schema.json) but was never
-- given a single policy -- unlike revenue_transactions/revenue_sources, this
-- table was always meant to be user-facing (WalletTransfer.js, now renamed
-- WalletTransactions.js, reads it directly client-side via WalletService.js's
-- getTransactions()). With zero policies, RLS default-denies every row to
-- every role including the owning user, so the screen loads successfully but
-- always renders empty -- no error, since a policy-less SELECT returns zero
-- matched rows rather than throwing.
CREATE POLICY wallet_transactions_select_own ON wallet_transactions
  FOR SELECT TO authenticated
  USING (wallet_id IN (SELECT id FROM wallets WHERE user_id = auth.uid()));
