/**
 * Saving pool and network statistics for a long period of time
 * @module global-stats
 */

var NodeCache = require( "node-cache" );
var cache = new NodeCache();

var async = require('async');

var logSystem = 'api';

var statsPoint = 5; // 5 minutes
var lastSaveTime = 0;
var lastBlockTimestamp = 0;
var blockTime = 0;

var keyNet = config.coin + ':stats:networkDiff', 
    keyReward = config.coin + ':stats:blockReward',
    keyBlockTime = config.coin + ':stats:blockTimings',
    keyPoolSpeed = config.coin + ':stats:poolHashrate',
    keyPoolMiners = config.coin + ':stats:poolMiners';

function saveGlobalStats(data) {

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
        ['zadd', keyNet, timeStamp, timeStamp + ':' + data.network.difficulty],
        ['zadd', keyReward, timeStamp, timeStamp + ':' + data.network.reward],
        ['zadd', keyPoolSpeed, timeStamp, timeStamp + ':' + Math.floor(data.pool.hashrate)],
        ['zadd', keyPoolMiners, timeStamp, timeStamp + ':' + data.pool.miners]
    ];

    if(blockTime > 0) {
        redisCommands.push(['zadd', keyBlockTime, timeStamp, timeStamp + ':' + blockTime]);
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

function getHistoryMeasure(redisKey, name, from, to, type, cb) {
    
    var key = name + ':' + from + ':' + to,
        data = [];

    cache.get(key, function(err, value) {
        if(err){
          log('error', logSystem, 'Failed to get cache item %s: %s', [key, err.toString()]);
          return;
        }
        if(value) {
            cb(value);
            return;
        }

        redisClient.zrangebyscore(redisKey, from, to, 'LIMIT', 0, 2500, function(error, results) {
            if(error) {
                log('error', logSystem, 'Failed to get global stats for %s: %s', [redisKey, error.toString()]);
                return;
            }
            results.forEach(function(itm) {
                var vals = itm.split(':'),
                    val = vals[vals.length-1];
                switch(type) {
                    case 'int':
                        val = parseInt(val);
                        break;
                    case 'flt':
                        val = parseFloat(val);
                        break;
                }
                data.push(val);
            });
            cache.set(key, data, 300, function(error, res) {
                if(error) {
                    log('error', logSystem, 'Failed to set local cache: %s', [error.toString()]);
                    return;
                }
                cb(data);
            });
        });
    });
}

function getHistory(historyFrom, historyTo, cb) {
    var ret = { historyFrom: new Date(historyFrom), historyTo: new Date(historyTo) },
        from = Math.floor(ret.historyFrom.getTime() / 1000),
        to = from;

    if(ret.historyTo.getHours() === 0 && ret.historyTo.getMinutes() === 0 && 
        ret.historyTo.getSeconds() === 0 && ret.historyTo.getMilliseconds() === 0) {
        ret.historyTo = new Date(ret.historyTo.getTime() + 86399999); // make 'to' date inclusive by moving it to the last miliseond of the day
    }

    to = Math.floor(ret.historyTo.getTime() / 1000);
    
    async.parallel([
        function(cb) {
            getHistoryMeasure(keyNet, 'networkDiff', from, to, 'int', function(data) {
                ret.networkDiff = data;
                cb(null, ret);
            });
        },
        function(cb) {
            getHistoryMeasure(keyReward, 'blockReward', from, to, 'int', function(data) {
                ret.blockReward = data;
                cb(null, ret);
            });            
        },
        function(cb) {
            getHistoryMeasure(keyBlockTime, 'blockTimings', from, to, 'flt', function(data) {
                ret.blockTimings = data;
                cb(null, ret);
            });            
        },
        function(cb) {
            getHistoryMeasure(keyPoolSpeed, 'poolHashrate', from, to, 'int', function(data) {
                ret.poolHashrate = data;
                cb(null, ret);
            });            
        },
        function(cb) {
            getHistoryMeasure(keyPoolMiners, 'poolMiners', from, to, 'int', function(data) {
                ret.poolMiners = data;
                cb(null, ret);
            });            
        }
    ], function(err, results) {
        if(err) {
            log('error', 'Failed to collect global stats: %s', [err.toString()]);
            return;
        }
        cb(ret);
    });
}

exports.saveGlobalStats = saveGlobalStats;
exports.getHistory = getHistory;