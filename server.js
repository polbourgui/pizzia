const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('./config.json');

const { router: authRouter } = require('./routes/auth');
const ordersRouter = require('./routes/orders');
const os = require('os');
const { router: printRouter, printStartup, printNetworkError } = require('./routes/print');

const app = express();

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CSP header
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  next();
});

// Persistent session secret
const secretFile = path.join(__dirname, '.session-secret');
let sessionSecret;
if (fs.existsSync(secretFile)) {
  sessionSecret = fs.readFileSync(secretFile, 'utf8').trim();
} else {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, sessionSecret, { mode: 0o600 });
}

// Session
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000 // 12h
  }
}));

// Rate limit on /auth (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives, réessayez plus tard' }
});

// Routes
app.use('/auth', authLimiter, authRouter);
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/pin.html'));
});
app.get('/config-pizzas', (req, res) => {
  res.json(config.pizzas || []);
});
app.use('/', ordersRouter);
app.use('/print', printRouter);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Root redirect
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Surveillance réseau : imprime un ticket d'erreur à la perte de connexion
function hasNetwork() {
  return Object.values(os.networkInterfaces())
    .flat()
    .some(i => !i.internal && i.family === 'IPv4');
}

let networkWasUp = hasNetwork();
setInterval(() => {
  const up = hasNetwork();
  if (networkWasUp && !up) {
    console.warn('[network] Connexion perdue — impression ticket erreur');
    printNetworkError();
  }
  if (!networkWasUp && up) {
    console.log('[network] Connexion rétablie');
  }
  networkWasUp = up;
}, 15000);

const port = config.port || 3000;
app.listen(port, () => {
  console.log(`PIZZIA running on port ${port}`);
  printStartup();
});
