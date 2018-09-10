var redis = require('redis');
require('../lib/configReader.js');
require('../lib/logger.js');

global.redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth});

var logSystem = 'cleanup';
require('../lib/exceptionWriter.js')(logSystem);

var clean = require("../lib/active-stats");
setTimeout(function() {
    for(var i=0;i<config.coins.length;i++) {
        clean.cleanUp(config.coins[i]);
    }
}, 100);

// Delete stats that are older than 1 month
var max = Math.ceil((new Date()).getTime() / 1000) - (60 * 60 * 24 * 31);
log('info', logSystem, 'Clearing stats up to %s', [max]);

for(var i=0;i<config.coins.length;i++) {
    ['blockReward', 'blockTimings', 'networkDiff', 'poolHashrate', 'poolMiners'].forEach(function(key) {
        global.redisClient.zremrangebyscore(config.coins[i] + ':stats:' + key, '-inf', max, function(error, result) {
            if(error) {
                log('error', logSystem, 'Error clearing %s: %s', [key, error]);
            } else {
                log('info', logSystem, '%s items of %s list removed', [result, key]);
            }    
        });
    });
}