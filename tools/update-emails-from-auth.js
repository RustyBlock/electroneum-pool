require('../lib/configReader.js');

var redis = require('redis'),
    redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth}),
    logSystem = 'update-emails-from-auth', interval, cursor = 0, doneKeys = {},
    fs = require('fs');

require('../lib/exceptionWriter.js')(logSystem);
require('../lib/logger.js');
var mongoose = require('../pool-web/node_modules/mongoose');
mongoose.connect(process.env.rustyDbUrl, { useMongoClient: true }); // connect to our database

var User = require('../pool-web/app/models/user');

function scan() {

    redisClient.scan(cursor, 'MATCH', config.coin + ':auth:users:5*', 'COUNT', '500', function (error, reply) {
        cursor = reply[0];
        if(error) {
            log('error', logSystem, 'Failed to query users: %s', [error.toString()]);
            return;
        }

        log('info', logSystem, 'Found batch of %s keys', [reply.length]);
        if(reply[1].length > 0){
                
            reply[1].forEach(function(keyRedis) {

                var keys = keyRedis.split(':');
                var key = keys.slice(0, 4).join(':');
                if(doneKeys[key]) {
                    return;
                } else {
                    doneKeys[key] = true;
                }
                log('info', logSystem, 'Checking key %s', [key]);
                redisClient.hget(key, 'email', function(error, result) {
                    if(error) {
                        log('error', logSystem, 'Failed to get user settings: %s', [error.toString()]);
                        return;
                    }

                    if(result) {
                        log('info', logSystem, 'Key %s has email address', [key]);
                        fs.appendFile('emails.csv', result + '\n', function(err) {
                            if(err) {
                                log('error', logSystem, 'Failed to write email to file: %s', [err.toString()]);
                            }
                        });
                        return;
                    }
                    copyUserEmail(keys[3]);
                });
            });
        }

        if(reply[0] == '0') {
            return;
        }

        setTimeout(scan, 1000);
    });
}
setTimeout(scan, 1000); // pause 1 second between batches

function copyUserEmail(userId) {
    log('info', logSystem, 'Copying email for user %s', [userId]);
    User.findOne({'_id': userId}, function(err, user) {
        if(err) {
            log('error', logSystem, 'Failed to load user %s: %s', [userId, err.toString()]);
            return;
        }

        redisClient.hset(config.coin + ':auth:users:' + userId, 'email', user.local.email, function(error, result) {
            if(error) {
                log('error', logSystem, 'Failed to update user %s: %s', [userId, error.toString()]);
                return;
            }
            log('info', logSystem, 'Set email for user %s', [userId]);            
        });
    });
}
