// The new-title fee ($1), paid with wallet credits OR AI credits.
//
// Every new title (a story, a book, a meme collection, ...) costs $1. Until
// 2026-11-22 that could only come from wallet credits (wallets.wallet_balance,
// bought through Google Play), so a Pro/Business subscriber with hundreds of
// AI credits still couldn't publish a book from the Studio. Now the fee is
// taken from the wallet when it covers it, and otherwise from AI credits at
// NEW_TITLE_AI_CREDITS (= $1 at the top-up price, config/aiPlans.js), so it
// never undercuts what those credits sold for.
//
// Wallet first: wallet credits are what the fee was always priced in. AI
// credits are the fallback, never both.
import crypto from 'crypto';
import { hasCredits, chargeCredits } from './credits.js';
import { creditStatus, reserveCredits, commitCredits } from './aiCredits.js';
import { NEW_TITLE_AI_CREDITS } from '../config/aiPlans.js';

export const NEW_TITLE_PRICE_USD = 1;

/** 'wallet' | 'ai_credits' | null: how the fee would be paid right now. */
export async function newTitlePayment(userId) {
  if (await hasCredits(userId, NEW_TITLE_PRICE_USD)) return 'wallet';
  const status = await creditStatus(userId);
  return status.remaining >= NEW_TITLE_AI_CREDITS ? 'ai_credits' : null;
}

/**
 * Takes the fee. Returns 'wallet' or 'ai_credits' when paid, null when the
 * user can cover it neither way (nothing is charged then).
 */
export async function payNewTitle(req, userId, description, requestId = null) {
  if (await hasCredits(userId, NEW_TITLE_PRICE_USD)) {
    const charged = await chargeCredits(req, NEW_TITLE_PRICE_USD, description).catch((err) => {
      console.error('[title fee] wallet charge failed:', err.message);
      return false;
    });
    if (charged) return 'wallet';
  }
  const status = await creditStatus(userId);
  if (status.remaining < NEW_TITLE_AI_CREDITS) return null;
  const reservation = await reserveCredits(userId, status.plan, NEW_TITLE_AI_CREDITS, `title:${requestId || crypto.randomUUID()}`, 5);
  if (!reservation) return null;
  await commitCredits(userId, reservation);
  return 'ai_credits';
}

export const newTitleFeeText = () => `$${NEW_TITLE_PRICE_USD.toFixed(2)} in credits or ${NEW_TITLE_AI_CREDITS} AI credits`;

export const NEW_TITLE_FEE_VIEW = { new_title_price_usd: NEW_TITLE_PRICE_USD, new_title_ai_credits: NEW_TITLE_AI_CREDITS };
