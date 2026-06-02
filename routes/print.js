const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');

const router = express.Router();

let escposAvailable = false;
let Printer, USB, Image;

// Try to load escpos modules gracefully
try {
  const core = require('@node-escpos/core');
  const usbAdapter = require('@node-escpos/usb-adapter');
  Printer = core.Printer;
  Image = core.Image;
  USB = usbAdapter.default || usbAdapter.USB || usbAdapter;
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
        const printer = new Printer(device);
        const line32 = '================================';
        const line32dash = '--------------------------------';

        printer.align('ct');
        printer.text(line32);
        printer.text(`PIZZIA          ${formatTimestamp(order.timestamp)}`);
        printer.text(line32);
        printer.size(1, 1);
        printer.text(`COMMANDE #${order.id}`);
        printer.size(0, 0);
        printer.align('lt');
        printer.text(`CLIENT : ${order.client}`);

        if (order.buzzer) {
          printer.size(1, 1);
          printer.text(`BIPEUR : ${order.buzzer}`);
          printer.size(0, 0);
        }

        printer.text(line32dash);
        for (const pizza of order.pizzas) printer.text(pizza);
        printer.text(line32dash);

        if (order.comment) printer.text(`NOTE : ${order.comment}`);

        printer.text(line32);
        printer.cut();

        await new Promise((res, rej) => printer.close((e) => e ? rej(e) : res()));

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

// Path to the logo image — operator can replace this file
const LOGO_PATH = path.join(__dirname, '..', 'public', 'logo.png');

async function printStartup() {
  if (!escposAvailable) {
    console.log('[startup] Printing disabled (escpos unavailable)');
    return;
  }

  return new Promise((resolve) => {
    let device;
    try {
      device = new USB();
    } catch (e) {
      console.warn('[startup] USB printer not found:', e.message);
      return resolve();
    }

    try {
      device.open(async (err) => {
        if (err) {
          console.warn('[startup] Printer open error:', err.message);
          return resolve();
        }

      try {
        const printer = new Printer(device);
        const line = '================================';
        const now = new Date().toLocaleString('fr-FR', { hour12: false });

        printer.align('ct');

        // Print logo if file exists
        if (fs.existsSync(LOGO_PATH)) {
          try {
            const img = await Image.load(LOGO_PATH);
            await printer.image(img, 'd24');
          } catch (imgErr) {
            console.warn('[startup] Image skipped:', imgErr.message);
            printer.size(1, 1).text('PIZZIA').size(0, 0);
          }
        } else {
          printer.size(1, 1).text('PIZZIA').size(0, 0);
        }

        printer.align('ct');
        printer.text(line);
        printer.text(`Demarrage : ${now}`);
        printer.text('Imprimante operationnelle');
        printer.text(line);
        printer.feed(2);
        printer.cut();

        await new Promise((res, rej) => printer.close((e) => e ? rej(e) : res()));

        console.log('[startup] Ticket imprime avec succes');
        resolve();
      } catch (e) {
        console.warn('[startup] Erreur impression:', e.message);
        try { device.close(); } catch {}
        resolve();
      }
    });
    } catch (e) {
      console.warn('[startup] Erreur ouverture USB:', e.message);
      resolve();
    }
  });
}

module.exports = { router, printOrder, printStartup };
