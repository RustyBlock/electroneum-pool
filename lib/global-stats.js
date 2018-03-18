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
        ['zadd', keyNet, timeStamp, data.network.difficulty],
        ['zadd', keyReward, timeStamp, data.network.reward],
        ['zadd', keyPoolSpeed, timeStamp, Math.floor(data.pool.hashrate)],
        ['zadd', keyPoolMiners, timeStamp, data.pool.miners]
    ];

    if(blockTime > 0) {
        redisCommands.push(['zadd', keyBlockTime, timeStamp, blockTime]);
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

function getHistory(historyFrom, historyTo, cb) {
    cb({ test: 'test', historyFrom: new Date(historyFrom), historyTo: new Date(historyTo) });
}

exports.saveGlobalStats = saveGlobalStats;
exports.getHistory = getHistory;