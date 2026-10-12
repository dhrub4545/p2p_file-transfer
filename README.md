# P2P File Transfer Signaling Backend

A lightweight, zero-storage WebRTC Peer-to-Peer signaling and matchmaking server built with Express and Node.js.

## Features

- **0 MB Server Storage**: Files stream directly from browser to browser via WebRTC data channels; the server never stores or touches user file content.
- **Unlimited File Transfer**: Direct peer-to-peer streaming with flow control backpressure.
- **Fast Matchmaking**: Lightweight HTTP signaling matchmaker for exchanging SDP Offers, Answers, and ICE candidates.
- **Active Channel Discovery**: Open channel broadcasting allows receivers to connect with a single click.
- **Ephemeral Sessions**: Sessions auto-expire after 2 hours.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Default configuration:
```env
PORT=5000
EXPIRY_HOURS=2
```

### 3. Run Server
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## API Endpoints

- `GET /api/health` — Health check & server status.
- `POST /api/tunnel/create` — Create a new P2P broadcast channel with file metadata.
- `GET /api/tunnel/active` — List open broadcast channels awaiting receivers.
- `GET /api/tunnel/info/:code` — Retrieve tunnel metadata by 6-digit room code.
- `POST /api/tunnel/signal/:code` — Post SDP Offers, Answers, and ICE candidates.
- `GET /api/tunnel/poll/:code` — Poll pending WebRTC handshake signals (`role=sender` or `role=receiver`).
- `DELETE /api/tunnel/:code` — Close tunnel session.

## License
MIT
