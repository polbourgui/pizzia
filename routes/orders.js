const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');
const { printOrder } = require('./print');

const router = express.Router();

// SSE clients
const sseClients = new Set();

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

// GET /events — SSE (no auth required)
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current orders immediately
  const data = loadOrders();
  res.write(`data: ${JSON.stringify(data.orders)}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// GET /orders — return today's orders (auth required)
router.get('/', requireAuth, (req, res) => {
  const data = loadOrders();
  res.json(data.orders);
});

// POST /order — create order (auth required)
router.post('/', requireAuth, async (req, res) => {
  const { client, buzzer, pizzas, comment } = req.body;

  if (!client || !pizzas || !Array.isArray(pizzas) || pizzas.length === 0) {
    return res.status(400).json({ error: 'client and at least one pizza required' });
  }

  const data = loadOrders();
  const nextId = data.orders.length > 0
    ? Math.max(...data.orders.map(o => o.id)) + 1
    : 1;

  const order = {
    id: nextId,
    timestamp: new Date().toISOString().slice(0, 19),
    client: String(client).trim(),
    buzzer: buzzer ? Number(buzzer) : null,
    pizzas: pizzas.map(p => String(p).trim()),
    comment: comment ? String(comment).trim() : ''
  };

  data.orders.push(order);
  saveOrders(data);
  broadcastOrders(data);

  // Trigger print asynchronously (don't block response)
  printOrder(order).catch(() => {});

  res.status(201).json(order);
});

module.exports = router;
