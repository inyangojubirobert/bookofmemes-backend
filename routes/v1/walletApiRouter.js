/**
 * Bascardo Wallet Public API — v1
 *
 * Auth: X-API-Key header (required for all routes)
 *       Authorization: Bearer <supabase_jwt>  OR  X-User-Id: <uuid>  (required for user-scoped routes)
 *
 * All routes here are versioned and stable. Mount at /v1/wallet in server.js.
 */

import { Router } from "express";
import { supabase } from "../../config/db.js";
import { apiKeyAuth, requireUser, requirePermission } from "../../middleware/apiKeyAuth.js";

const router = Router();

// All routes require a valid API key
router.use(apiKeyAuth);

// ─── Health ────────────────────────────────────────────────────────────────
router.get("/health", (req, res) => {
  res.json({ status: "ok", app: req.apiApp.app_name, version: "v1" });
});

// ─── Wallet Info ───────────────────────────────────────────────────────────
// GET /v1/wallet/:walletId  — public wallet lookup (no user required)
router.get("/:walletId", requirePermission("read"), async (req, res) => {
  const { walletId } = req.params;
  const { data, error } = await supabase
    .from("wallets")
    .select("id, user_id, wallet_balance, token_balance, created_at")
    .eq("id", walletId)
    .single();
  if (error || !data) return res.status(404).json({ error: "Wallet not found" });
  res.json(data);
});

// GET /v1/wallet/me/balance  — get calling user's wallet
router.get("/me/balance", requireUser, requirePermission("read"), async (req, res) => {
  const { data, error } = await supabase
    .from("wallets")
    .select("id, wallet_balance, token_balance")
    .eq("user_id", req.user.id)
    .single();
  if (error || !data) return res.status(404).json({ error: "Wallet not found" });
  res.json(data);
});

// GET /v1/wallet/me/currencies  — multi-currency balances
router.get("/me/currencies", requireUser, requirePermission("read"), async (req, res) => {
  const { data: wallet } = await supabase.from("wallets").select("id").eq("user_id", req.user.id).single();
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });

  const { data, error } = await supabase
    .from("wallet_currencies")
    .select("currency_code, balance, is_primary")
    .eq("wallet_id", wallet.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /v1/wallet/me/transactions  — transaction history
router.get("/me/transactions", requireUser, requirePermission("read"), async (req, res) => {
  const { type, limit = 20, offset = 0 } = req.query;
  const { data: wallet } = await supabase.from("wallets").select("id").eq("user_id", req.user.id).single();
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });

  let query = supabase
    .from("wallet_transactions")
    .select("id, type, amount, description, status, metadata, created_at")
    .eq("wallet_id", wallet.id)
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (type) query = query.eq("type", type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ─── Transfers ─────────────────────────────────────────────────────────────
// POST /v1/wallet/me/transfer  — send money to another wallet
router.post("/me/transfer", requireUser, requirePermission("transfer"), async (req, res) => {
  const { to_wallet_id, amount, currency = "USD", note } = req.body;

  if (!to_wallet_id || !amount || amount <= 0) {
    return res.status(400).json({ error: "to_wallet_id and a positive amount are required" });
  }

  const { data: senderWallet } = await supabase.from("wallets").select("id, wallet_balance").eq("user_id", req.user.id).single();
  if (!senderWallet) return res.status(404).json({ error: "Sender wallet not found" });
  if (senderWallet.wallet_balance < amount) return res.status(400).json({ error: "Insufficient balance" });

  const { data: recipientWallet } = await supabase.from("wallets").select("id").eq("id", to_wallet_id).single();
  if (!recipientWallet) return res.status(404).json({ error: "Recipient wallet not found" });

  const reference = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // Debit sender
  await supabase.from("wallets").update({ wallet_balance: senderWallet.wallet_balance - amount }).eq("id", senderWallet.id);

  // Credit recipient. wallet_balance (USD) is the one spendable ledger every
  // financial feature (marketplace, cashout, token purchases) actually reads --
  // crediting non-USD currencies into wallet_currencies used to also happen for
  // "USD" here (the default), which silently moved money OUT of the ledger the
  // sender was just debited from and into one nothing else spends from. Fixed
  // for USD; non-USD still goes to wallet_currencies since there's no live
  // exchange rate data to convert it correctly (Backend/migrations/035).
  if (currency === "USD") {
    const { data: recipientRow } = await supabase.from("wallets").select("wallet_balance").eq("id", recipientWallet.id).single();
    await supabase.from("wallets").update({ wallet_balance: Number(recipientRow?.wallet_balance || 0) + amount }).eq("id", recipientWallet.id);
  } else {
    const { error: creditError } = await supabase.rpc("credit_wallet_currency", { p_wallet_id: recipientWallet.id, p_currency: currency, p_amount: amount });
    if (creditError) {
      console.error('credit_wallet_currency error:', creditError.message);
      // Sender was already debited above -- refund before reporting failure,
      // rather than leaving the sender's balance gone with nothing credited
      // anywhere.
      await supabase.from("wallets").update({ wallet_balance: senderWallet.wallet_balance }).eq("id", senderWallet.id);
      return res.status(500).json({ error: "Transfer failed -- recipient credit could not be applied. Your balance has been restored." });
    }
  }

  // Log transfer record
  const { data: transfer } = await supabase.from("p2p_transfers").insert([{
    sender_wallet_id: senderWallet.id,
    receiver_wallet_id: recipientWallet.id,
    amount,
    currency,
    reference,
    status: "completed",
    metadata: { note, initiated_by_app: req.apiApp.app_name },
  }]).select().single();

  // Log transactions for both wallets
  await supabase.from("wallet_transactions").insert([
    { wallet_id: senderWallet.id,    currency_code: currency, type: "money_transfer", amount: -amount, description: note || "Transfer sent",     status: "completed", metadata: { reference, direction: "out" } },
    { wallet_id: recipientWallet.id, currency_code: currency, type: "money_transfer", amount,          description: note || "Transfer received", status: "completed", metadata: { reference, direction: "in" } },
  ]);

  res.json({ success: true, reference, transfer_id: transfer?.id });
});

// ─── Deposits ──────────────────────────────────────────────────────────────
// POST /v1/wallet/me/deposit/initialize  — start a Paystack deposit
router.post("/me/deposit/initialize", requireUser, requirePermission("deposit"), async (req, res) => {
  const { amount, currency = "NGN", email } = req.body;
  if (!amount || amount <= 0 || !email) return res.status(400).json({ error: "amount and email are required" });

  const { data: wallet } = await supabase.from("wallets").select("id").eq("user_id", req.user.id).single();
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });

  const reference = `DEP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amount * 100, email, reference, currency }),
  });
  const paystack = await paystackRes.json();
  if (!paystack.status) return res.status(500).json({ error: "Payment gateway error" });

  await supabase.from("deposits").insert([{
    user_id: req.user.id, wallet_id: wallet.id, amount, currency, method: "paystack", reference, status: "pending",
    metadata: { initiated_by_app: req.apiApp.app_name },
  }]);

  res.json({ authorization_url: paystack.data.authorization_url, reference, access_code: paystack.data.access_code });
});

// ─── Cashout ───────────────────────────────────────────────────────────────
// POST /v1/wallet/me/cashout  — request a cashout
router.post("/me/cashout", requireUser, requirePermission("cashout"), async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 100) return res.status(400).json({ error: "Minimum cashout amount is 100" });

  const { data: wallet } = await supabase.from("wallets").select("id, wallet_balance").eq("user_id", req.user.id).single();
  if (!wallet || wallet.wallet_balance < amount) return res.status(400).json({ error: "Insufficient balance" });

  const { data: bankDetails } = await supabase.from("bank_details").select("id").eq("user_id", req.user.id).single();
  if (!bankDetails) return res.status(400).json({ error: "No bank details on file. Add bank account first." });

  const reference = `CSH-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const { data: cashout } = await supabase.from("cashout_requests").insert([{
    user_id: req.user.id, wallet_id: wallet.id, amount,
    bank_details_id: bankDetails.id, reference, status: "pending",
    metadata: { initiated_by_app: req.apiApp.app_name },
  }]).select().single();

  res.json({ success: true, reference, cashout_id: cashout?.id, status: "pending" });
});

// ─── Token Purchases ───────────────────────────────────────────────────────
// POST /v1/wallet/me/tokens/purchase
router.post("/me/tokens/purchase", requireUser, requirePermission("transfer"), async (req, res) => {
  const PACKAGES = {
    pack_100:  { tokens: 100,  bonus: 0,   price: 1.00 },
    pack_500:  { tokens: 500,  bonus: 0,   price: 4.50 },
    pack_1000: { tokens: 1000, bonus: 50,  price: 8.00 },
    pack_5000: { tokens: 5000, bonus: 500, price: 35.00 },
  };

  const { package_id } = req.body;
  const pkg = PACKAGES[package_id];
  if (!pkg) return res.status(400).json({ error: `Invalid package_id. Choose: ${Object.keys(PACKAGES).join(", ")}` });

  const { data: wallet } = await supabase.from("wallets").select("id, wallet_balance, token_balance").eq("user_id", req.user.id).single();
  if (!wallet || wallet.wallet_balance < pkg.price) return res.status(400).json({ error: "Insufficient balance" });

  const totalTokens = pkg.tokens + pkg.bonus;
  await supabase.from("wallets").update({
    wallet_balance: wallet.wallet_balance - pkg.price,
    token_balance: (wallet.token_balance || 0) + totalTokens,
  }).eq("id", wallet.id);

  await supabase.from("wallet_transactions").insert([{
    wallet_id: wallet.id, type: "token_purchase", amount: pkg.price,
    description: `Purchased ${totalTokens} tokens (${package_id})`,
    status: "completed",
    metadata: { package_id, tokens: totalTokens, initiated_by_app: req.apiApp.app_name },
  }]);

  res.json({ success: true, tokens_added: totalTokens, new_token_balance: (wallet.token_balance || 0) + totalTokens });
});

export default router;
