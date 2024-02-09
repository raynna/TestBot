require('dotenv').config();
axios = require('axios');

const Settings = require('../settings/Settings');
const settings = new Settings();

const {getData, RequestType} = require('../requests/Request');
const request = require('../requests/Request');

const {getFontStyle} = require('./Fonts');
const {getMapName} = require("./MapUtils");

const { info } = require('../log/Logger');

let maintenance = {player: null, maintenance: false};

async function checkMaintenance(client, connectedChannels) {
    try {
        const {data: maintenanceData, errorMessage: maintenanceError} = await getData(RequestType.Maintenance);
        for (const connected of connectedChannels) {
            if (maintenanceError) {
                continue;
            }
            if (!maintenanceData) {
                if (maintenance[connected]) {
                    maintenance[connected] = false;
                    await sendMessage(client, connected, 'Esportal maintenance is now complete, You should now be able to play again!');
                    continue;
                }
            }
            if (maintenanceData) {
                if (!maintenance[connected]) {
                    maintenance[connected] = true;
                    await sendMessage(client, connected, `Maintenance: ${maintenanceData}`);
                }
            }
        }
    } catch (error) {
        console.log(error);
    }
}

let previousGathers = null;

function findChangedList(previous, current) {
    const changedId = current.filter((gather) => !previous.some((previousGather) => previousGather.id === gather.id));
    const changedPlayers = current.filter((gather) => !previous.some((previousGather) => arraysEqual(previousGather.players, gather.players)));

    return [...new Set(changedId.concat(changedPlayers))];
}

function arraysEqual(arr1, arr2) {
    if (arr1.length !== arr2.length) return false;
    for (let i = 0; i < arr1.length; i++) {
        if (arr1[i] !== arr2[i]) return false;
    }
    return true;
}

async function checkGatherList(client, connectedChannels) {
    settings.savedSettings = await settings.loadSettings();
    const {data: list, errorMessage: listError} = await getData(RequestType.GatherList);
    if (listError) {
        return;
    }
    let streamers = [];
    if (previousGathers) {
        const changedList = findChangedList(previousGathers, list);
        if (changedList.length > 0) {
            const result = Object.keys(changedList).map(index => {
                const name = changedList[index].name;
                const players = changedList[index].players.length;
                return `${name} (${players})`;
            }).join(', ');
            info("GATHERLIST CHANGE", `${changedList.length} changed gathers: ${result}`)
            for (const gather of changedList) {
                const {players} = gather;
                for (const playerId of players) {
                    const entry = Object.values(settings.savedSettings).find(entry => entry && entry.esportal && entry.esportal.id === playerId);
                    if (entry) {
                        const previousGather = previousGathers.find(prevGather => prevGather.id === gather.id);
                        if (previousGather) {
                            const {players} = previousGather;
                            const findSamePlayer = Object.values(players).find(player => player === playerId);
                            if (findSamePlayer) {
                                continue;
                            }
                        }
                        const isConnected = Object.values(connectedChannels).find(channel => entry && entry.twitch && entry.twitch.channel === channel)
                        if (isConnected) {
                            streamers.push(entry);
                        }
                    }
                }
            }
        }
        if (streamers.length > 0) {
            for (const entries of streamers) {
                const channel = entries.twitch.channel;
                const userId = entries.esportal.id;

                const gather = Object.values(list).find(entry => entry.players.includes(userId));
                if (!gather) {
                    continue;
                }
                const username = entries.esportal.name;
                const {id, name, creator, players, picked_players, map_id} = gather;
                const mapName = await getMapName(map_id);
                const waiting = players.length - picked_players;
                const isModerator = await isBotModerator(client, channel);
                const isCreator = creator.id === userId;
                let result;
                const gatherResult = isCreator ? "started a gather lobby" : `joined ${creator.username}'s gather lobby`;
                if (isModerator) {
                    result = `${username} ${gatherResult}: https://www.esportal.com/sv/gather/${id} ${mapName}, Waiting: ${waiting}, Picked: ${picked_players}/10`;
                } else {
                    result = `${username} ${gatherResult}: ${name}, ${mapName}, Waiting: ${waiting}, Picked: ${picked_players}/10`
                }
                await sendMessage(client, channel, result);

            }
        }
    }
    previousGathers = list;
}

async function addChannel(channel) {
    const channelWithoutHash = channel.startsWith('#') ? channel.replace('#', '').toLowerCase() : channel.toLowerCase();
    const {data: twitch, errorMessage: error} = await getData(RequestType.TwitchUser, channelWithoutHash);
    if (error) {
        console.log(error);
        return error;
    }
    if (!twitch.data || twitch.data.length === 0) {
        return `Something went from getting this twitch, no data`;
    }
    const {id: id, login: login, display_name: username} = twitch.data[0];
    settings.savedSettings = await settings.loadSettings();
    if (settings.savedSettings[id] && settings.savedSettings[id].twitch.channel) {
        console.log(`Twitch channel ${settings.savedSettings[id].twitch.channel} is already registered on the bot.`);
        return `Twitch channel ${settings.savedSettings[id].twitch.channel} is already registered on the bot.`;
    }
    await settings.save(id, login, username);
    console.log(`Bot registered on channel: ${login} (id: ${id}).`);
    return `Bot registered on channel: ${login} (id: ${id}).`;
}

async function isBotModerator(client, channel) {
    try {
        return client.isMod(channel, process.env.TWITCH_BOT_USERNAME);
    } catch (error) {
        console.error('Error:', error);
        return false;
    }
}

async function changeFont(text, channel) {
    text = text.toString();
    const styleMap = await getFontStyle(channel, settings);
    let isLink = false;
    let isTag = false;
    return text.split('').map((char, index) => {
        if (text.length - 1 === index && (char === ' ' || char === '\n')) {
            return '';
        } else if ((char === ' ' || char === '\t' || char === '\n') && (isLink || isTag)) {
            isLink = false;
            isTag = false;
        } else if (text.substring(index).startsWith('https://') && !isLink) {
            isLink = true;
        } else if (char === '@' && !isLink) {
            isTag = true;
        }
        return (isLink || isTag) ? char : (styleMap[char] || char);
    }).join('');
}

async function sendMessage(client, channel, message) {
    try {
        if (message) {
            console.log(`[Channel: ${channel}]`, `[Esportal_Bot]`, message);
            client.say(channel, await changeFont(message, channel));
        }
    } catch (error) {
        console.error(error);
    }
}

/**Data for a twitch channel
 *
 * Settings for channel #daman_gg: {"id":-1,"toggled":{},"esportal":{"name":"test","id":75317132}}
 * data for channel #daman_gg: [{"id":"41837700776","user_id":"62489635","user_login":"daman_gg","user_name":"DaMan_gg","game_id":"32399","game_name":"Counter-Str
 * ike","type":"live","title":"GIBB MED DAGANG | GIVEAWAYS","viewer_count":42,"started_at":"2024-02-06T08:06:39Z","language":"sv","thumbnail_url":"https://static-
 * cdn.jtvnw.net/previews-ttv/live_user_daman_gg-{width}x{height}.jpg","tag_ids":[],"tags":["swe","Svenska","DaddyGamer","everyone","eng","English","counterstrike","esportal"],"is_mature":false}], length: 1
 */

//checks if there is any data to gather, if not, stream is offline and returns false
async function isStreamOnline(channel) {
    const {data: streamData, errorMessage: message} = await request.getData(request.RequestType.StreamStatus, channel);
    if (message) {
        return false;
    }
    if (streamData.data && streamData.data.length > 0) {
        const {user_id: twitchId} = streamData.data[0];
        await settings.check(twitchId);
    }

    //console.log(`data for channel: ${channel}: ${JSON.stringify(streamData)}, length: ${streamData.length}`);
    return streamData.data && streamData.data.length > 0;
}

function isCreatorChannel(channel) {
    return channel.toLowerCase().replace(/#/g, '') === process.env.CREATOR_CHANNEL;
}

module.exports = {
    isCreatorChannel,
    isStreamOnline,
    sendMessage,
    addChannel,
    isBotModerator,
    checkGatherList,
    checkMaintenance
}