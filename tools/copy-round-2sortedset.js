var redis = require('redis');
var logSystem = 'api';

require('../lib/configReader.js');
require('../lib/logger.js');
require('../lib/exceptionWriter.js')(logSystem);

var redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth});

redisClient.hgetall(config.coin + ':shares:roundCurrent', function(error, result) {
    var counter = 0, shares = [];
    if(error) {
        console.error('Failed to load current round stats: ' + error.toString());
        return;
    }

    for (var key in result) {
        shares.push(key);
        shares.push(result[key]);
    }

    function copyItem(value, score) {
        redisClient.zadd(config.coin + ':shares:round-0', parseInt(score), value, function(error, numAdded) {
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