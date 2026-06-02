const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config.json');

const router = express.Router();

// POST /auth
router.post('/', async (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'PIN required' });
  }

  const valid = await bcrypt.compare(String(pin), config.pin);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  req.session.authenticated = true;
  res.json({ ok: true });
});

// GET /logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/pin.html');
  });
});

// Middleware: requireAuth
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  // For HTML page requests, redirect; for API, return 401
  const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
  if (acceptsHtml) {
    return res.redirect('/pin.html');
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { router, requireAuth };
