const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');
const { printOrder } = require('./print');
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
    } catch {
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

// POST /order — créer une commande (auth requise)
router.post('/order', requireAuth, async (req, res) => {
  const { client, buzzer, pizzas = [], tapas = [], comment } = req.body;

  if (!client && !buzzer) {
    return res.status(400).json({ error: 'Nom ou numéro de bipeur requis' });
  }
  if ((!Array.isArray(pizzas) || pizzas.length === 0) &&
      (!Array.isArray(tapas)  || tapas.length === 0)) {
    return res.status(400).json({ error: 'Au moins un article requis' });
  }

  const MAX_CLIENT = 60, MAX_COMMENT = 300;
  const allowedPizzas = new Set(config.pizzas);
  const allowedTapas  = new Set(config.tapas);

  if (client && String(client).length > MAX_CLIENT) return res.status(400).json({ error: 'Nom trop long' });
  if (comment && String(comment).length > MAX_COMMENT) return res.status(400).json({ error: 'Commentaire trop long' });
  if (pizzas.length && !pizzas.every(p => allowedPizzas.has(p))) return res.status(400).json({ error: 'Pizza invalide' });
  if (tapas.length  && !tapas.every(t => allowedTapas.has(t)))   return res.status(400).json({ error: 'Tapa invalide' });

  const data = loadOrders();
  const nextId = data.orders.length > 0
    ? Math.max(...data.orders.map(o => o.id)) + 1
    : 1;

  const order = {
    id: nextId,
    timestamp: new Date().toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 19),
    client: client ? String(client).trim() : '',
    buzzer: buzzer ? Number(buzzer) : null,
    pizzas: pizzas.map(p => String(p).trim()),
    tapas:  tapas.map(t => String(t).trim()),
    comment: comment ? String(comment).trim() : ''
  };

  data.orders.push(order);
  saveOrders(data);
  broadcastOrders(data);

  printOrder(order).catch(() => {});

  res.status(201).json(order);
});

module.exports = router;
