const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const EXPIRY_HOURS = parseFloat(process.env.EXPIRY_HOURS) || 2;
const EXPIRY_MS = EXPIRY_HOURS * 60 * 60 * 1000; // 2 hours

// In-Memory Signaling Tunnel Rooms (Stateless & lightweight, < 1KB per session)
// Zero file data is ever stored here! Only WebRTC handshake signals.
const tunnels = new Map();

// Helper: Periodic room cleanup for inactive rooms older than 2 hours
function cleanupExpiredTunnels() {
  const now = Date.now();
  for (const [code, tunnel] of tunnels.entries()) {
    if (now >= tunnel.expiresAt) {
      tunnels.delete(code);
      console.log(`[P2P Tunnel] Cleaned up inactive tunnel: ${code}`);
    }
  }
}
setInterval(cleanupExpiredTunnels, 60 * 1000);

// Helper: Generate unique 6-digit room code
function generateUniqueCode() {
  for (let i = 0; i < 1000; i++) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    if (!tunnels.has(code)) return code;
  }
  return uuidv4().slice(0, 6).toUpperCase();
}

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

// ==========================================
// API ROUTES
// ==========================================

// 0. Root Status
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'GhostDrop P2P WebRTC Signaling Server',
    storage: '0 MB (Direct Browser-to-Browser Streaming)',
    fileSizeLimit: 'Unlimited',
    activeTunnels: tunnels.size,
    endpoints: {
      health: '/api/health',
      activeChannels: '/api/tunnel/active',
      createChannel: 'POST /api/tunnel/create',
      channelInfo: 'GET /api/tunnel/info/:code',
      signal: 'POST /api/tunnel/signal/:code',
      poll: 'GET /api/tunnel/poll/:code'
    }
  });
});

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    mode: 'p2p-webrtc-tunnel',
    serverStorage: '0 MB (Direct Browser-to-Browser)',
    fileSizeLimit: 'Unlimited (Streamed directly via P2P)',
    activeTunnels: tunnels.size,
    expiryHours: EXPIRY_HOURS,
    serverTime: Date.now()
  });
});

// 2. Create P2P Tunnel Session (Sender Registers File Metadata)
app.post('/api/tunnel/create', async (req, res) => {
  try {
    const { originalName, size, mimeType } = req.body;
    if (!originalName) {
      return res.status(400).json({ success: false, message: 'File name is required' });
    }

    const code = generateUniqueCode();
    const tunnelId = uuidv4();
    const now = Date.now();
    const expiresAt = now + EXPIRY_MS;
    const clientOrigin = req.headers.origin || `http://localhost:5173`;
    const shareableUrl = `${clientOrigin}/#/download/${code}`;

    let qrCodeDataUrl = '';
    try {
      qrCodeDataUrl = await QRCode.toDataURL(shareableUrl, { width: 256, margin: 2 });
    } catch (e) {}

    const tunnelRecord = {
      id: tunnelId,
      code: code,
      file: {
        name: originalName,
        size: size || 0,
        type: mimeType || 'application/octet-stream'
      },
      createdAt: now,
      expiresAt: expiresAt,
      senderSignals: [],
      receiverSignals: [],
      connected: false
    };

    tunnels.set(code, tunnelRecord);

    console.log(`[P2P Tunnel Created] Code: ${code} | File: ${originalName} (${size} bytes)`);

    res.json({
      success: true,
      code,
      tunnelId,
      expiresAt,
      shareUrl: shareableUrl,
      qrCode: qrCodeDataUrl,
      file: tunnelRecord.file
    });
  } catch (err) {
    console.error('Error creating tunnel:', err);
    res.status(500).json({ success: false, message: 'Failed to create tunnel' });
  }
});

// 3. Get Tunnel / File Info by 6-digit Code
app.get('/api/tunnel/info/:code', (req, res) => {
  const { code } = req.params;
  const tunnel = tunnels.get(code);

  if (!tunnel) {
    return res.status(404).json({
      success: false,
      message: 'Tunnel not found or session has expired.'
    });
  }

  if (Date.now() >= tunnel.expiresAt) {
    tunnels.delete(code);
    return res.status(410).json({
      success: false,
      message: 'Tunnel has expired (2-hour limit reached).'
    });
  }

  res.json({
    success: true,
    tunnel: {
      id: tunnel.id,
      code: tunnel.code,
      file: tunnel.file,
      createdAt: tunnel.createdAt,
      expiresAt: tunnel.expiresAt,
      remainingSeconds: Math.max(0, Math.floor((tunnel.expiresAt - Date.now()) / 1000)),
      connected: tunnel.connected
    }
  });
});

// 4. Send WebRTC Handshake Signal (SDP Offer / Answer / ICE Candidates)
app.post('/api/tunnel/signal/:code', (req, res) => {
  const { code } = req.params;
  const { role, signal } = req.body; // role: 'sender' | 'receiver'
  const tunnel = tunnels.get(code);

  if (!tunnel) {
    return res.status(404).json({ success: false, message: 'Tunnel session not found' });
  }

  if (role === 'sender') {
    tunnel.senderSignals.push(signal);
  } else if (role === 'receiver') {
    tunnel.receiverSignals.push(signal);
    tunnel.connected = true;
  } else {
    return res.status(400).json({ success: false, message: 'Invalid role' });
  }

  res.json({ success: true });
});

// 5. Poll for Incoming Signals from the Other Peer
app.get('/api/tunnel/poll/:code', (req, res) => {
  const { code } = req.params;
  const { role } = req.query; // Who is polling? 'sender' or 'receiver'
  const tunnel = tunnels.get(code);

  if (!tunnel) {
    return res.status(404).json({ success: false, message: 'Tunnel session not found' });
  }

  let signals = [];
  if (role === 'sender') {
    // Sender wants signals sent by receiver
    signals = [...tunnel.receiverSignals];
    tunnel.receiverSignals = []; // drain
  } else if (role === 'receiver') {
    // Receiver wants signals sent by sender
    signals = [...tunnel.senderSignals];
    tunnel.senderSignals = []; // drain
  }

  res.json({ success: true, signals });
});

// 6. Close / Cancel Tunnel
app.delete('/api/tunnel/:code', (req, res) => {
  const { code } = req.params;
  tunnels.delete(code);
  res.json({ success: true, message: 'Tunnel closed' });
});

// 7. List Active Waiting Tunnels
app.get('/api/tunnel/active', (req, res) => {
  cleanupExpiredTunnels();
  const now = Date.now();
  const list = [];

  for (const [code, tunnel] of tunnels.entries()) {
    if (tunnel.expiresAt > now) {
      list.push({
        id: tunnel.id,
        code: tunnel.code,
        originalName: tunnel.file.name,
        size: tunnel.file.size,
        mimeType: tunnel.file.type,
        createdAt: tunnel.createdAt,
        expiresAt: tunnel.expiresAt,
        remainingSeconds: Math.max(0, Math.floor((tunnel.expiresAt - now) / 1000)),
        connected: tunnel.connected
      });
    }
  }

  res.json({ success: true, files: list });
});

// Export Express app for Vercel Serverless
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`🚀 GhostDrop P2P Streaming Server on port ${PORT}`);
    console.log(`⚡ Mode: WebRTC Direct Tunnel (0 MB Server Storage)`);
    console.log(`📦 File Size Limit: UNLIMITED (Direct Peer Stream)`);
    console.log(`⏱️ Inactive session timeout: ${EXPIRY_HOURS} hours`);
    console.log(`===============================================`);
  });
}
