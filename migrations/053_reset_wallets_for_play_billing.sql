-- 053: Fresh start for the Google Play Billing credit system
--
-- Clears every balance and money record left over from the old financial
-- system (deposits, transfers, BASC tokens, vouchers) so the wallet only ever
-- holds credits bought through Google Play from now on. Also retires
-- spend_tokens(): AI overage, HD generations and new-title posting now charge
-- credits through consume_app_balance().
--
-- ⚠ IRREVERSIBLE: zeroes every wallet and deletes all wallet history. Take a
-- Supabase backup first. play_purchases is NOT touched: anything bought
-- through Google Play stays recorded and refundable.
--
-- Run after 051 and 052.

BEGIN;

-- ── 1. Close anything that still has money reserved ──────────────────────────
-- Open marketplace bids: withdraw them. Their trigger releases the hold.
UPDATE public.marketplace_bids
   SET status = 'withdrawn', decided_at = now()
 WHERE status = 'active';

-- Leadership Games seats still waiting for a circle to fill: take the user
-- off the waitlist and free the seat, since their reserved join fee is about
-- to be cleared. Seats already confirmed (fee captured) are left as they are.
UPDATE public.game_circles gc
   SET seats_filled = GREATEST(gc.seats_filled - w.n, 0)
  FROM (SELECT circle_id, count(*) AS n
          FROM public.game_waitlist
         WHERE status = 'waiting'
         GROUP BY circle_id) w
 WHERE gc.id = w.circle_id
   AND gc.status = 'waitlisting';

UPDATE public.game_waitlist
   SET status = 'left'
 WHERE status = 'waiting';

-- ── 2. Clear the old money records ───────────────────────────────────────────
-- Foreign keys from marketplace_bids / game_waitlist to wallet_holds are
-- ON DELETE SET NULL, so the bid and seat history rows stay.
DELETE FROM public.wallet_holds;
DELETE FROM public.wallet_ledger;
DELETE FROM public.wallet_transactions;
DELETE FROM public.spend_vouchers;   -- created by the old P2P transfers

-- ── 3. Zero every balance ────────────────────────────────────────────────────
UPDATE public.wallets
   SET wallet_balance = 0,
       token_balance  = 0,
       updated_at     = now();

-- ── 4. Retire BASC token spending ────────────────────────────────────────────
-- token_balance stays as a column (always 0) because the wallet-creation
-- trigger and credit_play_purchase() still insert it.
DROP FUNCTION IF EXISTS public.spend_tokens(integer, text);

COMMIT;

-- Verify: every wallet at zero, no old history left
SELECT
  (SELECT count(*) FROM public.wallets WHERE wallet_balance <> 0 OR token_balance <> 0) AS non_zero_wallets,
  (SELECT count(*) FROM public.wallet_transactions) AS transactions,
  (SELECT count(*) FROM public.wallet_holds)        AS holds,
  (SELECT count(*) FROM public.wallet_ledger)       AS ledger_rows;
