const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
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
    secure: fs.existsSync(path.join(__dirname, 'certs', 'cert.pem')),
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

const port      = config.port      || 3000;
const httpPort  = config.httpPort  || 80;

const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath  = path.join(__dirname, 'certs', 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  // HTTPS
  const credentials = {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath)
  };
  https.createServer(credentials, app).listen(port, () => {
    console.log(`PIZZIA running on https://pizza.local:${port}`);
    printStartup();
  });

  // Redirect HTTP → HTTPS
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host?.replace(/:\d+/, '')}:${port}${req.url}` });
    res.end();
  }).listen(httpPort, () => {
    console.log(`HTTP redirect listening on port ${httpPort}`);
  });
} else {
  // Fallback HTTP si pas de certificat
  console.warn('Certificats introuvables dans certs/ — démarrage en HTTP');
  app.listen(port, () => {
    console.log(`PIZZIA running on http://pizza.local:${port}`);
    printStartup();
  });
}
