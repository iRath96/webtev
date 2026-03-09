const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const BUILD_DIR = path.join(__dirname, '..', 'build-web');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Session ID validation
function isValidSessionId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// File ID validation (alphanumeric, 8-16 chars)
function isValidFileId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9]{8,16}$/.test(id);
}

// --- Static file serving with COOP/COEP headers ---
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
});
app.use(express.static(BUILD_DIR));

// Serve tev.html for bare "/" so URLs look like http://localhost:8080/#sessionid
app.get('/', (req, res) => {
    res.sendFile(path.join(BUILD_DIR, 'tev.html'));
});

// --- File upload ---
app.post('/api/sessions/:sessionId/files/:fileId', (req, res) => {
    const { sessionId, fileId } = req.params;
    if (!isValidSessionId(sessionId)) return res.status(400).send('Invalid session ID');
    if (!isValidFileId(fileId)) return res.status(400).send('Invalid file ID');

    const filename = req.query.filename || fileId;

    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const tmpPath = path.join(sessionDir, fileId + '.tmp.' + crypto.randomBytes(4).toString('hex'));
    const finalPath = path.join(sessionDir, fileId);
    const metaPath = path.join(sessionDir, fileId + '.meta.json');

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const buf = Buffer.concat(chunks);
        try {
            fs.writeFileSync(tmpPath, buf);
            fs.renameSync(tmpPath, finalPath);
            fs.writeFileSync(metaPath, JSON.stringify({ filename, size: buf.length }));
            res.status(200).send('OK');
        } catch (err) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            res.status(500).send('Write failed');
        }
    });
    req.on('error', () => {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        res.status(500).send('Upload error');
    });
});

// --- File download ---
app.get('/api/sessions/:sessionId/files/:fileId', (req, res) => {
    const { sessionId, fileId } = req.params;
    if (!isValidSessionId(sessionId)) return res.status(400).send('Invalid session ID');
    if (!isValidFileId(fileId)) return res.status(400).send('Invalid file ID');

    const filePath = path.join(SESSIONS_DIR, sessionId, fileId);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
});

// --- File delete ---
app.delete('/api/sessions/:sessionId/files/:fileId', (req, res) => {
    const { sessionId, fileId } = req.params;
    if (!isValidSessionId(sessionId)) return res.status(400).send('Invalid session ID');
    if (!isValidFileId(fileId)) return res.status(400).send('Invalid file ID');

    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    try { fs.unlinkSync(path.join(sessionDir, fileId)); } catch (_) {}
    try { fs.unlinkSync(path.join(sessionDir, fileId + '.meta.json')); } catch (_) {}
    res.status(200).send('OK');
});

// --- WebSocket session management ---
// Map<sessionId, Set<ws>>
const sessions = new Map();
// Map<sessionId, object> — latest UI state per session
const sessionUiState = new Map();
// Map<sessionId, timeout> — delayed cleanup of UI state after all clients leave
const sessionCleanupTimers = new Map();

wss.on('connection', (ws) => {
    let sessionId = null;

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }

        if (msg.type === 'join' && isValidSessionId(msg.sessionId)) {
            sessionId = msg.sessionId;
            if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
            sessions.get(sessionId).add(ws);

            // Cancel any pending cleanup timer (e.g. after page reload)
            if (sessionCleanupTimers.has(sessionId)) {
                clearTimeout(sessionCleanupTimers.get(sessionId));
                sessionCleanupTimers.delete(sessionId);
            }

            // Send existing files in this session
            const sessionDir = path.join(SESSIONS_DIR, sessionId);
            const files = [];
            if (fs.existsSync(sessionDir)) {
                for (const name of fs.readdirSync(sessionDir)) {
                    if (!name.endsWith('.meta.json')) continue;
                    if (name.includes('.tmp.')) continue;
                    try {
                        const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, name), 'utf8'));
                        const id = name.slice(0, -'.meta.json'.length);
                        const dataPath = path.join(sessionDir, id);
                        if (fs.existsSync(dataPath)) {
                            files.push({ id, filename: meta.filename, size: meta.size });
                        }
                    } catch (_) {}
                }
            }
            ws.send(JSON.stringify({ type: 'session_files', files }));

            // Send stored UI state if available
            const savedState = sessionUiState.get(sessionId);
            if (savedState) {
                ws.send(JSON.stringify(savedState));
            }
        } else if (msg.type === 'ui_state' && sessionId) {
            // Store latest state
            sessionUiState.set(sessionId, msg);

            // Broadcast to ALL clients (including sender for echo-based confirmation)
            const peers = sessions.get(sessionId);
            if (!peers) return;
            const broadcast = JSON.stringify(msg);
            for (const peer of peers) {
                if (peer.readyState === 1) {
                    peer.send(broadcast);
                }
            }
        } else if (msg.type === 'cursor' && sessionId) {
            // Ephemeral cursor position — broadcast to other peers only, not stored
            const peers = sessions.get(sessionId);
            if (!peers) return;
            const otherPeers = [...peers].filter(p => p !== ws && p.readyState === 1);
            const broadcast = JSON.stringify(msg);
            for (const peer of otherPeers) {
                peer.send(broadcast);
            }
        }
    });

    ws.on('close', () => {
        if (sessionId && sessions.has(sessionId)) {
            sessions.get(sessionId).delete(ws);
            if (sessions.get(sessionId).size === 0) {
                sessions.delete(sessionId);
                // Don't delete UI state immediately — page reloads cause a brief
                // gap where 0 clients are connected. Clean up after 5 minutes.
                if (sessionCleanupTimers.has(sessionId)) clearTimeout(sessionCleanupTimers.get(sessionId));
                sessionCleanupTimers.set(sessionId, setTimeout(() => {
                    sessionCleanupTimers.delete(sessionId);
                    // Only delete if still no clients
                    if (!sessions.has(sessionId) || sessions.get(sessionId).size === 0) {
                        sessionUiState.delete(sessionId);
                    }
                }, 5 * 60 * 1000));
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`tev collaboration server running on http://localhost:${PORT}`);
});
