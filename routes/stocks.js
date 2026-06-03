const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');
const config = require('../config.json');

const router = express.Router();
const STOCKS_FILE = path.join(__dirname, '..', 'data', 'stocks.json');

const ALL_ITEMS = [...(config.pizzas || []), ...(config.tapas || [])];

function loadStocks() {
  if (!fs.existsSync(STOCKS_FILE)) {
    // Par défaut tous les articles sont illimités (null)
    const defaults = {};
    ALL_ITEMS.forEach(item => { defaults[item] = null; });
    fs.writeFileSync(STOCKS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    return JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveStocks(stocks) {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STOCKS_FILE, JSON.stringify(stocks, null, 2));
}

// Déduit les articles commandés du stock (ignore si null = illimité)
function deductStock(pizzas = [], tapas = []) {
  const stocks = loadStocks();
  [...pizzas, ...tapas].forEach(item => {
    if (stocks[item] !== null && stocks[item] !== undefined) {
      stocks[item] = Math.max(0, (stocks[item] || 0) - 1);
    }
  });
  saveStocks(stocks);
}

// GET /stocks — stock courant (auth requise)
router.get('/stocks', requireAuth, (req, res) => {
  res.json(loadStocks());
});

// PUT /stocks — mettre à jour la quantité d'un article (auth requise)
router.put('/stocks', requireAuth, (req, res) => {
  const { item, qty } = req.body;
  if (!item || !ALL_ITEMS.includes(item)) return res.status(400).json({ error: 'Article invalide' });
  const q = qty === null || qty === '' ? null : Number(qty);
  if (q !== null && (isNaN(q) || q < 0)) return res.status(400).json({ error: 'Quantité invalide' });
  const stocks = loadStocks();
  stocks[item] = q;
  saveStocks(stocks);
  res.json({ ok: true, item, qty: q });
});

module.exports = { router, deductStock, loadStocks };
