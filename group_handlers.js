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

    // Add escapeMarkdown from the dbServices object
    escapeMarkdown = (text) => text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&'); // Basic fallback
    if (dbServices && dbServices.escapeMarkdown) {
        escapeMarkdown = dbServices.escapeMarkdown;
    }

    /**
     * 1. HANDLER FOR NEW MEMBERS (WELCOME & BLACKLIST CHECK)
     */
    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;

        // Get the blacklist for this specific group
        let blacklistedNames = [];
        try {
            blacklistedNames = await dbServices.getBlacklistedNames(chatId);
        } catch (e) {
            console.error("Failed to fetch blacklist:", e.message);
        }

        for (const member of msg.new_chat_members) {
            if (member.is_bot) continue; 

            // --- BLACKLIST LOGIC ---
            if (blacklistedNames.length > 0) {
                const firstName = (member.first_name || '').toLowerCase();
                const lastName = (member.last_name || '').toLowerCase();
                const username = (member.username || '').toLowerCase();

                // Check if any part of the user's name matches a blacklisted fragment
                const isBlacklisted = blacklistedNames.some(fragment => 
                    firstName.includes(fragment) ||
                    lastName.includes(fragment) ||
                    username.includes(fragment)
                );

                if (isBlacklisted) {
                    try {
                        // Kick the user
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
            // --- END BLACKLIST LOGIC ---

            // Send Welcome Message
            const welcomeMessage = `Hello ${member.first_name}, welcome to the group!`;
            try {
                await bot.sendMessage(chatId, welcomeMessage);
            } catch (error) {
                console.error(`Failed to send welcome message: ${error.message}`);
            }
        }
    });

    /**
     * 2. HANDLER FOR LEAVING MEMBERS (GOODBYE)
     */
    bot.on('left_chat_member', async (msg) => {
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

        // --- List of allowed commands ---
        const needsAdmin = [
            '/mute', '/unmute', '/kick', '/pin', '/unpin',
            '/blacklist', '/removeblacklist', '/listblacklist'
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
                    if (target.error) {
                        return sendTempMessage(bot, chatId, target.error, msg.message_id);
                    }
                    
                    const userId = target.id;
                    const durationStr = target.isReply ? args[1] : args[2]; 
                    const until_date = parseDuration(durationStr);
                    
                    const permissions = { can_send_messages: false };
                    let muteMessage;

                    if (until_date) {
                        permissions.until_date = until_date;
                        muteMessage = `${target.name} has been muted for ${durationStr}.`;
                    } else {
                        muteMessage = `${target.name} has been muted permanently.`;
                    }
                    
                    await bot.restrictChatMember(chatId, userId, permissions);
                    sendSelfDestructingMessage(bot, chatId, muteMessage, msg.message_id);
                    break;
                }

                case '/unmute': {
                    const target = await getTarget(bot, msg, args);
                    if (target.error) {
                        return sendTempMessage(bot, chatId, target.error, msg.message_id);
                    }

                    await bot.restrictChatMember(chatId, target.id, {
                        can_send_messages: true,
                        can_send_media_messages: true,
                        can_send_other_messages: true,
                        can_add_web_page_previews: true
                    });
                    sendSelfDestructingMessage(bot, chatId, `${target.name} has been unmuted.`, msg.message_id);
                    break;
                }

                case '/kick': {
                    const target = await getTarget(bot, msg, args);
                    if (target.error) {
                        return sendTempMessage(bot, chatId, target.error, msg.message_id);
                    }
                    
                    await bot.banChatMember(chatId, target.id);
                    await bot.unbanChatMember(chatId, target.id);
                    sendSelfDestructingMessage(bot, chatId, `${target.name} has been kicked.`, msg.message_id);
                    break;
                }
                
                case '/pin': {
                    if (!reply) {
                        return sendTempMessage(bot, chatId, `Please reply to a message to use the ${command} command.`, msg.message_id);
                    }
                    await bot.pinChatMessage(chatId, reply.message_id, { disable_notification: false });
                    break;
                }

                case '/unpin': {
                    if (!reply) {
                        return sendTempMessage(bot, chatId, `Please reply to a message to use the ${command} command.`, msg.message_id);
                    }
                    await bot.unpinChatMessage(chatId, { message_id: reply.message_id });
                    sendTempMessage(bot, chatId, "Message unpinned.", msg.message_id, 2000);
                    break;
                }

                case '/blacklist': {
                    const nameFragment = args.slice(1).join(' ');
                    if (!nameFragment) {
                        return sendTempMessage(bot, chatId, "Usage: /blacklist (name fragment)\nExample: /blacklist spammer", msg.message_id);
                    }
                    
                    if (nameFragment.length < 3) {
                        return sendTempMessage(bot, chatId, "Blacklist fragment must be at least 3 characters long.", msg.message_id);
                    }

                    const result = await dbServices.addBlacklistedName(chatId, nameFragment, fromId);
                    if (result.success) {
                        sendSelfDestructingMessage(bot, chatId, `\`${escapeMarkdown(nameFragment)}\` has been added to the blacklist.`, msg.message_id);
                    } else {
                        sendTempMessage(bot, chatId, "Failed to add to blacklist. Check logs.", msg.message_id);
                    }
                    break;
                }

                case '/removeblacklist': {
                    const nameFragment = args.slice(1).join(' ');
                    if (!nameFragment) {
                        return sendTempMessage(bot, chatId, "Usage: /removeblacklist (name fragment)", msg.message_id);
                    }
                    
                    const result = await dbServices.removeBlacklistedName(chatId, nameFragment);
                    if (result.success) {
                        sendSelfDestructingMessage(bot, chatId, `\`${escapeMarkdown(nameFragment)}\` has been removed from the blacklist.`, msg.message_id);
                    } else {
                        sendTempMessage(bot, chatId, `Failed to remove \`${escapeMarkdown(nameFragment)}\`. It may not be on the list.`, msg.message_id);
                    }
                    break;
                }

                case '/listblacklist': {
                    const blacklist = await dbServices.getBlacklistedNames(chatId);
                    if (blacklist.length === 0) {
                        return sendSelfDestructingMessage(bot, chatId, "The blacklist for this group is currently empty.", msg.message_id);
                    }

                    let message = "*Blacklisted Name Fragments:*\n\n";
                    blacklist.forEach(name => {
                        message += `• \`${escapeMarkdown(name)}\`\n`;
                    });

                    sendSelfDestructingMessage(bot, chatId, message, msg.message_id);
                    break;
                }

            } // end switch
        } catch (error) {
            console.error(`[Group Command Error] ${command}: ${error.message}`);
            if (error.response && error.response.body) {
                const description = error.response.body.description || "An error occurred.";
                sendTempMessage(bot, chatId, `Error: ${description}. Do I have admin rights?`, msg.message_id, 5000);
            }
        }
    });

    console.log("✅ Group Handlers (Minimal) registered successfully.");
}

// Export the main function
module.exports = {
    registerGroupHandlers
};
