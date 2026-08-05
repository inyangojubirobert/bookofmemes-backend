-- Two fixes found from live testing of 016_leadership_games.sql (already
-- applied to Supabase, so these are separate ALTER/CREATE OR REPLACE
-- statements rather than edits to that file -- same convention 010 used to
-- patch 005/007/009 rather than rewriting them).

-- ── 1. wallet_transactions_type_check ────────────────────────────────────────
-- activate_leadership_circle inserts type = 'leadership_game_join_fee' and
-- settle_leadership_circle inserts type = 'leadership_game_prize' -- neither
-- was ever added to this table's whitelist CHECK constraint, so every join
-- that filled a circle to its group_size failed at activation with
-- "violates check constraint wallet_transactions_type_check" (visible to the
-- user as the "Could not join waitlist" alert) and rolled back atomically --
-- the failed join's wallet_hold/game_waitlist row/seats_filled increment
-- were never actually persisted (Postgres rolls back the whole function call
-- on an unhandled exception), which is why a circle could look stuck at
-- "1/2 joined" forever with no orphaned rows to clean up.
--
-- This exact bug class has hit wallet_transactions before -- see 010's own
-- comment ("same class of bug this table has hit before"). Sampled the live
-- table's distinct `type` values via the service-role key before touching
-- this (2026-08-05): all 8 seen are a subset of 010's declared list, so no
-- further undocumented drift was found -- safe to extend from that list.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_type_check;

ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'deposit'::text, 'cashout'::text, 'cashout_cancelled'::text,
    'token_purchase'::text, 'token_spend'::text, 'token_reward'::text,
    'transfer_in'::text, 'transfer_out'::text, 'transfer_fee'::text,
    'marketplace_listing_fee'::text, 'marketplace_featured_fee'::text,
    'marketplace_purchase'::text, 'marketplace_sale'::text, 'marketplace_royalty'::text,
    'currency_conversion'::text,
    'leadership_game_join_fee'::text, 'leadership_game_prize'::text
  ]));

-- ── 2. leave_leadership_waitlist can't be rejoined ───────────────────────────
-- The original version soft-deleted a left seat (status = 'left'), but
-- game_waitlist has UNIQUE (circle_id, user_id) on the whole table regardless
-- of status -- so once someone left a still-waitlisting circle, that stale
-- 'left' row permanently blocked them from ever joining that same circle
-- again (join_leadership_waitlist's "already joined this circle" check
-- matches any row for that pair, and even past that check the INSERT would
-- hit the UNIQUE constraint). Leaving a waitlist should free the seat
-- completely, same as never having joined -- there's no feature need for a
-- "left" audit trail, so this now deletes the row outright instead of
-- reworking the unique constraint into a partial index.
CREATE OR REPLACE FUNCTION public.leave_leadership_waitlist(p_waitlist_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seat game_waitlist%ROWTYPE;
BEGIN
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_seat FROM game_waitlist WHERE id = p_waitlist_id FOR UPDATE;
  IF NOT FOUND OR v_seat.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Waitlist entry not found';
  END IF;
  IF v_seat.status <> 'waiting' THEN
    RAISE EXCEPTION 'This circle has already started -- you can no longer leave';
  END IF;

  UPDATE wallet_holds SET status = 'released' WHERE id = v_seat.wallet_hold_id AND status = 'held';
  UPDATE game_circles SET seats_filled = GREATEST(0, seats_filled - 1) WHERE id = v_seat.circle_id;
  DELETE FROM game_waitlist WHERE id = p_waitlist_id;
END;
$function$;
