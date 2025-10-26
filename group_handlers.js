/**
 * group_handlers.js
 * * This file contains all the event listeners and logic for commands
 * that happen inside a group chat (e.g., welcome, mute, ban, kick, warn).
 */

// --- Configuration ---
const WARN_LIMIT = 3; // How many warnings before a user is auto-kicked.

// --- Helper Functions ---

/**
 * Checks if a user is an admin or creator in a specific chat.
 * @param {TelegramBot} bot - The bot instance.
 * @param {string|number} chatId - The ID of the chat.
 * @param {string|number} userId - The ID of the user to check.
 * @returns {boolean} - True if the user is an admin or creator.
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
 * @param {TelegramBot} bot - The bot instance.
 * @param {string|number} chatId - The ID of the chat.
 * @param {string} text - The text to send.
 * @param {string|number} replyToMessageId - The message ID to reply to.
 * @param {number} duration - How long to wait before deleting (in ms).
 */
const sendTempMessage = (bot, chatId, text, replyToMessageId, duration = 3000) => {
    bot.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId })
        .then(msg => {
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }, duration);
        }).catch(() => {}); // Fail silently
};

// --- Main Registration Function ---

/**
 * Registers all group-related event handlers.
 * @param {TelegramBot} bot - The main bot instance.
 * @param {Object} dbServices - Your database services object.
 */
function registerGroupHandlers(bot, dbServices) {

    // --- 1. Welcome New Members ---
    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;
        const newMembers = msg.new_chat_members;

        for (const member of newMembers) {
            if (member.is_bot) continue; 
            
            // 👋 Customize your welcome message here
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
        
        // ✈️ Customize your goodbye message here
        const goodbyeMessage = `Goodbye, ${member.first_name}.`;
        try {
            await bot.sendMessage(chatId, goodbyeMessage);
        } catch (error) {
            console.error(`Failed to send goodbye message: ${error.message}`);
        }
    });

    // --- 3. Handle ALL Group Commands ---
    bot.on('message', async (msg) => {
        // Ignore messages that aren't from a group or supergroup
        if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
            return;
        }

        const text = msg.text || '';
        // Only process messages that are commands
        if (!text.startsWith('/')) {
            return;
        }

        const chatId = msg.chat.id;
        const fromId = msg.from.id;
        const command = text.split(' ')[0].split('@')[0]; // Gets /command from /command@botname
        const reply = msg.reply_to_message;

        // --- Standard Admin & Reply Checks ---
        const needsAdmin = ['/mute', '/unmute', '/kick', '/ban', '/unban', '/warn', '/pin', '/unpin', '/del'];
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
        
        // Delete the command message to keep chat clean
        if (needsAdmin.includes(command)) {
            bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        }

        // --- Command Logic ---
        try {
            switch (command) {
                // --- Mute ---
                case '/mute': {
                    const userId = reply.from.id;
                    await bot.restrictChatMember(chatId, userId, { can_send_messages: false });
                    await bot.sendMessage(chatId, `🤫 ${reply.from.first_name} has been muted.`);
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
                    // This just deletes the replied-to message.
                    // The command message was already deleted above.
                    await bot.deleteMessage(chatId, reply.message_id);
                    sendTempMessage(bot, chatId, "Message deleted.", msg.message_id, 2000);
                    break;
                }

                // --- Pin Message ---
                case '/pin': {
                    await bot.pinChatMessage(chatId, reply.message_id, { disable_notification: false });
                    break; // No confirmation needed, the pin is obvious
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
            }
        } catch (error) {
            console.error(`[Group Command Error] ${command}: ${error.message}`);
            if (error.response && error.response.body) {
                console.error(error.response.body);
                const description = error.response.body.description || "An error occurred.";
                // Send error to admin
                sendTempMessage(bot, chatId, `Error: ${description}. Do I have admin rights?`, msg.message_id, 5000);
            }
        }
    });

    console.log("✅ All Group Handlers (Expanded) registered successfully.");
}

// Export the main function
module.exports = {
    registerGroupHandlers
};
