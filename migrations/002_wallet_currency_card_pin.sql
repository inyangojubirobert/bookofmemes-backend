-- Adds a display-only "on the wallet card" flag to wallet_currencies, decoupled
-- from the balance/row itself. Previously the Wallet screen's currency card just
-- showed the first 5 wallet_currencies rows in insertion order with no way to
-- curate them; this lets a user keep a currency (and its balance) while hiding
-- it from the 8-slot card, and bring it back later -- distinct from
-- removeWalletCurrency (src/services/WalletService.js), which hard-deletes a
-- zero-balance row entirely.

ALTER TABLE wallet_currencies ADD COLUMN on_card boolean NOT NULL DEFAULT true;

-- Backfill: preserve current behavior for existing users -- keep the same
-- currencies "on card" that were already being shown (oldest-added first,
-- matching the existing is_primary DESC, insertion-order display), capped at 8.
-- Anything beyond the 8th per wallet is hidden from the card but not deleted.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY wallet_id ORDER BY is_primary DESC, created_at ASC
  ) AS rn
  FROM wallet_currencies
)
UPDATE wallet_currencies wc
SET on_card = false
FROM ranked r
WHERE wc.id = r.id AND r.rn > 8;
