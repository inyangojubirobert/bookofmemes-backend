/**
 * Bascardo (BASC) on-chain token routes.
 * Reads data from the deployed BEP-20 contract on BSC via ethers.js.
 *
 * Required env vars:
 *   BSC_RPC_URL           — BSC RPC endpoint (default: public mainnet)
 *   TOKEN_CONTRACT_ADDRESS — deployed BascardoToken address
 */
import express from 'express';
import { ethers } from 'ethers';

const router = express.Router();

// Minimal ABI — only the functions we call from the backend
const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function taxBps() view returns (uint256)",
  "function treasury() view returns (address)",
];

function getProvider() {
  const rpc = process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org";
  return new ethers.JsonRpcProvider(rpc);
}

function getContract() {
  const address = process.env.TOKEN_CONTRACT_ADDRESS;
  if (!address) throw new Error("TOKEN_CONTRACT_ADDRESS not set in .env");
  return new ethers.Contract(address, TOKEN_ABI, getProvider());
}

// GET /api/bascardo/info  — token name, symbol, supply, tax
router.get('/info', async (_req, res) => {
  try {
    const contract = getContract();
    const [name, symbol, decimals, totalSupply, taxBps, treasury] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
      contract.totalSupply(),
      contract.taxBps(),
      contract.treasury(),
    ]);

    res.json({
      success: true,
      data: {
        name,
        symbol,
        decimals: Number(decimals),
        totalSupply: ethers.formatUnits(totalSupply, decimals),
        taxPercent: (Number(taxBps) / 100).toFixed(2) + "%",
        treasury,
        contractAddress: process.env.TOKEN_CONTRACT_ADDRESS,
        network: "BSC Mainnet",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bascardo/balance/:walletAddress  — on-chain BASC balance for any wallet
router.get('/balance/:walletAddress', async (req, res) => {
  const { walletAddress } = req.params;

  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({ success: false, error: "Invalid wallet address" });
  }

  try {
    const contract = getContract();
    const [balance, decimals, symbol] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
      contract.symbol(),
    ]);

    res.json({
      success: true,
      data: {
        walletAddress,
        balance: ethers.formatUnits(balance, decimals),
        symbol,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
