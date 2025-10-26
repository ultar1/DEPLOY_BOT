/**
 * group_handlers.js (V3 - Cleaned)
 * * Contains all group moderation features (timed mutes, /gpt, stats, kick)
 * * All deployment-service features have been REMOVED.
 */

// --- Configuration ---
const WARN_LIMIT = 3; // How many warnings before a user is auto-kicked.
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000; // 6 months in milliseconds for inactivity
let callGemini; // This will be set by the main bot file

// --- Helper Functions ---

/**
 * Parses a duration string (e.g., "5m", "1h", "3d") into a UNIX timestamp.
 * @param {string} durationStr - The duration string.
 * @returns {number|null} - The UNIX timestamp (in seconds) for when the mute ends, or null.
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
 * A helper to quickly send and delete a reply message.
 */
const sendTempMessage = (bot, chatId, text, replyToMessageId, duration = 3000) => {
    bot.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId })
        .then(msg => {
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }, duration);
        }).catch(() => {});
};

// --- Main Registration Function ---

/**
 * Registers all group-related event handlers.
 * @param {TelegramBot} bot - The main bot instance.
 * @param {Object} dbServices - Your database services object.
 * @param {Function} geminiFunction - The function from your main file to call the Gemini API.
 */
function registerGroupHandlers(bot, dbServices, geminiFunction) {
    
    // Connect the Gemini function
    callGemini = geminiFunction;

    // --- 1. Welcome New Members ---
    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;
        const newMembers = msg.new_chat_members;

        for (const member of newMembers) {
            if (member.is_bot) continue; 
            
            const welcomeMessage = `Hello ${member.first_name}, welcome to the group!`;
            try {
                await bot.sendMessage(chatId, welcomeMessage);
            } catch (error) {
                console.error(`Failed to send welcome message: ${error.message}`);
            }
        }
    });

    // --- 2. Handle Members Leaving ---
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

    // --- 3. Handle ALL Group Messages (for Stats and Commands) ---
    bot.on('message', async (msg) => {
        // Ignore messages that aren't from a group or supergroup
        if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
            return;
        }

        const text = msg.text || '';
        const chatId = msg.chat.id;
        const fromId = msg.from.id;
        const fromName = msg.from.first_name;
        const timestamp = msg.date;

        // --- User Activity Logging (FOR /stats and /kick_inactive) ---
        if (!text.startsWith('/') && dbServices.logUserActivity) {
            // Log activity for any non-command message
            try {
                await dbServices.logUserActivity(fromId, chatId, fromName, timestamp);
            } catch (error) {
                console.error(`Failed to log user activity: ${error.message}`);
            }
        }

        // --- Command Processing ---
        if (!text.startsWith('/')) {
            return; // Not a command, stop here
        }

        const args = text.split(' ');
        const command = args[0].split('@')[0]; // Gets /command from /command@botname
        const reply = msg.reply_to_message;

        // --- Admin & Reply Checks ---
        const needsAdmin = ['/mute', '/unmute', '/kick', '/ban', '/unban', '/warn', '/pin', '/unpin', '/del', '/kick_inactive'];
        const needsReply = ['/mute', '/unmute', '/kick', '/ban', '/unban', '/warn', '/pin', '/unpin', '/del'];
        
        if (needsAdmin.includes(command)) {
            const userIsAdmin = await isAdmin(bot, chatId, fromId);
            if (!userIsAdmin) {
                return sendTempMessage(bot, chatId, "You don't have permission to do that.", msg.message_id);
            }
        }
        
        if (needsReply.includes(command)) {
            if (!reply) {
                return sendTempMessage(bot, chatId, `Please reply to a user/message to use the ${command} command.`, msg.message_id);
            }
        }
        
        // Delete the admin command message to keep chat clean
        if (needsAdmin.includes(command)) {
            bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        }

        // --- Command Logic ---
        try {
            switch (command) {
                // --- Mute (UPGRADED) ---
                case '/mute': {
                    const userId = reply.from.id;
                    const durationStr = args[1]; // "5m", "1h", "3d"
                    const until_date = parseDuration(durationStr);
                    
                    const permissions = { can_send_messages: false };
                    let muteMessage;

                    if (until_date) {
                        // Timed mute
                        permissions.until_date = until_date;
                        muteMessage = `${reply.from.first_name} has been muted for ${durationStr}.`;
                    } else {
                        // Permanent mute
                        muteMessage = `${reply.from.first_name} has been muted permanently.`;
                    }
                    
                    await bot.restrictChatMember(chatId, userId, permissions);
                    await bot.sendMessage(chatId, muteMessage);
                    break;
                }

                // --- Unmute ---
                case '/unmute': {
                    const userId = reply.from.id;
                    await bot.restrictChatMember(chatId, userId, {
                        can_send_messages: true,
                        can_send_media_messages: true,
                        can_send_other_messages: true,
                        can_add_web_page_previews: true
                    });
                    await bot.sendMessage(chatId, `${reply.from.first_name} has been unmuted.`);
                    break;
                }

                // --- Kick (Ban + Unban) ---
                case '/kick': {
                    const userId = reply.from.id;
                    const userName = reply.from.first_name;
                    await bot.banChatMember(chatId, userId); // Kicks them
                    await bot.unbanChatMember(chatId, userId); // Immediately unbans, so they can re-join
                    await bot.sendMessage(chatId, `${userName} has been kicked.`);
                    break;
                }

                // --- Ban (Permanent) ---
                case '/ban': {
                    const userId = reply.from.id;
                    const userName = reply.from.first_name;
                    await bot.banChatMember(chatId, userId);
                    await bot.sendMessage(chatId, `${userName} has been permanently banned.`);
                    break;
                }

                // --- Unban ---
                case '/unban': {
                    const userId = reply.from.id;
                    const userName = reply.from.first_name;
                    await bot.unbanChatMember(chatId, userId);
                    await bot.sendMessage(chatId, `${userName} has been unbanned and can re-join.`);
                    break;
                }
                
                // --- Delete Message ---
                case '/del': {
                    await bot.deleteMessage(chatId, reply.message_id);
                    sendTempMessage(bot, chatId, "Message deleted.", msg.message_id, 2000);
                    break;
                }

                // --- Pin Message ---
                case '/pin': {
                    await bot.pinChatMessage(chatId, reply.message_id, { disable_notification: false });
                    break;
                }

                // --- Unpin Message ---
                case '/unpin': {
                    await bot.unpinChatMessage(chatId, { message_id: reply.message_id });
                    sendTempMessage(bot, chatId, "Message unpinned.", msg.message_id, 2000);
                    break;
                }

                // --- Warn User ---
                case '/warn': {
                    if (!dbServices.addWarning) {
                        return bot.sendMessage(chatId, "Error: Warning system not configured in dbServices.");
                    }
                    
                    const userId = reply.from.id;
                    const userName = reply.from.first_name;
                    
                    const { newWarningCount } = await dbServices.addWarning(userId, chatId);

                    if (newWarningCount >= WARN_LIMIT) {
                        // Auto-kick
                        await bot.banChatMember(chatId, userId);
                        await bot.unbanChatMember(chatId, userId);
                        await dbServices.clearWarnings(userId, chatId);
                        await bot.sendMessage(chatId, `${userName} has been auto-kicked after receiving ${WARN_LIMIT} warnings.`);
                    } else {
                        // Just send warning
                        await bot.sendMessage(chatId, `${userName} has been warned. This is warning ${newWarningCount}/${WARN_LIMIT}.`);
                    }
                    break;
                }

                // --- GPT (NEW) ---
                case '/gpt': {
                    let question = '';
                    
                    if (reply) {
                        // 1. Check for replied-to message
                        question = reply.text;
                    } else if (args.length > 1) {
                        // 2. Check for text after /gpt
                        question = text.substring(command.length).trim();
                    } else {
                        // 3. No question found
                        return sendTempMessage(bot, chatId, "Please reply to a message or type your question after /gpt.", msg.message_id);
                    }

                    if (!callGemini) {
                        return bot.sendMessage(chatId, "Error: The AI module is not connected.", { reply_to_message_id: msg.message_id });
                    }

                    // Show "Bot is thinking..."
                    const thinkingMsg = await bot.sendMessage(chatId, "Thinking...", { reply_to_message_id: msg.message_id });

                    try {
                        const answer = await callGemini(question);
                        await bot.editMessageText(answer, {
                            chat_id: chatId,
                            message_id: thinkingMsg.message_id,
                            parse_mode: 'Markdown'
                        });
                    } catch (error) {
                        await bot.editMessageText(`Sorry, I had trouble getting an answer. ${error.message}`, {
                            chat_id: chatId,
                            message_id: thinkingMsg.message_id
                        });
                    }
                    break;
                }
                
                // --- Stats (NEW) ---
                case '/stats': {
                    if (!dbServices.getChatStats) {
                        return bot.sendMessage(chatId, "Error: Stats module not configured in dbServices.");
                    }
                    
                    const inactiveTime = Date.now() - SIX_MONTHS_MS;
                    const stats = await dbServices.getChatStats(chatId, Math.floor(inactiveTime / 1000));
                    
                    const statsMessage = `*Group Stats*\n\nActive (last 6 months): ${stats.activeCount}\nInactive (over 6 months): ${stats.inactiveCount}\n\n*Note:* I can only track users who have sent a message since I was added.`;
                    
                    await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
                    break;
                }

                // --- Kick Inactive (NEW) ---
                case '/kick_inactive': {
                    if (!dbServices.getInactiveUsers) {
                        return bot.sendMessage(chatId, "Error: Stats module not configured in dbServices.");
                    }
                    
                    await bot.editMessageText(`*Inactive User Purge Complete*\n\nKicked: ${successCount}\nFailed: ${failCount}`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id,
                        parse_mode: 'Markdown'
                    });
                    break;
                }
            }
        } catch (error) {
            console.error(`[Group Command Error] ${command}: ${error.message}`);
            if (error.response && error.response.body) {
                const description = error.response.body.description || "An error occurred.";
                sendTempMessage(bot, chatId, `Error: ${description}. Do I have admin rights?`, msg.message_id, 5000);
            }
        }
    });

    console.log("✅ Group Handlers (Cleaned) registered successfully.");
}

// Export the main function
module.exports = {
    registerGroupHandlers
};
