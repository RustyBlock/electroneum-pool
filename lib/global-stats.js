/**
 * Saving pool and network statistics for a long period of time
 * @module global-stats
 */

var logSystem = 'api';

var statsPoint = 5; // 5 minutes
var lastSaveTime = 0;
var lastBlockTimestamp = 0;
var blockTime = 0;

function saveGlobalStats(data) {

    var keyNet = config.coin + ':stats:networkDiff', 
        keyReward = config.coin + ':stats:blockReward',
        keyBlockTime = config.coin + ':stats:blockTimings',
        keyPoolSpeed = config.coin + ':stats:poolHashrate',
        keyPoolMiners = config.coin + ':stats:poolMiners';

    if(lastBlockTimestamp === 0) {
        lastBlockTimestamp = data.network.timestamp;
    }

    if(data.network.timestamp > lastBlockTimestamp) {
        var newBlockTime = data.network.timestamp - lastBlockTimestamp;
        blockTime = blockTime ? Math.floor(newBlockTime + blockTime) / 2 : newBlockTime;
        lastBlockTimestamp = data.network.timestamp;
    }

    var timeStamp = new Date();
    timeStamp.setMinutes(Math.floor(timeStamp.getMinutes() / statsPoint) * statsPoint, 0, 0);
    timeStamp = Math.floor(timeStamp.getTime() / 1000);
    if(timeStamp === lastSaveTime && lastSaveTime) {
        return;
    }

    var redisCommands = [
        ['zadd', keyNet, data.network.difficulty, timeStamp],
        ['zadd', keyReward, data.network.reward, timeStamp],
        ['zadd', keyPoolSpeed, Math.floor(data.pool.hashrate), timeStamp],
        ['zadd', keyPoolMiners, data.pool.miners, timeStamp]
    ];

    if(blockTime > 0) {
        redisCommands.push(['zadd', keyBlockTime, blockTime, timeStamp]);
    }
    
    lastSaveTime = timeStamp;
    redisClient.multi(redisCommands).exec(function(error, replies) {
        if(error) {
            log('error', logSystem, 'Failed to save global stats: %s', [error.toString()]);
            return;
        }
        log('info', logSystem, 'Saved global stats as of %s', [new Date(timeStamp * 1000)]);
    });
}

module.exports = {
    saveGlobalStats: saveGlobalStats
};