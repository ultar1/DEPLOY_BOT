const { 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser,
    initAuthCreds,
    BufferJSON,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const { Boom } = require('@hapi/boom');

const BaileysPkg = require('@whiskeysockets/baileys'); 
const { internal } = BaileysPkg; 

// --- GLOBALS ---
const waClients = {}; 
const waTelegramMap = {}; 

// This will hold the database connection passed from bot.js
let dbPool = null; 

// --- INIT FUNCTION ---
function init(pool) {
    console.log('[WA Core] Initializing with Database Pool...');
    dbPool = pool;
    
    if (!dbPool) {
        console.error('[WA Core] CRITICAL ERROR: Pool is undefined during init.');
    }
}

// --- AUTH STORE IMPLEMENTATION ---

async function loadClientCreds(sessionId) {
    if (!dbPool) throw new Error("WA Core not initialized with DB pool");
    
    const res = await dbPool.query('SELECT creds, keys FROM wa_sessions WHERE session_id = $1', [sessionId]);
    if (res.rows.length === 0) return null;
    
    const row = res.rows[0];
    
    return {
        creds: row.creds ? JSON.parse(row.creds, internal.BufferJSON.reviver) : null,
        keys: row.keys ? JSON.parse(row.keys, internal.BufferJSON.reviver) : {}
    };
}

async function saveClientCreds(sessionId, creds, keys) {
    const credsJSON = JSON.stringify(creds, internal.BufferJSON.replacer);
    const keysJSON = JSON.stringify(keys);

    await dbPool.query(
        `INSERT INTO wa_sessions (session_id, creds, keys) VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO UPDATE SET creds = EXCLUDED.creds, keys = EXCLUDED.keys`,
        [sessionId, credsJSON, keysJSON]
    );
}

async function useDatabaseAuthState(sessionId) {
    let creds;
    let keys = {};
    const authData = await loadClientCreds(sessionId);

    if (authData && authData.creds) {
        creds = authData.creds;
        keys = authData.keys;
    } else {
        creds = initAuthCreds();
    }

    const saveKeys = {
        get: async (type, ids) => {
            const data = keys[type];
            if (typeof ids === 'string') return data ? data[ids] : undefined;
            return Array.isArray(ids) ? ids.map(id => data?.[id] || undefined) : {};
        },
        set: async (data) => {
            Object.assign(keys, data);
            await saveClientCreds(sessionId, creds, keys);
        }
    };

    return {
        state: { creds, keys: saveKeys },
        saveCreds: async () => await saveClientCreds(sessionId, creds, keys),
    };
}


// --- WHATSAPP CLIENT LOGIC ---
async function startClient(sessionId, targetNumber = null, chatId = null, botInstance = null, waitingMsg = null) {
    // 1. Register Chat ID immediately so logs/errors know where to go
    if(chatId) waTelegramMap[sessionId] = chatId; 
    
    // Retrieve from map if not provided (reconnect scenario)
    const currentChatId = chatId || waTelegramMap[sessionId];

    try {
        const { state, saveCreds } = await useDatabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: getRandomBrowser(), 
            version,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 250,
            emitOwnEvents: true 
        });

        sock.ev.on('creds.update', saveCreds);

        // --- CONNECTION HANDLER ---
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                const userJid = jidNormalizedUser(sock.user.id);
                const phoneNumber = userJid.split('@')[0];
                
                console.log(`[WA-SUCCESS] Connected: +${phoneNumber} (ID: ${sessionId})`);
                waClients[phoneNumber] = sock;
                
                await dbPool.query(
                    `UPDATE wa_sessions SET phone_number = $1, telegram_chat_id = $2, last_login = NOW() WHERE session_id = $3`,
                    [phoneNumber, currentChatId, sessionId]
                );

                if(currentChatId && botInstance) {
                    botInstance.sendMessage(currentChatId, `✅ **Connected Successfully!**\n\n📞 Number: +${phoneNumber}\n🆔 Session: \`${sessionId}\``, { parse_mode: 'Markdown' });
                }
            }

            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    await dbPool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]); 
                    delete waClients[sock.phoneNumber];
                    if(currentChatId && botInstance) botInstance.sendMessage(currentChatId, `⚠️ Session ${sessionId} logged out/disconnected.`);
                } else {
                    console.log(`[WA] Reconnecting ${sessionId}...`);
                    startClient(sessionId, null, currentChatId, botInstance); 
                }
            }
        });

        // --- PAIRING (Code Request) ---
        // 💡 FIX: Wait 3s, check if registered, then request code
        if (targetNumber && !sock.authState.creds.registered) {
            
            setTimeout(async () => {
                // Double check registration status inside timeout
                if (!sock.authState.creds.registered) {
                    try {
                        const fullTargetNumber = `+${targetNumber}`; 
                        console.log(`[WA-PAIRING] Requesting code for ${fullTargetNumber}...`);
                        
                        const code = await sock.requestPairingCode(targetNumber); // NOTE: Baileys usually takes number without '+' for this function, but sometimes with. Trying raw number first based on your base code.
                        
                        if (currentChatId && botInstance) {
                            const codeMessage = `✅ **Pairing Code Generated**\n\nCode for +${targetNumber}:\n\n\`${code}\`\n\n_Tap code to copy._`;
                            
                            if (waitingMsg && waitingMsg.message_id) {
                                await botInstance.editMessageText(codeMessage, {
                                    chat_id: currentChatId,
                                    message_id: waitingMsg.message_id, 
                                    parse_mode: 'Markdown'
                                }).catch(() => botInstance.sendMessage(currentChatId, codeMessage, { parse_mode: 'Markdown' }));
                            } else {
                                botInstance.sendMessage(currentChatId, codeMessage, { parse_mode: 'Markdown' });
                            }
                        }
                    } catch (e) {
                        console.error("[WA-PAIRING ERROR]", e);
                        if (currentChatId && botInstance) {
                            botInstance.sendMessage(currentChatId, `❌ **Failed to get code:** ${e.message}\n\nMake sure the number is valid and not banned.`);
                        }
                        // If pairing fails, maybe clean up the session? 
                        // await dbPool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);
                    }
                }
            }, 3000);
        }
    } catch (error) {
        console.error(`[WA-CLIENT ERROR] ${sessionId}:`, error);
        if (chatId && botInstance) botInstance.sendMessage(chatId, `[System Error] Could not start client: ${error.message}`);
    }
}

// --- EXPORTED WA HELPERS ---
function makeSessionId() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; 
    let randomStr = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 8; i++) randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    return `Ultarbot_${dateStr}_${randomStr}`;
}

function getRandomBrowser() {
    const browsers = [Browsers.macOS('Safari'), Browsers.macOS('Chrome'), Browsers.windows('Firefox'), Browsers.ubuntu('Chrome'), Browsers.windows('Edge')];
    return browsers[Math.floor(Math.random() * browsers.length)];
}

async function getConnectedClients() {
    if (!dbPool) return [];
    const result = await dbPool.query(
        `SELECT phone_number, telegram_chat_id 
         FROM wa_sessions 
         WHERE phone_number IS NOT NULL`
    );
    return result.rows;
}

async function loadAllClients(botInstance) {
    if (!dbPool) {
        console.error('[WA-SYSTEM] Cannot load clients: DB Pool not initialized.');
        return;
    }
    const sessions = await dbPool.query('SELECT session_id, phone_number, telegram_chat_id FROM wa_sessions');
    console.log(`[WA-SYSTEM] Reloading ${sessions.rows.length} sessions from DB...`);
    for (const session of sessions.rows) {
        // Pass botInstance so reloaded sessions can send messages
        startClient(session.session_id, null, session.telegram_chat_id, botInstance);
    }
}

module.exports = {
    init, 
    startClient, 
    makeSessionId, 
    loadAllClients,
    waClients, 
    getConnectedClients,
};
