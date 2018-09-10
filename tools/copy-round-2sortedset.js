var redis = require('redis');
var logSystem = 'api';

require('../lib/configReader.js');
require('../lib/logger.js');
require('../lib/exceptionWriter.js')(logSystem);

var redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth});

redisClient.hgetall('electroneum:shares:roundCurrent', function(error, result) {
    var counter = 0, shares = [];
    if(error) {
        console.error('Failed to load current round stats: ' + error.toString());
        return;
    }

    for (var key in result) {
        //noinspection JSUnfilteredForInLoop
        shares.push(key);
        //noinspection JSUnfilteredForInLoop
        shares.push(result[key]);
    }

    function copyItem(value, score) {
        redisClient.zadd('electroneum:shares:round-0', parseInt(score), value, function(error) {
            if(error) {
                console.error('Failed to load current round stats: ' + error.toString());
                return; 
            }

            counter += 2;
            if(counter < shares.length) {
                setTimeout(copyItem, 10, shares[counter], shares[counter+1]);
            }
        });
    }

    copyItem(shares[counter], shares[counter+1]);
});