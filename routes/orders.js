const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');
const { printOrder } = require('./print');
const { deductStock, loadStocks } = require('./stocks');
const config = require('../config.json');

const router = express.Router();

// SSE clients
const sseClients = new Set();
const MAX_SSE_CLIENTS = 20;

function getTodayFile() {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `orders-${date}.json`);
}

function loadOrders() {
  const file = getTodayFile();
  if (!fs.existsSync(file)) return { orders: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { orders: [] };
  }
}

function saveOrders(data) {
  fs.writeFileSync(getTodayFile(), JSON.stringify(data, null, 2));
}

function broadcastOrders(data) {
  const payload = `data: ${JSON.stringify(data.orders)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      console.error('SSE broadcast error:', e.message);
      sseClients.delete(client);
    }
  }
}

// GET /events — SSE temps réel (auth requise)
router.get('/events', requireAuth, (req, res) => {
  if (sseClients.size >= MAX_SSE_CLIENTS) return res.status(503).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const data = loadOrders();
  res.write(`data: ${JSON.stringify(data.orders)}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// GET /orders — commandes du jour (auth requise)
router.get('/orders', requireAuth, (req, res) => {
  const data = loadOrders();
  res.json(data.orders);
});

// GET /stats — historique par journée (auth requise)
router.get('/stats', requireAuth, (req, res) => {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir)
    .filter(f => /^orders-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse();
  const result = files.map(file => {
    const date = file.replace('orders-', '').replace('.json', '');
    let data = { orders: [] };
    try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch {}
    const items = {};
    data.orders.forEach(order => {
      [...(order.pizzas || []), ...(order.tapas || [])].forEach(item => {
        items[item] = (items[item] || 0) + 1;
      });
    });
    return { date, orderCount: data.orders.length, items };
  });
  res.json(result);
});

// POST /order — créer une commande (auth requise)
router.post('/order', requireAuth, async (req, res) => {
  const { client, buzzer, pizzas = [], tapas = [], comment } = req.body;

  const clientTrimmed = client ? String(client).trim() : '';
  if (!clientTrimmed && !buzzer) {
    return res.status(400).json({ error: 'Nom ou numéro de bipeur requis' });
  }
  if ((!Array.isArray(pizzas) || pizzas.length === 0) &&
      (!Array.isArray(tapas)  || tapas.length === 0)) {
    return res.status(400).json({ error: 'Au moins un article requis' });
  }

  const MAX_CLIENT = 60, MAX_COMMENT = 300;
  const allowedPizzas = new Set(config.pizzas);
  const allowedTapas  = new Set(config.tapas);

  if (buzzer && (Number(buzzer) < 1 || Number(buzzer) > 30 || !Number.isInteger(Number(buzzer))))
    return res.status(400).json({ error: 'Numéro de bipeur invalide (1–30)' });
  if (clientTrimmed.length > MAX_CLIENT) return res.status(400).json({ error: 'Nom trop long' });
  if (comment && String(comment).length > MAX_COMMENT) return res.status(400).json({ error: 'Commentaire trop long' });
  if (!pizzas.every(p => typeof p === 'string') || !tapas.every(t => typeof t === 'string'))
    return res.status(400).json({ error: 'Format invalide' });
  if (pizzas.length && !pizzas.every(p => allowedPizzas.has(p))) return res.status(400).json({ error: 'Pizza invalide' });
  if (tapas.length  && !tapas.every(t => allowedTapas.has(t)))   return res.status(400).json({ error: 'Tapa invalide' });

  // Vérifier le stock disponible
  const stocks = loadStocks();
  const allItems = [...pizzas, ...tapas];
  const counts = {};
  allItems.forEach(i => { counts[i] = (counts[i] || 0) + 1; });
  for (const [item, qty] of Object.entries(counts)) {
    const available = stocks[item];
    if (available !== null && available !== undefined && available < qty) {
      return res.status(409).json({ error: `Stock insuffisant : ${item} (${available} restant${available > 1 ? 's' : ''})` });
    }
  }

  const data = loadOrders();
  const nextId = data.orders.length > 0
    ? Math.max(...data.orders.map(o => o.id)) + 1
    : 1;

  const order = {
    id: nextId,
    timestamp: new Date().toISOString().slice(0, 19),
    client: clientTrimmed,
    buzzer: buzzer ? Number(buzzer) : null,
    pizzas: pizzas.map(p => String(p).trim()),
    tapas:  tapas.map(t => String(t).trim()),
    comment: comment ? String(comment).trim() : ''
  };

  data.orders.push(order);
  saveOrders(data);
  deductStock(pizzas, tapas);
  broadcastOrders(data);

  printOrder(order).catch(() => {});

  res.status(201).json(order);
});

module.exports = router;
