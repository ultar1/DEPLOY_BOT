// In group_handlers.js (REPLACE THE ENTIRE FILE)

let bot;
let dbServices;
let escapeMarkdown;

// --- Helper Functions ---
// (These are now internal to this file)

const parseDuration = (durationStr) => {
    if (!durationStr) return null;
    const match = durationStr.match(/^(\d+)([mhd])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    const now = Math.floor(Date.now() / 1000);
    switch (unit) {
        case 'm': return now + (value * 60);
        case 'h': return now + (value * 60 * 60);
        case 'd': return now + (value * 24 * 60 * 60);
        default: return null;
    }
};

const isAdmin = async (bot, chatId, userId) => {
    try {
        const member = await bot.getChatMember(chatId, userId);
        return ['administrator', 'creator'].includes(member.status);
    } catch (error) {
        return false;
    }
};

const sendTempMessage = (bot, chatId, text, replyToMessageId, duration = 5000) => {
    bot.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId })
        .then(msg => {
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }, duration);
        }).catch(() => {});
};

const sendSelfDestructingMessage = (bot, chatId, text, replyToMessageId) => {
    const duration = 300000; // 5 minutes
    bot.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId })
        .then(msg => {
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }, duration);
        }).catch(() => {});
};

const getTarget = async (bot, msg, args) => {
    const chatId = msg.chat.id;
    if (msg.reply_to_message) {
        return {
            id: msg.reply_to_message.from.id,
            name: msg.reply_to_message.from.first_name,
            isReply: true
        };
    }
    const targetArg = args[1];
    if (targetArg && /^\d{5,}$/.test(targetArg)) {
        try {
            const member = await bot.getChatMember(chatId, targetArg);
            return { id: member.user.id, name: member.user.first_name, isReply: false };
        } catch (e) {
            return { error: "Could not find user with that ID." };
        }
    }
    return { error: "Please reply to a user or provide their User ID." };
};


// --- Main Handler Functions (Exported) ---

/**
 * 1. HANDLER FOR NEW MEMBERS (WELCOME & BLACKLIST CHECK)
 * This is called by bot.js
 */
async function handleNewMembers(msg) {
    const chatId = msg.chat.id;
    let blacklistedNames = [];
    let groupSettings;

    try {
        blacklistedNames = await dbServices.getBlacklistedNames(chatId);
        groupSettings = await dbServices.getGroupSettings(chatId);
    } catch (e) {
        console.error("Failed to fetch group settings:", e.message);
        return;
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
                continue; // Skip welcome
            }
        }
        
        // --- WELCOME CHECK ---
        if (groupSettings.welcome_enabled) {
            let welcomeMessage = groupSettings.welcome_message || `Hello {user}, welcome to the group!`;
            const finalMessage = welcomeMessage
                .replace(/{user}/g, member.first_name)
                .replace(/{group}/g, msg.chat.title || 'the group');

            try {
                await bot.sendMessage(chatId, finalMessage);
            } catch (error) {
                console.error(`Failed to send welcome message: ${error.message}`);
            }
        }
    }
}

/**
 * 2. HANDLER FOR LEAVING MEMBERS (GOODBYE)
 * This is called by bot.js
 */
async function handleLeftMembers(msg) {
    const chatId = msg.chat.id;
    const member = msg.left_chat_member;
    if (member.is_bot) return;
    const goodbyeMessage = `Goodbye, ${member.first_name}.`;
    try {
        await bot.sendMessage(chatId, goodbyeMessage);
    } catch (error) {
        console.error(`Failed to send goodbye message: ${error.message}`);
    }
}

/**
 * 3. HANDLER FOR GROUP COMMANDS
 * This is called by bot.js
 */
async function handleGroupCommand(msg) {
    const text = msg.text || '';
    if (!text.startsWith('/')) return; // Only handle commands

    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const args = text.split(' ');
    const command = args[0].split('@')[0];
    const reply = msg.reply_to_message;

    const needsAdmin = [
        '/mute', '/unmute', '/kick', '/pin', '/unpin',
        '/blacklist', '/removeblacklist', '/listblacklist', '/welcome'
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
                const target = await getTarget(bot, msg, args);
                if (target.error) return sendTempMessage(bot, chatId, target.error, msg.message_id);
                
                const userId = target.id;
                const durationStr = target.isReply ? args[1] : args[2]; 
                const until_date = parseDuration(durationStr);
                
                const permissions = { can_send_messages: false };
                let muteMessage = (until_date) ? 
                    `${target.name} has been muted for ${durationStr}.` : 
                    `${target.name} has been muted permanently.`;
                
                if(until_date) permissions.until_date = until_date;
                
                await bot.restrictChatMember(chatId, userId, permissions);
                sendSelfDestructingMessage(bot, chatId, muteMessage, msg.message_id);
                break;
            }

            case '/unmute': {
                const target = await getTarget(bot, msg, args);
                if (target.error) return sendTempMessage(bot, chatId, target.error, msg.message_id);

                await bot.restrictChatMember(chatId, target.id, {
                    can_send_messages: true, can_send_media_messages: true,
                    can_send_other_messages: true, can_add_web_page_previews: true
                });
                sendSelfDestructingMessage(bot, chatId, `${target.name} has been unmuted.`, msg.message_id);
                break;
            }

            case '/kick': {
                const target = await getTarget(bot, msg, args);
                if (target.error) return sendTempMessage(bot, chatId, target.error, msg.message_id);
                
                await bot.banChatMember(chatId, target.id);
                await bot.unbanChatMember(chatId, target.id);
                sendSelfDestructingMessage(bot, chatId, `${target.name} has been kicked.`, msg.message_id);
                break;
            }
            
            case '/pin': {
                if (!reply) return sendTempMessage(bot, chatId, `Please reply to a message to use ${command}.`, msg.message_id);
                await bot.pinChatMessage(chatId, reply.message_id, { disable_notification: false });
                break;
            }

            case '/unpin': {
                if (!reply) return sendTempMessage(bot, chatId, `Please reply to a message to use ${command}.`, msg.message_id);
                await bot.unpinChatMessage(chatId, { message_id: reply.message_id });
                sendTempMessage(bot, chatId, "Message unpinned.", msg.message_id, 2000);
                break;
            }

            case '/blacklist': {
                const nameFragment = args.slice(1).join(' ');
                if (!nameFragment) return sendTempMessage(bot, chatId, "Usage: /blacklist (name fragment)", msg.message_id);
                if (nameFragment.length < 3) return sendTempMessage(bot, chatId, "Fragment must be 3+ characters.", msg.message_id);

                await dbServices.addBlacklistedName(chatId, nameFragment, fromId);
                sendSelfDestructingMessage(bot, chatId, `\`${escapeMarkdown(nameFragment)}\` added to blacklist.`, msg.message_id);
                break;
            }

            case '/removeblacklist': {
                const nameFragment = args.slice(1).join(' ');
                if (!nameFragment) return sendTempMessage(bot, chatId, "Usage: /removeblacklist (name fragment)", msg.message_id);
                
                const result = await dbServices.removeBlacklistedName(chatId, nameFragment);
                if (result.success) {
                    sendSelfDestructingMessage(bot, chatId, `\`${escapeMarkdown(nameFragment)}\` removed from blacklist.`, msg.message_id);
                } else {
                    sendTempMessage(bot, chatId, `\`${escapeMarkdown(nameFragment)}\` not found in blacklist.`, msg.message_id);
                }
                break;
            }

            case '/listblacklist': {
                const blacklist = await dbServices.getBlacklistedNames(chatId);
                if (blacklist.length === 0) return sendSelfDestructingMessage(bot, chatId, "The blacklist is empty.", msg.message_id);

                let message = "*Blacklisted Name Fragments:*\n\n" + blacklist.map(name => `• \`${escapeMarkdown(name)}\``).join('\n');
                sendSelfDestructingMessage(bot, chatId, message, msg.message_id);
                break;
            }

            case '/welcome': {
                const subCommand = (args[1] || '').toLowerCase();
                
                if (subCommand === 'on') {
                    await dbServices.setGroupWelcome(chatId, true);
                    sendSelfDestructingMessage(bot, chatId, "Welcome messages are now *ON*.", msg.message_id);
                } else if (subCommand === 'off') {
                    await dbServices.setGroupWelcome(chatId, false);
                    sendSelfDestructingMessage(bot, chatId, "Welcome messages are now *OFF*.", msg.message_id);
                } else if (subCommand === 'set') {
                    const messageText = text.substring(command.length + 5).trim();
                    if (!messageText) return sendTempMessage(bot, cid, "Usage: /welcome set (message)\nUse {user} and {group}.", msg.message_id);
                    
                    await dbServices.setGroupWelcomeMessage(chatId, messageText);
                    sendSelfDestructingMessage(bot, chatId, `Welcome message has been set and turned *ON*.`, msg.message_id);
                } else {
                    const settings = await dbServices.getGroupSettings(chatId);
                    const status = settings.welcome_enabled ? "ON" : "OFF";
                    const currentMsg = settings.welcome_message || "Default";
                    sendSelfDestructingMessage(bot, chatId,
                        `*Welcome Status: ${status}*\n*Message:* \`${currentMsg}\`\n\n*Usage:*\n/welcome on\n/welcome off\n/welcome set (message)`,
                        msg.message_id
                    );
                }
                break;
            }

        } // end switch
    } catch (error) {
        console.error(`[Group Command Error] ${command}: ${error.message}`);
        if (error.response && error.response.body) {
            sendTempMessage(bot, chatId, `Error: ${error.response.body.description}. Do I have admin rights?`, msg.message_id, 5000);
        }
    }
}

/**
 * 4. INITIALIZATION FUNCTION
 * This is called by bot.js and passes in all dependencies.
 */
function registerGroupHandlers(_bot, _dbServices) {
    bot = _bot;
    dbServices = _dbServices;
    
    // Set escapeMarkdown
    escapeMarkdown = (text) => text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
    if (dbServices && dbServices.escapeMarkdown) {
        escapeMarkdown = dbServices.escapeMarkdown;
    }

    // Return the functions for bot.js to use
    return {
        handleGroupMessage,
        handleNewMembers,
        handleLeftMembers
    };
}

module.exports = {
    registerGroupHandlers
};
