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

function formatTime(ts) {
  return ts.slice(11, 16); // "HH:MM"
}

// Regroupe les doublons : ["A","A","B"] → [{name:"A",qty:2},{name:"B",qty:1}]
function groupPizzas(pizzas) {
  const map = new Map();
  for (const p of pizzas) map.set(p, (map.get(p) || 0) + 1);
  return Array.from(map.entries()).map(([name, qty]) => ({ name, qty }));
}

const PRINTER_WIDTH = 48; // caractères par ligne à taille normale

// Crée un printer avec le bon encodage pour les caractères latins/français.
// setCharacterCodeTable() de la lib a un bug (envoie ESC+0x09 au lieu de ESC+t),
// donc on envoie la commande ESC t manuellement via raw().
// Code page 39 = ISO-8859-1 sur Epson TM-m30.
function makePrinter(device) {
  const p = new Printer(device, { encoding: 'ISO-8859-1', width: PRINTER_WIDTH });
  p.raw(Buffer.from([0x1B, 0x74, 39])); // ESC t 39 = ISO-8859-1
  return p;
}

// Aligne deux colonnes sur la largeur du ticket (taille normale = 48 chars)
function twoCol(left, right, width = PRINTER_WIDTH) {
  const l = String(left);
  const r = String(right);
  const gap = Math.max(1, width - l.length - r.length);
  return l + ' '.repeat(gap) + r;
}

// size() de la lib utilise ESC ! qui ne supporte que ×2.
// On envoie les commandes ESC/POS directement via raw().
const ESC_RESET      = Buffer.from([0x1B, 0x21, 0x00]); // taille normale
const ESC_DBL        = Buffer.from([0x1B, 0x21, 0x30]); // ×2 hauteur + ×2 largeur
const ESC_DBL_HEIGHT = Buffer.from([0x1B, 0x21, 0x10]); // ×2 hauteur seule
const GS_3X          = Buffer.from([0x1D, 0x21, 0x22]); // ×3 hauteur + ×3 largeur
const GS_RESET       = Buffer.from([0x1D, 0x21, 0x00]); // reset GS !

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
        const printer = makePrinter(device);
        const SEP  = '================================';
        const DASH = '--------------------------------';
        const heure = formatTime(order.timestamp);
        const grouped = groupPizzas(order.pizzas);

        // ── En-tête : #id à gauche, heure à droite ───
        printer.align('lt');
        printer.raw(ESC_DBL);
        printer.text(twoCol(`#${order.id}`, heure, 24)); // ×2 largeur = 24 chars
        printer.raw(ESC_RESET);
        printer.text(SEP);

        // ── Client + bipeur sur la même ligne ─────────
        const clientStr = order.client || '';
        const buzzerStr = order.buzzer ? `BIPEUR : ${order.buzzer}` : '';
        if (clientStr || buzzerStr) {
          printer.align('lt');
          printer.text(twoCol(clientStr, buzzerStr));
        }

        printer.text(SEP);

        // ── Bipeur en très grand (GS ! ×3) ────────────
        if (order.buzzer) {
          printer.align('ct');
          printer.feed(1);
          printer.raw(GS_3X);
          printer.text(String(order.buzzer));
          printer.raw(GS_RESET);
          printer.feed(1);
          printer.text(SEP);
        }

        // ── Pizzas (ESC ! ×2 hauteur + largeur) ───────
        printer.align('lt');
        printer.feed(1);
        for (const { name, qty } of grouped) {
          printer.raw(ESC_DBL_HEIGHT);
          printer.text(`${qty}x  ${name}`);
        }
        printer.raw(ESC_RESET);
        printer.feed(1);
        printer.text(DASH);

        // ── Commentaire ────────────────────────────────
        if (order.comment) printer.text(`Note : ${order.comment}`);

        printer.text(SEP);
        printer.feed(2);
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
        const printer = makePrinter(device);
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
