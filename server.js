const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config.json');

const { router: authRouter } = require('./routes/auth');
const ordersRouter = require('./routes/orders');
const { router: printRouter } = require('./routes/print');

const app = express();

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  secret: 'pizzia-secret-' + Math.random().toString(36),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24h
}));

// Routes
app.use('/auth', authRouter);
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/pin.html'));
});
app.get('/config-pizzas', (req, res) => {
  res.json(config.pizzas || []);
});
app.use('/events', ordersRouter);
app.use('/orders', ordersRouter);
app.use('/order', ordersRouter);
app.use('/print', printRouter);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Root redirect
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = config.port || 3000;
app.listen(port, () => {
  console.log(`PIZZIA running on port ${port}`);
});
