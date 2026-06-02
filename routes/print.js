const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');

const router = express.Router();

let escposAvailable = false;
let Printer, USB;

// Try to load escpos modules gracefully
try {
  const core = require('@node-escpos/core');
  const usbAdapter = require('@node-escpos/usb-adapter');
  Printer = core.Printer;
  USB = usbAdapter.USB;
  escposAvailable = true;
} catch (e) {
  console.warn('node-escpos not available, printing disabled:', e.message);
}

function pad(str, len) {
  return String(str).padEnd(len).slice(0, len);
}

function formatTimestamp(ts) {
  // ts like "2024-06-02T19:34:00"
  return ts.replace('T', ' ').slice(0, 16);
}

async function printOrder(order) {
  if (!escposAvailable) {
    console.log('Print skipped (no printer):', order);
    return;
  }

  return new Promise((resolve, reject) => {
    let device;
    try {
      device = new USB();
    } catch (e) {
      console.warn('USB printer not found:', e.message);
      return resolve();
    }

    device.open(async (err) => {
      if (err) {
        console.warn('Printer open error:', err.message);
        return resolve();
      }

      try {
        const printer = await Printer.create(device);
        const line32 = '================================';
        const line32dash = '--------------------------------';

        await printer
          .align('ct')
          .text(line32)
          .text(`PIZZIA          ${formatTimestamp(order.timestamp)}`)
          .text(line32)
          .size(1, 1) // double height for order number
          .text(`COMMANDE #${order.id}`)
          .size(0, 0)
          .align('lt')
          .text(`CLIENT : ${order.client}`);

        if (order.buzzer) {
          await printer
            .size(1, 1)
            .text(`BIPEUR : ${order.buzzer}`)
            .size(0, 0);
        }

        await printer.text(line32dash);

        for (const pizza of order.pizzas) {
          await printer.text(pizza);
        }

        await printer.text(line32dash);

        if (order.comment) {
          await printer.text(`NOTE : ${order.comment}`);
        }

        await printer
          .text(line32)
          .cut()
          .close();

        resolve();
      } catch (e) {
        console.warn('Print error:', e.message);
        try { device.close(); } catch {}
        resolve();
      }
    });
  });
}

// GET /health — printer status (no auth required)
router.get('/health', (req, res) => {
  if (!escposAvailable) {
    return res.json({ connected: false, reason: 'escpos module not available' });
  }

  let connected = false;
  try {
    const device = new USB();
    // If constructor doesn't throw, assume connected
    connected = true;
  } catch {
    connected = false;
  }

  res.json({ connected });
});

// POST /print/:id — reprint an order (auth required)
router.post('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  // Find the order in today's file
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(__dirname, '..', 'data', `orders-${date}.json`);

  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'No orders today' });
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return res.status(500).json({ error: 'Cannot read orders' });
  }

  const order = data.orders.find(o => o.id === id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  try {
    await printOrder(order);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, printOrder };
