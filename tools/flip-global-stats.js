// flipping global stats under stats key in redis from using time as a value to use time as a score
// this allows to get fast selection by period of time

require('../lib/configReader.js');

var redis = require('redis'),
    redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth}),
    logSystem = 'dup-clean';

require('../lib/exceptionWriter.js')(logSystem);
require('../lib/logger.js');

function flipSet(key, min, max)
{
    redisClient.zrangebyscore(key, min, max, 'WITHSCORES', function(error, results) {
        if(error) {
            log('error', 'tools', 'Failed to get list: %s', [error.toString()]);
            return;
        }
        for(var i=0; i<results.length; i+=2) {
            var scor = results[i], val = results[i+1];
            redisClient.zadd(key, scor, scor + ':' + val, function(error, result) {
                if(error) {
                    log('error', 'tools', 'Failed to add list item: %s', [error.toString()]);
                    return;                            
                }
                console.log('+' + val);
            });
            redisClient.zrem(key, scor, function(error, result) {
                if(error) {
                    log('error', 'tools', 'Failed to delete list item: %s', [error.toString()]);
                    return;                            
                }
                console.log('-' + scor);
            });
        }
    });
}

flipSet(config.coin + ':stats:blockReward', '-inf', 800000);
flipSet(config.coin + ':stats:blockTimings', '-inf', 100000);
flipSet(config.coin + ':stats:networkDiff', 10000000000, '+inf');
flipSet(config.coin + ':stats:poolHashrate', '-inf', 1000000);
flipSet(config.coin + ':stats:poolMiners', '-inf', 1000);
