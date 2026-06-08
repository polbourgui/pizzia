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
  // CP850 / code page 2 = Western European, fiable sur TM-m30 pour tous les accents français
  const p = new Printer(device, { encoding: 'CP850', width: PRINTER_WIDTH });
  p.raw(Buffer.from([0x1B, 0x74, 2])); // ESC t 2 = PC850
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

// TM-m30 : papier 80mm, zone imprimable 576 dots = 72 bytes par ligne raster
const DOTS_PER_LINE = 72;
const DOTS_PER_CHAR = 12; // largeur d'un char à taille ×1

// Barre noire pleine via GS v 0 (raster bitmap)
function solidBar(heightDots = 4) {
  const w = DOTS_PER_LINE;
  const header = Buffer.from([0x1D, 0x76, 0x30, 0x00,
    w & 0xFF, (w >> 8) & 0xFF,
    heightDots & 0xFF, (heightDots >> 8) & 0xFF]);
  return Buffer.concat([header, Buffer.alloc(w * heightDots, 0xFF)]);
}

// Barre en tirets (alternance 6px noir / 4px blanc) via GS v 0
function dashedBar(heightDots = 3) {
  const w = DOTS_PER_LINE;
  const row = Buffer.alloc(w);
  for (let i = 0; i < w; i++) row[i] = (Math.floor(i / 5) % 2 === 0) ? 0xF8 : 0x00;
  const header = Buffer.from([0x1D, 0x76, 0x30, 0x00,
    w & 0xFF, (w >> 8) & 0xFF,
    heightDots & 0xFF, (heightDots >> 8) & 0xFF]);
  const data = Buffer.concat(Array(heightDots).fill(row));
  return Buffer.concat([header, data]);
}

// Imprime "client" à gauche (normal) et le numéro de bipeur à droite (×3)
// sur la même zone via positionnement absolu ESC $
function printClientBuzzer(printer, client, buzzer) {
  if (!buzzer) {
    // Pas de bipeur : client seul en ×3
    printer.raw(GS_3X);
    printer.text(client || '');
    printer.raw(GS_RESET);
    return;
  }

  const buzzerStr = 'Bip ' + String(buzzer);
  // Largeur de buzzerStr en dots à taille ×3 : chaque char = 12*3 = 36 dots
  const buzzerDots = buzzerStr.length * DOTS_PER_CHAR * 3;
  const buzzerPos  = 576 - buzzerDots;

  // Client en ×3, aligné à gauche
  if (client) {
    printer.raw(GS_3X);
    printer.pureText(client);
    printer.raw(GS_RESET);
  }

  // Positionnement absolu vers la droite, bipeur en ×3
  printer.raw(Buffer.from([
    0x1B, 0x24,
    buzzerPos & 0xFF, (buzzerPos >> 8) & 0xFF
  ]));
  printer.raw(GS_3X);
  printer.pureText(buzzerStr);
  printer.raw(GS_RESET);

  // Saut de ligne (hauteur ×3 occupe 3 lignes)
  printer.raw(Buffer.from([0x0A]));
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
        const printer = makePrinter(device);
        const heure = formatTime(order.timestamp);
        const grouped      = groupPizzas(order.pizzas || []);
        const groupedTapas = groupPizzas(order.tapas  || []);

        // ── En-tête : #id à gauche, heure à droite (normal) ──
        printer.align('lt');
        printer.text(twoCol(`#${order.id}`, heure));
        printer.raw(solidBar(5));

        // ── Client (gauche) + bipeur (droite, ×3) ─────────
        printer.align('lt');
        printClientBuzzer(printer, order.client, order.buzzer);
        printer.raw(solidBar(5));

        // ── Pizzas (×2 hauteur) ────────────────────────────
        printer.feed(1);
        printer.align('lt');
        for (const { name, qty } of grouped) {
          printer.raw(ESC_DBL_HEIGHT);
          printer.text(`${qty}x  ${name}`);
        }
        printer.raw(ESC_RESET);

        // ── Tapas (×2 hauteur, si présentes) ──────────────
        if (groupedTapas.length > 0) {
          printer.raw(ESC_RESET);
          printer.raw(dashedBar(3));
          for (const { name, qty } of groupedTapas) {
            printer.raw(ESC_DBL_HEIGHT);
            printer.text(`${qty}x  ${name}`);
          }
          printer.raw(ESC_RESET);
        }

        printer.feed(1);
        printer.raw(solidBar(5));

        // ── Commentaire ────────────────────────────────────
        if (order.comment) {
          printer.feed(1);
          printer.text(`Note : ${order.comment}`);
        }

        printer.feed(4);
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
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx !== -1) {
      data.orders[idx].printOk = true;
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }
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

async function printNetworkError() {
  if (!escposAvailable) return;

  return new Promise((resolve) => {
    let device;
    try { device = new USB(); } catch { return resolve(); }

    try {
      device.open(async (err) => {
        if (err) return resolve();
        try {
          const printer = makePrinter(device);
          const now = new Date().toLocaleString('fr-FR', { hour12: false });
          printer.align('ct');
          printer.raw(solidBar(5));
          printer.feed(1);
          printer.raw(ESC_DBL);
          printer.text('RESEAU PERDU');
          printer.raw(ESC_RESET);
          printer.feed(1);
          printer.text(now);
          printer.feed(1);
          printer.raw(solidBar(5));
          printer.feed(3);
          printer.cut();
          await new Promise((res, rej) => printer.close((e) => e ? rej(e) : res()));
        } catch (e) {
          console.warn('[network] Erreur impression:', e.message);
          try { device.close(); } catch {}
        }
        resolve();
      });
    } catch (e) {
      console.warn('[network] Erreur USB:', e.message);
      resolve();
    }
  });
}

module.exports = { router, printOrder, printStartup, printNetworkError };
