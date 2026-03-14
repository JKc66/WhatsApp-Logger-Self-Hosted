const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

// Initialize Express
const app = express();
app.use(express.urlencoded({ extended: true })); // Parse form data
app.use(express.json()); // Parse JSON bodies (for API requests)

// --- FIREBASE SETUP ---
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("System: Firebase Admin initialized successfully.");
} catch (error) {
    console.error("System Error: Failed to initialize Firebase. Make sure FIREBASE_SERVICE_ACCOUNT env var is set.");
    process.exit(1);
}

const db = admin.firestore();

// --- BAILEYS SETUP ---
let qrCodeData = null; 
let pairingCode = null;
let sock = null;
let isConnected = false;

// Optional: set WHATSAPP_PHONE_NUMBER env var to auto-request a pairing code on startup
const WHATSAPP_PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER || null;

async function requestPairingCode(phoneNumber) {
    if (!sock || isConnected) return null;
    try {
        const digits = phoneNumber.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(digits);
        pairingCode = code;
        qrCodeData = null;
        console.log(`System: Pairing code for ${digits}: ${code}`);
        return code;
    } catch (err) {
        console.error("System Error: Failed to request pairing code:", err.message);
        return null;
    }
}

async function startWhatsApp() {
    const logger = pino({ level: 'silent' });
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ["WhatsApp Logger by notamitgamer", "Chrome", "1.0.0"],
        syncFullHistory: false 
    });

    // Auto-request pairing code if phone number env var is set and not yet registered.
    // A short delay allows the socket handshake to complete before requesting the code.
    const PAIRING_CODE_DELAY_MS = 3000;
    if (WHATSAPP_PHONE_NUMBER && !state.creds.registered) {
        setTimeout(() => requestPairingCode(WHATSAPP_PHONE_NUMBER), PAIRING_CODE_DELAY_MS);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Only show QR if no pairing code is being used
            if (!pairingCode) {
                qrCodeData = qr;
            }
            isConnected = false;
        }

        if (connection === 'close') {
            isConnected = false;
            pairingCode = null;
            qrCodeData = null;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === 'open') {
            console.log("System: Connection Open and Authenticated");
            qrCodeData = null;
            pairingCode = null;
            isConnected = true;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            try {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                if (remoteJid === 'status@broadcast') continue;

                const textContent = 
                    msg.message.conversation || 
                    msg.message.extendedTextMessage?.text || 
                    msg.message.imageMessage?.caption || 
                    msg.message.videoMessage?.caption || 
                    "";

                if (!textContent) continue;

                const timestamp = msg.messageTimestamp 
                    ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.low) 
                    : Math.floor(Date.now() / 1000);

                const isFromMe = msg.key.fromMe || false;
                const senderName = isFromMe ? "Me" : (msg.pushName || "Unknown");
                const phoneNumber = remoteJid.split('@')[0]; // Extract number from JID

                // --- FIX: Create/Update Parent Chat Document ---
                // This makes the chat visible in the list automatically
                await db.collection('Chats').doc(remoteJid).set({
                    lastActive: timestamp,
                    displayName: senderName,
                    phoneNumber: phoneNumber, // Added: Save phone number/ID to Chat
                    id: remoteJid
                }, { merge: true });

                // --- Save Message ---
                await db.collection('Chats')
                    .doc(remoteJid)
                    .collection('Messages')
                    .doc(msg.key.id)
                    .set({
                        text: textContent,
                        senderId: remoteJid,
                        senderName: senderName,
                        senderPhoneNumber: phoneNumber, // Added: Save phone number/ID to Message
                        timestamp: timestamp,
                        fromMe: isFromMe,
                        id: msg.key.id
                    }, { merge: true });

            } catch (err) {
                // Silent error handling
            }
        }
    });
}

// --- AUTH UTILS ---
const SESSION_SECRET = crypto.createHash('sha256').update(AUTH_PASS || 'default').digest('hex');

function parseCookies(request) {
    const list = {};
    const rc = request.headers.cookie;
    if (rc) {
        rc.split(';').forEach((cookie) => {
            const parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
    }
    return list;
}

// --- EXPRESS ROUTES ---

// 1. PUBLIC ROUTE: Ping
app.get('/ping', (req, res) => {
    res.status(200).send('Pong');
});

// 1b. PUBLIC ROUTE: Pairing code API (request a code for a given phone number)
app.post('/api/pair', async (req, res) => {
    if (isConnected) return res.status(400).json({ success: false, error: 'Already connected' });
    const phoneNumber = (req.body.phoneNumber || '').replace(/[^0-9]/g, '');
    // Shortest valid phone numbers in the world are 7 digits (e.g., some Caribbean numbers)
    const MIN_PHONE_NUMBER_LENGTH = 7;
    if (!phoneNumber || phoneNumber.length < MIN_PHONE_NUMBER_LENGTH) {
        return res.status(400).json({ success: false, error: 'Invalid phone number' });
    }
    const code = await requestPairingCode(phoneNumber);
    if (code) {
        return res.json({ success: true, code });
    }
    return res.status(500).json({ success: false, error: 'Failed to request pairing code. Make sure the app is initializing.' });
});

// 2. PUBLIC ROUTE: Verify Credentials API
app.post('/api/verify', (req, res) => {
    // CORS Headers
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

    const { username, password } = req.body;

    if (username === AUTH_USER && password === AUTH_PASS) {
        return res.json({ success: true });
    } else {
        return res.status(401).json({ success: false });
    }
});

app.options('/api/verify', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.sendStatus(200);
});

// 3. LOGIN PAGE (GET)
app.get('/login', (req, res) => {
    res.send(`
        <html>
            <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5;">
                <form action="/login" method="POST" style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 300px;">
                    <h2 style="margin-top: 0; text-align: center;">WhatsApp Logger</h2>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem;">Username</label>
                        <input type="text" name="username" required style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem;">Password</label>
                        <input type="password" name="password" required style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: flex; align-items: center; font-size: 0.9rem;">
                            <input type="checkbox" name="remember" value="yes" style="margin-right: 0.5rem;">
                            Keep me logged in for 5 mins
                        </label>
                    </div>
                    <button type="submit" style="width: 100%; padding: 0.75rem; background: #25D366; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">Login</button>
                </form>
            </body>
        </html>
    `);
});

// 4. LOGIN ACTION (POST)
app.post('/login', (req, res) => {
    const { username, password, remember } = req.body;

    if (username === AUTH_USER && password === AUTH_PASS) {
        let cookieSettings = 'HttpOnly; Path=/;'; 
        
        if (remember === 'yes') {
            cookieSettings += ' Max-Age=300;';
        }

        res.setHeader('Set-Cookie', `auth_session=${SESSION_SECRET}; ${cookieSettings}`);
        return res.redirect('/');
    }
    
    res.status(401).send('Invalid credentials. <a href="/login">Try again</a>');
});

// 5. LOGOUT ACTION
app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'auth_session=; Max-Age=0; Path=/;');
    res.redirect('/login');
});

// --- MIDDLEWARE: FORM AUTH ---
const checkAuth = (req, res, next) => {
    if (!AUTH_USER || !AUTH_PASS) return next();

    const cookies = parseCookies(req);
    if (cookies.auth_session === SESSION_SECRET) {
        return next();
    }

    if (req.path.startsWith('/api')) {
        res.status(401).send('Unauthorized');
    } else {
        res.redirect('/login');
    }
};

app.use(checkAuth);

// 6. PROTECTED ROUTE: Main Page (QR Code / Pairing Code)
app.get('/', async (req, res) => {
    const logoutBtn = `<a href="/logout" style="position: absolute; top: 10px; right: 10px; padding: 8px 16px; background: #ff4444; color: white; text-decoration: none; border-radius: 4px; font-size: 14px;">Logout</a>`;

    if (isConnected) {
        return res.send(`
            <html>
                <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #f0f2f5;">
                    ${logoutBtn}
                    <div style="background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                        <h2 style="color: green;">System Operational</h2>
                        <p style="color: #555;">Connected to WhatsApp.</p>
                        <p style="color: #999; font-size: 12px;">Back-end Service</p>
                    </div>
                </body>
            </html>
        `);
    }

    // Show pairing code if one was requested
    if (pairingCode) {
        return res.send(`
            <html>
                <head><meta http-equiv="refresh" content="5"></head>
                <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #f0f2f5;">
                    ${logoutBtn}
                    <div style="background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1); min-width: 300px;">
                        <h2>Phone Pairing Code</h2>
                        <p style="font-size: 2.5rem; font-weight: bold; letter-spacing: 0.2em; color: #25D366; margin: 1rem 0;">${pairingCode}</p>
                        <p style="color: #555; font-size: 0.9rem;">Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link with phone number<br>and enter the code above.</p>
                        <p style="color: #999; font-size: 12px;">Refreshes every 5 seconds...</p>
                    </div>
                </body>
            </html>
        `);
    }

    if (qrCodeData) {
        try {
            const qrImage = await QRCode.toDataURL(qrCodeData);
            return res.send(`
                <html>
                    <head><meta http-equiv="refresh" content="5"></head>
                    <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #f0f2f5;">
                        ${logoutBtn}
                        <div style="background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                            <h2>Scan to Link</h2>
                            <img src="${qrImage}" alt="QR Code" />
                            <p style="color: #666;">Refreshes every 5 seconds...</p>
                            <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid #eee;">
                            <p style="color: #888; font-size: 0.85rem;">Prefer phone pairing? Enter your number (with country code, digits only):</p>
                            <form id="pairForm" style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
                                <input type="tel" id="phoneInput" placeholder="e.g. 15551234567" style="padding:0.5rem; border:1px solid #ccc; border-radius:4px; font-size:1rem; width:200px;">
                                <button type="submit" style="padding:0.5rem 1rem; background:#25D366; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">Get Code</button>
                            </form>
                            <p id="pairMsg" style="font-size:0.85rem; color:#555; margin-top:0.5rem;"></p>
                            <script>
                                document.getElementById('pairForm').addEventListener('submit', async (e) => {
                                    e.preventDefault();
                                    const phone = document.getElementById('phoneInput').value;
                                    document.getElementById('pairMsg').textContent = 'Requesting...';
                                    const resp = await fetch('/api/pair', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({phoneNumber: phone}) });
                                    const data = await resp.json();
                                    if (data.success) {
                                        document.getElementById('pairMsg').textContent = 'Code: ' + data.code + ' — Enter it in WhatsApp > Linked Devices > Link with phone number';
                                    } else {
                                        document.getElementById('pairMsg').textContent = 'Error: ' + data.error;
                                    }
                                });
                            </script>
                        </div>
                    </body>
                </html>
            `);
        } catch (e) {
            return res.send("Error generating QR.");
        }
    }

    return res.send(`
        <html>
            <head><meta http-equiv="refresh" content="2"></head>
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <p>Initializing... please refresh.</p>
                ${logoutBtn}
            </body>
        </html>
    `);
});

// --- START SERVER ---
app.listen(PORT, () => {
    startWhatsApp();
    console.log(`Server running on port ${PORT}`);
    
    if (AUTH_USER && AUTH_PASS) {
        console.log("Security: Form Authentication is ENABLED.");
    } else {
        console.log("Security: Form Authentication is DISABLED (Env vars missing).");
    }
});
