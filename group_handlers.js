/**
 * group_handlers.js (V4)
 * * All deployment-service features REMOVED.
 * * NEW: Admin/GPT commands are auto-deleted.
 * * NEW: Bot replies to commands self-destruct after 5 minutes.
 * * NEW: Admin commands support targeting by User ID (e.g., /kick 123456789)
 */

// --- Configuration ---
const WARN_LIMIT = 3; // How many warnings before a user is auto-kicked.
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000; // 6 months in milliseconds
let callGemini; // This will be set by the main bot file

// --- Helper Functions ---

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

function registerGroupHandlers(bot, dbServices, geminiFunction) {
    
    callGemini = geminiFunction;

    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;
        for (const member of msg.new_chat_members) {
            if (member.is_bot) continue; 
            const welcomeMessage = `Hello ${member.first_name}, welcome to the group!`;
            try {
                // This welcome message can stay
                await bot.sendMessage(chatId, welcomeMessage);
            } catch (error) {
                console.error(`Failed to send welcome message: ${error.message}`);
            }
        }
    });

    bot.on('left_chat_member', async (msg) => {
        const chatId = msg.chat.id;
        const member = msg.left_chat_member;
        if (member.is_bot) return;
        const goodbyeMessage = `Goodbye, ${member.first_name}.`;
        try {
            // This goodbye message can stay
            await bot.sendMessage(chatId, goodbyeMessage);
        } catch (error) {
            console.error(`Failed to send goodbye message: ${error.message}`);
        }
    });

    bot.on('message', async (msg) => {
        if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
            return;
        }

        const text = msg.text || '';
        const chatId = msg.chat.id;
        const fromId = msg.from.id;
        const fromName = msg.from.first_name;
        const timestamp = msg.date;

        if (!text.startsWith('/') && dbServices.logUserActivity) {
            try {
                await dbServices.logUserActivity(fromId, chatId, fromName, timestamp);
            } catch (error) {
                console.error(`Failed to log user activity: ${error.message}`);
            }
        }

        if (!text.startsWith('/')) {
            return;
        }

        const args = text.split(' ');
        const command = args[0].split('@')[0];
        const reply = msg.reply_to_message;

        const needsAdmin = ['/mute', '/unmute', '/kick', '/ban', '/unban', '/warn', '/pin', '/unpin', '/del', '/kick_inactive'];
        const commandNeedsTarget = ['/mute', '/unmute', '/kick', '/ban', '/unban', '/warn'];
        const commandShouldBeDeleted = [...needsAdmin, '/gpt'];

        // --- Permission & Deletion Logic ---
        if (needsAdmin.includes(command)) {
            const userIsAdmin = await isAdmin(bot, chatId, fromId);
            if (!userIsAdmin) {
                sendTempMessage(bot, chatId, "You don't have permission to do that.", msg.message_id);
                bot.deleteMessage(chatId, msg.message_id).catch(() => {}); // Delete unauthorized command
                return;
            }
        }
        
        // NEW: Delete commands that should be deleted
        if (commandShouldBeDeleted.includes(command)) {
            bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        }

        // --- Command Logic ---
        try {
            switch (command) {
                // --- Mute (UPGRADED) ---
                case '/mute': {
                    const target = await getTarget(bot, msg, args);
                    if (target.error) {
                        return sendTempMessage(bot, chatId, target.error, msg.message_id);
                    }
                    
                    const userId = target.id;
                    const durationStr = target.isReply ? args[1] : args[2]; // Arg shifts
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
                    sendSelfDestructingMessage(bot, chatId, muteMessage, msg.message_id); // 5 min reply
                    break;
                }

                // --- Unmute (UPGRADED) ---
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

                // --- Kick (UPGRADED) ---
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

                // --- Ban (UPGRADED) ---
                case '/ban': {
                    const target = await getTarget(bot, msg, args);
                    if (target.error) {
                        return sendTempMessage(bot, chatId, target.error, msg.message_id);
                    }

                    await bot.banChatMember(chatId, target.id);
                    sendSelfDestructingMessage(bot, chatId, `${target.name} has been permanently banned.`, msg.message_id);
                    break;
                }

                // --- Unban (UPGRADED) ---
                case '/unban': {
                    const target = await getTarget(bot, msg, args);
                    if (target.error) {
                        return sendTempMessage(bot, chatId, target.error, msg.message_id);
                    }

                    await bot.unbanChatMember(chatId, target.id);
                    sendSelfDestructingMessage(bot, chatId, `${target.name} has been unbanned and can re-join.`, msg.message_id);
                    break;
                }
                
                // --- Delete Message (Requires Reply) ---
                case '/del': {
                    if (!reply) {
                        return sendTempMessage(bot, chatId, `Please reply to a message to use the ${command} command.`, msg.message_id);
                    }
                    await bot.deleteMessage(chatId, reply.message_id).catch(() => {});
                    sendTempMessage(bot, chatId, "Message deleted.", msg.message_id, 2000);
                    break;
                }

                // --- Pin Message (Requires Reply) ---
                case '/pin': {
                    if (!reply) {
                        return sendTempMessage(bot, chatId, `Please reply to a message to use the ${command} command.`, msg.message_id);
                    }
                    await bot.pinChatMessage(chatId, reply.message_id, { disable_notification: false });
                    break;
                }

                // --- Unpin Message (Requires Reply) ---
                case '/unpin': {
                    if (!reply) {
                        return sendTempMessage(bot, chatId, `Please reply to a message to use the ${command} command.`, msg.message_id);
                    }
                    await bot.unpinChatMessage(chatId, { message_id: reply.message_id });
                    sendTempMessage(bot, chatId, "Message unpinned.", msg.message_id, 2000);
                    break;
                }

                // --- Warn User (UPGRADED) ---
                case '/warn': {
                    if (!dbServices.addWarning) {
                        return sendTempMessage(bot, chatId, "Error: Warning system not configured in dbServices.", msg.message_id);
                    }
                    
                    const target = await getTarget(bot, msg, args);
                    if (target.error) {
                        return sendTempMessage(bot, chatId, target.error, msg.message_id);
                    }
                    
                    const { newWarningCount } = await dbServices.addWarning(target.id, chatId);

                    if (newWarningCount >= WARN_LIMIT) {
                        await bot.banChatMember(chatId, target.id);
                        await bot.unbanChatMember(chatId, target.id);
                        await dbServices.clearWarnings(target.id, chatId);
                        sendSelfDestructingMessage(bot, chatId, `${target.name} has been auto-kicked after receiving ${WARN_LIMIT} warnings.`, msg.message_id);
                    } else {
                        sendSelfDestructingMessage(bot, chatId, `${target.name} has been warned. This is warning ${newWarningCount}/${WARN_LIMIT}.`, msg.message_id);
                    }
                    break;
                }

                // --- GPT (UPGRADED) ---
                case '/gpt': {
                    let question = '';
                    
                    if (reply) {
                        question = reply.text;
                    } else if (args.length > 1) {
                        question = text.substring(command.length).trim();
                    } else {
                        return sendTempMessage(bot, chatId, "Please reply to a message or type your question after /gpt.", msg.message_id);
                    }

                    if (!callGemini) {
                        return sendSelfDestructingMessage(bot, chatId, "Error: The AI module is not connected.", msg.message_id);
                    }

                    // Show "Thinking..." (and delete it after 5 mins)
                    const thinkingMsg = await bot.sendMessage(chatId, "Thinking...", { reply_to_message_id: msg.message_id });
                    const thinkingMsgId = thinkingMsg.message_id;
                    
                    setTimeout(() => {
                        bot.deleteMessage(chatId, thinkingMsgId).catch(() => {});
                    }, 300000); // 5 minutes

                    try {
                        const answer = await callGemini(question);
                        // Edit the "Thinking..." message to the final answer
                        await bot.editMessageText(answer, {
                            chat_id: chatId,
                            message_id: thinkingMsgId,
                            parse_mode: 'Markdown'
                        });
                    } catch (error) {
                        await bot.editMessageText(`Sorry, I had trouble getting an answer. ${error.message}`, {
                            chat_id: chatId,
                            message_id: thinkingMsgId
                        });
                    }
                    break;
                }
                
                // --- Stats (UPGRADED) ---
                case '/stats': {
                    if (!dbServices.getChatStats) {
                        return sendTempMessage(bot, chatId, "Error: Stats module not configured in dbServices.", msg.message_id);
                    }
                    
                    const inactiveTime = Date.now() - SIX_MONTHS_MS;
                    const stats = await dbServices.getChatStats(chatId, Math.floor(inactiveTime / 1000));
                    
                    const statsMessage = `*Group Stats*\n\nActive (last 6 months): ${stats.activeCount}\nInactive (over 6 months): ${stats.inactiveCount}\n\n*Note:* I can only track users who have sent a message since I was added.`;
                    
                    sendSelfDestructingMessage(bot, chatId, statsMessage, { parse_mode: 'Markdown' });
                    break;
                }

                // --- Kick Inactive (UPGRADED) ---
                case '/kick_inactive': {
                    if (!dbServices.getInactiveUsers) {
                        return sendTempMessage(bot, chatId, "Error: Stats module not configured in dbServices.", msg.message_id);
                    }
                    
                    const inactiveTime = Date.now() - SIX_MONTHS_MS;
                    const inactiveUsers = await dbServices.getInactiveUsers(chatId, Math.floor(inactiveTime / 1000));

                    if (inactiveUsers.length === 0) {
                        return sendSelfDestructingMessage(bot, chatId, "No inactive users found to kick.", msg.message_id);
                    }

                    const statusMsg = await bot.sendMessage(chatId, `Found ${inactiveUsers.length} inactive users. Starting removal...`);
                    
                    let successCount = 0;
                    let failCount = 0;

                    for (const user of inactiveUsers) {
                        try {
                            await bot.banChatMember(chatId, user.user_id);
                            await bot.unbanChatMember(chatId, user.user_id);
                            successCount++;
                        } catch (error) {
                            failCount++;
                            console.error(`Failed to kick ${user.user_name}: ${error.message}`);
                        }
                    }
                    
                    await bot.editMessageText(`*Inactive User Purge Complete*\n\nKicked: ${successCount}\nFailed: ${failCount}`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id,
                        parse_mode: 'Markdown'
                    });
                    // Make the final summary message also self-destruct
                    setTimeout(() => {
                        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
                    }, 300000);
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

    console.log("✅ Group Handlers (V4) registered successfully.");
}

// Export the main function
module.exports = {
    registerGroupHandlers
};
