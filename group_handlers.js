// --- Helper Functions ---

let bot;
let dbServices;
let escapeMarkdown;

/**
 * Parses a duration string (e.g., "5m", "1h", "3d") into a UNIX timestamp.
 */
const parseDuration = (durationStr) => {
    if (!durationStr) return null;
    const match = durationStr.match(/^(\d+)([mhd])$/);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2];
    const now = Math.floor(Date.now() / 1000); // Current time in seconds

    switch (unit) {
        case 'm': return now + (value * 60);
        case 'h': return now + (value * 60 * 60);
        case 'd': return now + (value * 24 * 60 * 60);
        default: return null;
    }
};

/**
 * Checks if a user is an admin or creator in a specific chat.
 */
const isAdmin = async (bot, chatId, userId) => {
    try {
        const member = await bot.getChatMember(chatId, userId);
        return ['administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error(`Error checking admin status: ${error.message}`);
        return false;
    }
};

/**
 * A helper to quickly send and delete an ERROR message (lasts 5 seconds).
 */
const sendTempMessage = (bot, chatId, text, replyToMessageId, duration = 5000) => {
    bot.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId })
        .then(msg => {
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }, duration);
        }).catch(() => {});
};

/**
 * NEW: A helper to send a SUCCESS message that self-destructs after 5 minutes.
 */
const sendSelfDestructingMessage = (bot, chatId, text, replyToMessageId) => {
    const duration = 300000; // 5 minutes
    bot.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId })
        .then(msg => {
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }, duration);
        }).catch(() => {});
};

/**
 * NEW: Gets the target user from a command, either by reply or by User ID.
 * @returns {object} - { id: "123", name: "John", isReply: true } or { error: "..." }
 */
const getTarget = async (bot, msg, args) => {
    const chatId = msg.chat.id;

    // 1. By Reply
    if (msg.reply_to_message) {
        return {
            id: msg.reply_to_message.from.id,
            name: msg.reply_to_message.from.first_name,
            isReply: true
        };
    }
    
    // 2. By User ID (as second argument)
    const targetArg = args[1];
    if (targetArg && /^\d{5,}$/.test(targetArg)) { // Check for a numeric ID
        try {
            const member = await bot.getChatMember(chatId, targetArg);
            return {
                id: member.user.id,
                name: member.user.first_name,
                isReply: false
            };
        } catch (e) {
            return { error: "Could not find user with that ID." };
        }
    }
    
    // 3. No target found
    return { error: "Please reply to a user or provide their User ID as the first argument." };
};


// --- Main Registration Function ---

function registerGroupHandlers(_bot, _dbServices) {
    
    bot = _bot;
    dbServices = _dbServices;
    
    escapeMarkdown = (text) => text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&'); // Basic fallback
    if (dbServices && dbServices.escapeMarkdown) {
        escapeMarkdown = dbServices.escapeMarkdown;
    }

    /**
     * 1. HANDLER FOR NEW MEMBERS (WELCOME & BLACKLIST CHECK)
     */
    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;

        // Get settings for this group (blacklist AND welcome)
        let blacklistedNames = [];
        let groupSettings;
        try {
            blacklistedNames = await dbServices.getBlacklistedNames(chatId);
            groupSettings = await dbServices.getGroupSettings(chatId); // <-- NEW
        } catch (e) {
            console.error("Failed to fetch group settings:", e.message);
            return; // Don't proceed if DB fails
        }

        for (const member of msg.new_chat_members) {
            if (member.is_bot) continue; 

            // --- BLACKLIST CHECK ---
            if (blacklistedNames.length > 0) {
                const firstName = (member.first_name || '').toLowerCase();
                const lastName = (member.last_name || '').toLowerCase();
                const username = (member.username || '').toLowerCase();

                const isBlacklisted = blacklistedNames.some(fragment => 
                    firstName.includes(fragment) ||
                    lastName.includes(fragment) ||
                    username.includes(fragment)
                );

                if (isBlacklisted) {
                    try {
                        await bot.banChatMember(chatId, member.id);
                        await bot.unbanChatMember(chatId, member.id); 
                        console.log(`[Blacklist] Kicked user ${member.first_name} (${member.id}) from chat ${chatId} due to name match.`);
                        sendTempMessage(bot, chatId, `Removed user ${member.first_name} (Name matched blacklist).`, msg.message_id, 10000);
                    } catch (e) {
                        console.error(`[Blacklist] Failed to kick ${member.id}:`, e.message);
                    }
                    continue; // Skip the welcome message
                }
            }
            
            // --- 💡 NEW WELCOME CHECK 💡 ---
            // Only send welcome if it's enabled in settings
            if (groupSettings.welcome_enabled) {
                let welcomeMessage = groupSettings.welcome_message;
                
                // If no custom message is set, use the default
                if (!welcomeMessage) {
                    welcomeMessage = `Hello {user}, welcome to the group!`;
                }

                // Replace placeholders
                const finalMessage = welcomeMessage
                    .replace(/{user}/g, member.first_name)
                    .replace(/{group}/g, msg.chat.title || 'the group');

                try {
                    await bot.sendMessage(chatId, finalMessage);
                } catch (error) {
                    console.error(`Failed to send welcome message: ${error.message}`);
                }
            }
            // --- 💡 END OF WELCOME CHECK 💡 ---
        }
    });

    /**
     * 2. HANDLER FOR LEAVING MEMBERS (GOODBYE)
     */
    bot.on('left_chat_member', async (msg) => {
        // (This is unchanged, but you could add a similar setting for 'goodbye' messages)
        const chatId = msg.chat.id;
        const member = msg.left_chat_member;
        if (member.is_bot) return;
        const goodbyeMessage = `Goodbye, ${member.first_name}.`;
        try {
            await bot.sendMessage(chatId, goodbyeMessage);
        } catch (error) {
            console.error(`Failed to send goodbye message: ${error.message}`);
        }
    });

    /**
     * 3. HANDLER FOR COMMANDS
     */
    bot.on('message', async (msg) => {
        if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
            return;
        }

        const text = msg.text || '';
        const chatId = msg.chat.id;
        const fromId = msg.from.id;
        
        // Removed logUserActivity and @admin calls

        if (!text.startsWith('/')) {
            return;
        }

        const args = text.split(' ');
        const command = args[0].split('@')[0];
        const reply = msg.reply_to_message;

        // --- 💡 ADD NEW COMMANDS TO ADMIN LIST 💡 ---
        const needsAdmin = [
            '/mute', '/unmute', '/kick', '/pin', '/unpin',
            '/blacklist', '/removeblacklist', '/listblacklist',
            '/welcome' // <-- NEW
        ];
        const commandShouldBeDeleted = [...needsAdmin]; 

        // --- Permission & Deletion Logic ---
        if (needsAdmin.includes(command)) {
            const userIsAdmin = await isAdmin(bot, chatId, fromId);
            if (!userIsAdmin) {
                sendTempMessage(bot, chatId, "You don't have permission to do that.", msg.message_id);
                bot.deleteMessage(chatId, msg.message_id).catch(() => {}); 
                return;
            }
        }
        
        if (commandShouldBeDeleted.includes(command)) {
            bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        }

        // --- Command Logic ---
        try {
            switch (command) {
                
                case '/mute': {
                    // ... (your existing mute logic) ...
                    break;
                }
                case '/unmute': {
                    // ... (your existing unmute logic) ...
                    break;
                }
                case '/kick': {
                    // ... (your existing kick logic) ...
                    break;
                }
                case '/pin': {
                    // ... (your existing pin logic) ...
                    break;
                }
                case '/unpin': {
                    // ... (your existing unpin logic) ...
                    break;
                }
                case '/blacklist': {
                    // ... (your existing blacklist logic) ...
                    break;
                }
                case '/removeblacklist': {
                    // ... (your existing removeblacklist logic) ...
                    break;
                }
                case '/listblacklist': {
                    // ... (your existing listblacklist logic) ...
                    break;
                }
                
                // --- 💡 START OF NEW WELCOME COMMANDS 💡 ---
                case '/welcome': {
                    const subCommand = (args[1] || '').toLowerCase();
                    
                    if (subCommand === 'on') {
                        await dbServices.setGroupWelcome(chatId, true);
                        sendSelfDestructingMessage(bot, chatId, "Welcome messages are now *ON*.", msg.message_id);
                    } else if (subCommand === 'off') {
                        await dbServices.setGroupWelcome(chatId, false);
                        sendSelfDestructingMessage(bot, chatId, "Welcome messages are now *OFF*.", msg.message_id);
                    } else if (subCommand === 'set') {
                        const messageText = text.substring(command.length + 5).trim(); // Get all text after "/welcome set "
                        if (!messageText) {
                            return sendTempMessage(bot, chatId, "Usage: /welcome set (message)\nUse {user} for user's name and {group} for group name.", msg.message_id);
                        }
                        await dbServices.setGroupWelcomeMessage(chatId, messageText);
                        sendSelfDestructingMessage(bot, chatId, `Welcome message has been set and turned *ON*.\n\nNew message:\n${messageText}`, msg.message_id);
                    } else {
                        // Show current status
                        const settings = await dbServices.getGroupSettings(chatId);
                        const status = settings.welcome_enabled ? "ON" : "OFF";
                        const currentMsg = settings.welcome_message || "Default";
                        sendSelfDestructingMessage(bot, chatId,
                            `*Welcome Message Status: ${status}*\n` +
                            `*Current Message:* \`${currentMsg}\`\n\n` +
                            `*Usage:*\n/welcome on\n/welcome off\n/welcome set (your message)`,
                            msg.message_id
                        );
                    }
                    break;
                }
                // --- 💡 END OF NEW WELCOME COMMANDS 💡 ---

            } // end switch
        } catch (error) {
            console.error(`[Group Command Error] ${command}: ${error.message}`);
            if (error.response && error.response.body) {
                const description = error.response.body.description || "An error occurred.";
                sendTempMessage(bot, chatId, `Error: ${description}. Do I have admin rights?`, msg.message_id, 5000);
            }
        }
    });

    console.log("✅ Group Handlers (Minimal + Welcome Toggle) registered successfully.");
}

// Export the main function
module.exports = {
    registerGroupHandlers
};
