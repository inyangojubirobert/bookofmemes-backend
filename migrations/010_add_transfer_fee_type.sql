-- process_transfer (Backend/migrations/005/007/009) writes a 'transfer_fee'
-- row to wallet_transactions for the fee line item, but that value was never
-- added to wallet_transactions_type_check -- every USD transfer with a fee
-- (i.e. every USD transfer, since the fee floor is $0.10) failed with
-- "violates check constraint wallet_transactions_type_check". Confirmed via
-- pg_get_constraintdef the exact current allowed list before touching it, so
-- nothing already-working gets dropped -- same class of bug this table has
-- hit before (044_fix_wallet_transactions_type_check.sql in the prior
-- migration history).

ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_type_check;

ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'deposit'::text, 'cashout'::text, 'cashout_cancelled'::text,
    'token_purchase'::text, 'token_spend'::text, 'token_reward'::text,
    'transfer_in'::text, 'transfer_out'::text, 'transfer_fee'::text,
    'marketplace_listing_fee'::text, 'marketplace_featured_fee'::text,
    'marketplace_purchase'::text, 'marketplace_sale'::text, 'marketplace_royalty'::text,
    'currency_conversion'::text
  ]));
