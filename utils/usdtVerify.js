// On-chain verification of USDT payments to the marketplace wallets.
//
// The receiving addresses are shared with One Dream, so a transfer is only
// accepted for a payment when ALL of these hold:
//   1. the token is real USDT (checked by contract address, not by the
//      transfer() call shape, so look-alike tokens are rejected),
//   2. it was sent to our address on that network,
//   3. it came from the sender address the payer declared before paying,
//   4. it is for at least the payment's exact amount (each payment carries a
//      unique sub-cent tag),
//   5. it happened after the payment was created,
//   6. it is final: TRON reads from the solidified node (irreversible); BSC
//      needs BSC_MIN_CONFIRMATIONS blocks.
// The transaction hash is also unique per network in the database, so it can
// never be credited twice.
//
// No blockchain SDKs: plain JSON-RPC (BSC) and TronGrid HTTP (TRON).
import crypto from 'crypto';

const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955'; // Binance-Peg USDT, 18 decimals
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';        // USDT TRC-20, 6 decimals
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BSC_MIN_CONFIRMATIONS = 15;
// Public fallbacks, tried in order after BSC_RPC_URL.
const PUBLIC_BSC_RPCS = ['https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com'];
const CLOCK_SKEW_MS = 120_000;

export const USDT_NETWORKS = {
  tron: { label: 'USDT (TRC-20, Tron)', address: () => process.env.CRYPTO_WALLET_ADDRESS_TRON },
  bsc: { label: 'USDT (BEP-20, BNB Smart Chain)', address: () => process.env.CRYPTO_WALLET_ADDRESS_BSC },
};

// ── TRON base58check ────────────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

export function tronToHex(address) {
  let n = 0n;
  for (const ch of String(address)) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('Invalid TRON address');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== 25 || bytes[0] !== 0x41) throw new Error('Invalid TRON address');
  const body = bytes.subarray(0, 21);
  const check = sha256(sha256(body)).subarray(0, 4);
  if (!check.equals(bytes.subarray(21))) throw new Error('Invalid TRON address checksum');
  return body.toString('hex'); // 41 + 20 bytes
}

export function hexToTron(hex41) {
  const body = Buffer.from(hex41, 'hex');
  const full = Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]);
  let n = BigInt('0x' + full.toString('hex'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}

export function isValidUsdtAddress(network, address) {
  if (network === 'bsc') return /^0x[0-9a-fA-F]{40}$/.test(String(address || ''));
  if (network === 'tron') { try { tronToHex(address); return true; } catch { return false; } }
  return false;
}

const units = (hexValue, decimals) => {
  const v = BigInt('0x' + (String(hexValue).replace(/^0x/, '') || '0'));
  const base = 10n ** BigInt(decimals);
  // 6 decimal places is plenty for USDT amounts and the 4-decimal payment tag.
  return Number(v / base) + Number((v % base) * 1_000_000n / base) / 1_000_000;
};

// ── TRON ───────────────────────────────────────────────────────────────────
async function tronInfo(txHash) {
  const api = process.env.TRON_GRID_API || 'https://api.trongrid.io';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.TRON_PRO_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_PRO_API_KEY;
  // walletsolidity only knows solidified (irreversible) transactions.
  const res = await fetch(`${api}/walletsolidity/gettransactioninfobyid`, {
    method: 'POST', headers, body: JSON.stringify({ value: txHash }),
  });
  if (!res.ok) throw new Error(`TronGrid ${res.status}`);
  return res.json();
}

async function verifyTron(txHash) {
  const info = await tronInfo(txHash);
  if (!info || !info.id) return { pending: true, error: 'Transaction not final on TRON yet. Try again in a minute.' };
  if (info.receipt?.result && info.receipt.result !== 'SUCCESS') return { error: 'Transaction failed on TRON' };
  const usdtHex = tronToHex(TRON_USDT).slice(2);
  const transfers = (info.log || [])
    .filter((l) => String(l.address).toLowerCase() === usdtHex && l.topics?.[0] === TRANSFER_TOPIC)
    .map((l) => ({
      from: hexToTron('41' + l.topics[1].slice(-40)),
      to: hexToTron('41' + l.topics[2].slice(-40)),
      amount: units(l.data, 6),
    }));
  return { transfers, timestamp: Number(info.blockTimeStamp) };
}

// ── BSC ────────────────────────────────────────────────────────────────────
async function bscCall(rpc, method, params) {
  const res = await fetch(rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`BSC RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'BSC RPC error');
  return body.result;
}

async function verifyBsc(txHash) {
  const rpcs = [...new Set([process.env.BSC_RPC_URL, ...PUBLIC_BSC_RPCS].filter(Boolean))];
  let lastErr;
  for (const rpc of rpcs) {
    try {
      const receipt = await bscCall(rpc, 'eth_getTransactionReceipt', [txHash]);
      if (!receipt) return { pending: true, error: 'Transaction not found on BSC yet. Try again in a minute.' };
      if (receipt.status !== '0x1') return { error: 'Transaction failed on BSC' };
      const head = parseInt(await bscCall(rpc, 'eth_blockNumber', []), 16);
      const blockNo = parseInt(receipt.blockNumber, 16);
      if (head - blockNo < BSC_MIN_CONFIRMATIONS) {
        return { pending: true, error: `Waiting for confirmations (${head - blockNo}/${BSC_MIN_CONFIRMATIONS})` };
      }
      const block = await bscCall(rpc, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
      const transfers = (receipt.logs || [])
        .filter((l) => String(l.address).toLowerCase() === BSC_USDT && l.topics?.[0]?.replace(/^0x/, '') === TRANSFER_TOPIC)
        .map((l) => ({
          from: '0x' + l.topics[1].slice(-40),
          to: '0x' + l.topics[2].slice(-40),
          amount: units(l.data, 18),
        }));
      return { transfers, timestamp: parseInt(block.timestamp, 16) * 1000 };
    } catch (err) {
      lastErr = err;
    }
  }
  console.error('[usdt] BSC RPC failed:', lastErr?.message);
  return { pending: true, error: 'Could not reach BNB Smart Chain. Try again shortly.' };
}

/**
 * Checks txHash against one pending market_payments row.
 * Returns { ok: true, amount, sender } or { ok: false, pending?, error }.
 */
export async function verifyUsdtForPayment(payment, network, txHash) {
  const hash = String(txHash || '').trim();
  if (network === 'tron' && !/^[0-9a-fA-F]{64}$/.test(hash)) return { ok: false, error: 'That is not a TRON transaction hash' };
  if (network === 'bsc' && !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { ok: false, error: 'That is not a BSC transaction hash' };
  const ours = USDT_NETWORKS[network]?.address();
  if (!ours) return { ok: false, error: 'USDT payments are not set up for this network' };
  const declared = payment.purpose?.sender;
  if (!declared) return { ok: false, error: 'This payment has no sender address' };

  const result = network === 'tron' ? await verifyTron(hash) : await verifyBsc(hash);
  if (result.error) return { ok: false, pending: !!result.pending, error: result.error };

  const same = (a, b) => (network === 'bsc' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const matching = result.transfers.filter((t) => same(t.to, ours) && same(t.from, declared));
  if (!matching.length) {
    return { ok: false, error: 'This transaction is not a USDT transfer from your declared address to the marketplace wallet' };
  }
  if (result.timestamp < new Date(payment.created_at).getTime() - CLOCK_SKEW_MS) {
    return { ok: false, error: 'This transaction was sent before the payment was started' };
  }
  const amount = matching.reduce((s, t) => s + t.amount, 0);
  if (amount + 1e-9 < Number(payment.amount_due)) {
    return { ok: false, error: `Received ${amount} USDT, but ${payment.amount_due} USDT is due` };
  }
  return { ok: true, amount, sender: declared, hash: network === 'bsc' ? hash.toLowerCase() : hash.toLowerCase() };
}
