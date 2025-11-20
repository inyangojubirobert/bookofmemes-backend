import express from 'express';
import WalletTransaction from '../models/walletTransaction.js';
const router = express.Router();

// Get all wallet transactions
router.get('/', async (req, res) => {
  try {
    const transactions = await WalletTransaction.findAll();
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single wallet transaction by id
router.get('/:id', async (req, res) => {
  try {
    const transaction = await WalletTransaction.findByPk(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Not found' });
    res.json(transaction);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new wallet transaction
router.post('/', async (req, res) => {
  try {
    const transaction = await WalletTransaction.create(req.body);
    res.status(201).json(transaction);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update a wallet transaction
router.put('/:id', async (req, res) => {
  try {
    const [updated] = await WalletTransaction.update(req.body, {
      where: { id: req.params.id },
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    const updatedTransaction = await WalletTransaction.findByPk(req.params.id);
    res.json(updatedTransaction);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a wallet transaction
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await WalletTransaction.destroy({ where: { id: req.params.id } });
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
