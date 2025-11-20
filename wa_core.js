import { 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser,
    initAuthCreds,
    BufferJSON,
    // REMOVED 'internal' here
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
// Import the entire Baileys package to access the internal namespace correctly
import * as BaileysPkg from '@whiskeysockets/baileys'; 
import * as dbServices from './bot_services.js'; 

// --- CRITICAL FIX: Access internal Baileys utilities via BaileysPkg ---
const { internal } = BaileysPkg;


// --- EXPORTED GLOBALS ---
export const waClients = {};
export const waTelegramMap = {}; 

// --- AUTH STORE IMPLEMENTATION (Custom Database Backed) ---

async function loadClientCreds(sessionId) {
    // This assumes your bot_services.js has access to the main pool
    const res = await dbServices.pool.query('SELECT creds, keys FROM wa_sessions WHERE session_id = $1', [sessionId]);
    if (res.rows.length === 0) return null;
    
    const row = res.rows[0];
    return {
        // Use BaileysPkg.internal.BufferJSON
        creds: row.creds ? JSON.parse(row.creds, BaileysPkg.internal.BufferJSON.reviver) : null,
        keys: row.keys ? JSON.parse(row.keys, BaileysPkg.internal.BufferJSON.reviver) : {}
    };
}

async function saveClientCreds(sessionId, creds, keys) {
    // Use BaileysPkg.internal.BufferJSON
    const credsJSON = JSON.stringify(creds, BaileysPkg.internal.BufferJSON.replacer);
    const keysJSON = JSON.stringify(keys);

    await dbServices.pool.query(
        `INSERT INTO wa_sessions (session_id, creds, keys) VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO UPDATE SET creds = EXCLUDED.creds, keys = EXCLUDED.keys`,
        [sessionId, credsJSON, keysJSON]
    );
}

// Function to get Baileys-compatible state object
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
export async function startClient(sessionId, targetNumber = null, chatId = null, botInstance = null, waitingMsg = null) {
    if(chatId) waTelegramMap[sessionId] = chatId; 

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
                
                // CRITICAL: Update phone number and chat ID to DB
                await dbServices.pool.query(
                    `UPDATE wa_sessions SET phone_number = $1, telegram_chat_id = $2, last_login = NOW() WHERE session_id = $3`,
                    [phoneNumber, chatId, sessionId]
                );

                if(chatId && botInstance) botInstance.sendMessage(chatId, `[SUCCESS] Connected: +${phoneNumber}\nSession ID: ${sessionId}`);
            }

            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    await dbServices.pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]); // DELETE FROM DATABASE
                    delete waClients[sock.phoneNumber];
                } else {
                    const savedChatId = waTelegramMap[sessionId];
                    startClient(sessionId, targetNumber, savedChatId, botInstance); // Attempt reconnect
                }
            }
        });

        // --- PAIRING (Code Request) ---
        if (targetNumber && !sock.authState.creds.registered) {
            const fullTargetNumber = `+${targetNumber}`; 
            setTimeout(async () => {
                if (!sock.authState.creds.registered) {
                    try {
                        console.log(`[WA-PAIRING] Requesting code for ${fullTargetNumber}...`);
                        const code = await sock.requestPairingCode(fullTargetNumber);
                        
                        // Notify admin (The bot instance must be passed correctly from bot.js)
                        if (chatId && botInstance) {
                            const codeMessage = `**Pairing Code Generated**\n\nCode for ${fullTargetNumber}:\n\n\`${code}\`\n\n_Tap code to copy._`;
                            
                            if (waitingMsg && waitingMsg.message_id) {
                                await botInstance.editMessageText(codeMessage, {
                                    chat_id: chatId,
                                    message_id: waitingMsg.message_id, 
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                // Fallback: Send a new message if the initial one was lost
                                botInstance.sendMessage(chatId, codeMessage, { parse_mode: 'Markdown' });
                            }
                        }
                    } catch (e) {
                        if (chatId && botInstance) botInstance.sendMessage(chatId, `[ERROR] Failed to get code: ${e.message}`);
                    }
                }
            }, 3000);
        }
    } catch (error) {
        console.error(`[WA-CLIENT ERROR] ${sessionId}:`, error);
    }
}

// --- EXPORTED WA HELPERS ---
export function makeSessionId() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; 
    let randomStr = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 8; i++) randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    return `Ultarbot_${dateStr}_${randomStr}`;
}

export function getRandomBrowser() {
    const browsers = [Browsers.macOS('Safari'), Browsers.macOS('Chrome'), Browsers.windows('Firefox'), Browsers.ubuntu('Chrome'), Browsers.windows('Edge')];
    return browsers[Math.floor(Math.random() * browsers.length)];
}

export async function loadAllClients(botInstance) {
    const sessions = await dbServices.pool.query('SELECT session_id, phone_number, telegram_chat_id FROM wa_sessions');
    console.log(`[WA-SYSTEM] Reloading ${sessions.rows.length} sessions from DB...`);
    for (const session of sessions.rows) {
        startClient(session.session_id, session.phone_number, session.telegram_chat_id, botInstance);
    }
}
