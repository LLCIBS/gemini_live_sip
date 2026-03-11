import 'dotenv/config';
import './ws-proxy-patch.js';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { CallManager, type Checklist } from './call-manager.js';
import type { SipConfig } from './sip-agent.js';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// ─── Configuration from environment ──────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set. Add it to .env.local file.');
  process.exit(1);
}

// ─── HTTPS proxy for Gemini/HTTP (Node-side, как в тестовом скрипте) ───────────
const proxyUrl = process.env.HTTPS_PROXY || 'http://localhost:1080';
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl }));
  console.log('HTTP(S) proxy enabled for outbound requests via undici.');
}

// Default SIP config (can be overridden via API)
let sipConfig: SipConfig = {
  host: process.env.SIP_HOST || '176.67.241.251',
  port: parseInt(process.env.SIP_PORT || '5060', 10),
  username: process.env.SIP_USERNAME || '4998',
  password: process.env.SIP_PASSWORD || '',
  domain: process.env.SIP_DOMAIN || 'bestway',
  displayName: process.env.SIP_DISPLAY_NAME || 'Gemini Bot',
  localIp: process.env.SIP_LOCAL_IP,
  localPort: process.env.SIP_LOCAL_PORT ? parseInt(process.env.SIP_LOCAL_PORT, 10) : undefined,
};

// ─── Call Manager ────────────────────────────────────────────────────────────

let callManager: CallManager | null = null;

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
const server = createServer(app);

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    // Let Vite HMR handle its own upgrades
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));

  // Send current state on connect
  if (callManager) {
    ws.send(JSON.stringify({
      type: 'sipStatus',
      data: callManager.sipRegistered ? 'registered' : 'disconnected',
    }));
    const active = callManager.getActiveCalls();
    if (active.length > 0) {
      ws.send(JSON.stringify({ type: 'activeCalls', data: active }));
    }
  }
});

function broadcast(type: string, data: any) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function setupCallManagerEvents(cm: CallManager) {
  cm.on('sipStatus', (status) => broadcast('sipStatus', status));
  cm.on('callStateChanged', (state) => broadcast('callState', state));
  cm.on('callEnded', (log) => broadcast('callEnded', log));
  cm.on('transcript', (callId, speaker, text) => {
    broadcast('transcript', { callId, speaker, text });
  });
  cm.on('log', (level, msg) => {
    broadcast('log', { level, msg, time: new Date().toISOString() });
    const prefix = level === 'error' ? '  ERROR' : level === 'warn' ? '   WARN' : '   INFO';
    console.log(`[${prefix}] ${msg}`);
  });
}

// ─── API Routes ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    sipRegistered: callManager?.sipRegistered ?? false,
    activeCalls: callManager?.getActiveCalls().length ?? 0,
  });
});

// SIP connection management
app.get('/api/sip/status', (_req, res) => {
  res.json({
    registered: callManager?.sipRegistered ?? false,
    config: {
      host: sipConfig.host,
      port: sipConfig.port,
      username: sipConfig.username,
      domain: sipConfig.domain,
      displayName: sipConfig.displayName,
    },
  });
});

app.post('/api/sip/connect', async (req, res) => {
  try {
    // Optionally update config from request body
    if (req.body.host) sipConfig.host = req.body.host;
    if (req.body.port) sipConfig.port = parseInt(req.body.port, 10);
    if (req.body.username) sipConfig.username = req.body.username;
    if (req.body.password) sipConfig.password = req.body.password;
    if (req.body.domain) sipConfig.domain = req.body.domain;
    if (req.body.displayName) sipConfig.displayName = req.body.displayName;
    if (req.body.localIp) sipConfig.localIp = req.body.localIp;

    // Stop existing manager if any
    if (callManager) {
      await callManager.stop();
      callManager.removeAllListeners();
    }

    callManager = new CallManager(sipConfig, GEMINI_API_KEY);
    setupCallManagerEvents(callManager);

    // Set checklists if stored
    if ((global as any).__checklists) {
      callManager.setChecklists((global as any).__checklists);
    }

    await callManager.start();
    res.json({ status: 'ok', message: 'SIP registration initiated' });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/sip/disconnect', async (_req, res) => {
  try {
    if (callManager) {
      await callManager.stop();
      callManager.removeAllListeners();
      callManager = null;
    }
    broadcast('sipStatus', 'disconnected');
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Checklists (stored in memory, synced from frontend)
app.post('/api/checklists/sync', (req, res) => {
  const checklists: Checklist[] = req.body.checklists || [];
  (global as any).__checklists = checklists;
  if (callManager) {
    callManager.setChecklists(checklists);
  }
  res.json({ status: 'ok', count: checklists.length });
});

app.get('/api/checklists', (_req, res) => {
  res.json({ checklists: (global as any).__checklists || [] });
});

// Call management
app.post('/api/call/start', async (req, res) => {
  if (!callManager) {
    return res.status(400).json({ status: 'error', message: 'SIP not connected' });
  }
  const { number, checklistId, customerName, callMode } = req.body;
  if (!number || !checklistId) {
    return res.status(400).json({ status: 'error', message: 'number and checklistId required' });
  }
  try {
    const callId = await callManager.makeCall(number, checklistId, customerName, callMode);
    res.json({ status: 'ok', callId });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/call/stop', (req, res) => {
  if (!callManager) {
    return res.status(400).json({ status: 'error', message: 'SIP not connected' });
  }
  const { callId } = req.body;
  if (!callId) {
    return res.status(400).json({ status: 'error', message: 'callId required' });
  }
  callManager.hangup(callId);
  res.json({ status: 'ok' });
});

app.get('/api/calls/active', (_req, res) => {
  res.json({ calls: callManager?.getActiveCalls() ?? [] });
});

app.get('/api/calls/history', (_req, res) => {
  res.json({ calls: callManager?.getCallHistory() ?? [] });
});

// ─── Vite middleware (dev) or static (production) ────────────────────────────

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: ROOT_DIR,
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(ROOT_DIR, 'dist')));
    // Express 5 + path-to-regexp: используем параметр с маской вместо '*'
    app.get('/:path(*)', (_req, res) => {
      res.sendFile(path.join(ROOT_DIR, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Server running on http://localhost:${PORT}`);
    console.log(`  SIP target: ${sipConfig.host}:${sipConfig.port}`);
    console.log(`  SIP user: ${sipConfig.username}@${sipConfig.domain}\n`);
  });

  // Auto-connect SIP if credentials are in env
  if (sipConfig.password) {
    console.log('  Auto-connecting to SIP...');
    try {
      callManager = new CallManager(sipConfig, GEMINI_API_KEY);
      setupCallManagerEvents(callManager);
      await callManager.start();
    } catch (err: any) {
      console.error(`  Failed to auto-connect SIP: ${err.message}`);
    }
  }
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
