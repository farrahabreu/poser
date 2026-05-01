'use strict';

require('dotenv').config();

const http        = require('http');
const path        = require('path');
const express     = require('express');
const cors        = require('cors');
const cookieParser = require('cookie-parser');

const socket      = require('./ws/socket');
const authRouter  = require('./routes/auth');
const usersRouter = require('./routes/users');
const reviewsRouter = require('./routes/reviews');
const commentsRouter = require('./routes/comments');
const notifRouter = require('./routes/notifications');
const msgRouter   = require('./routes/messages');
const modRouter      = require('./routes/moderation');
const trackingRouter = require('./routes/tracking');
const wrappedRouter  = require('./routes/wrapped');

const PORT   = parseInt(process.env.PORT || '3001', 10);
const ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:8080';

const app = express();

app.use(cors({
  origin:      [ORIGIN, 'http://localhost:8080', 'http://127.0.0.1:8080'],
  credentials: true,
  methods:     ['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve uploaded files
const UPLOAD_DIR = path.resolve(__dirname, process.env.UPLOAD_DIR || './uploads');
app.use('/uploads', express.static(UPLOAD_DIR));

// Health check
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Public config (Google Client ID for frontend)
app.get('/api/v1/config/public', (req, res) => {
  res.json({ google_client_id: process.env.GOOGLE_CLIENT_ID || '' });
});

// Routes
app.use('/api/v1/auth',          authRouter);
app.use('/api/v1/users',         usersRouter);
app.use('/api/v1/reviews',       reviewsRouter);
app.use('/api/v1/reviews/:reviewId/comments', commentsRouter);
app.use('/api/v1/notifications', notifRouter);
app.use('/api/v1/conversations', msgRouter);
// Moderation routes: /reports is public-ish (auth required), /moderation is mod-only
app.use('/api/v1', modRouter);
app.use('/api/v1/tracking', trackingRouter);
app.use('/api/v1/wrapped',  wrappedRouter);

// Dev-only routes (auto-fill OTP, etc.)
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/v1/dev', require('./routes/dev'));
}

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
  console.error('[API Error]', err);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

// Share http.Server between Express and WebSocket server
const server = http.createServer(app);
socket.attach(server);

server.listen(PORT, () => {
  console.log(`POSER API running at http://localhost:${PORT}`);
  console.log(`WebSocket at ws://localhost:${PORT}/ws`);
});

module.exports = { app, server };
