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

// Sanitize filename (no path traversal)
function sanitizeFilename(name) {
    return path.basename(name);
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
app.post('/api/sessions/:sessionId/files/:filename', (req, res) => {
    const { sessionId, filename } = req.params;
    if (!isValidSessionId(sessionId)) return res.status(400).send('Invalid session ID');

    const safeName = sanitizeFilename(filename);
    if (!safeName) return res.status(400).send('Invalid filename');

    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const tmpPath = path.join(sessionDir, safeName + '.tmp.' + crypto.randomBytes(4).toString('hex'));
    const finalPath = path.join(sessionDir, safeName);

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const buf = Buffer.concat(chunks);
        try {
            fs.writeFileSync(tmpPath, buf);
            fs.renameSync(tmpPath, finalPath);
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
app.get('/api/sessions/:sessionId/files/:filename', (req, res) => {
    const { sessionId, filename } = req.params;
    if (!isValidSessionId(sessionId)) return res.status(400).send('Invalid session ID');

    const safeName = sanitizeFilename(filename);
    if (!safeName) return res.status(400).send('Invalid filename');

    const filePath = path.join(SESSIONS_DIR, sessionId, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
});

// --- WebSocket session management ---
// Map<sessionId, Set<ws>>
const sessions = new Map();

wss.on('connection', (ws) => {
    let sessionId = null;

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }

        if (msg.type === 'join' && isValidSessionId(msg.sessionId)) {
            sessionId = msg.sessionId;
            if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
            sessions.get(sessionId).add(ws);

            // Send existing files in this session
            const sessionDir = path.join(SESSIONS_DIR, sessionId);
            const files = [];
            if (fs.existsSync(sessionDir)) {
                for (const name of fs.readdirSync(sessionDir)) {
                    // Skip temp files
                    if (name.includes('.tmp.')) continue;
                    try {
                        const stat = fs.statSync(path.join(sessionDir, name));
                        files.push({ filename: name, size: stat.size });
                    } catch (_) {}
                }
            }
            ws.send(JSON.stringify({ type: 'session_files', files }));
        } else if (msg.type === 'file_available' && sessionId) {
            // Broadcast to other clients in the same session
            const peers = sessions.get(sessionId);
            if (!peers) return;
            const broadcast = JSON.stringify({
                type: 'file_available',
                filename: msg.filename,
                size: msg.size,
            });
            for (const peer of peers) {
                if (peer !== ws && peer.readyState === 1) {
                    peer.send(broadcast);
                }
            }
        }
    });

    ws.on('close', () => {
        if (sessionId && sessions.has(sessionId)) {
            sessions.get(sessionId).delete(ws);
            if (sessions.get(sessionId).size === 0) {
                sessions.delete(sessionId);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`tev collaboration server running on http://localhost:${PORT}`);
});
