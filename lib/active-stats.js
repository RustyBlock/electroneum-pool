/**
 * Building miner statistics and handling miner notifications
 * @module active-stats
 */

var util = require('util');
var ext = require('extend');
var async = require('async');
var mailer = require('./mailer.js');

var rateNotification = { // base notification object
    minerId: 'wallet-address',
    hashrate: 1234,
    limitRate: 1234,
    referenceUrl: config.www.host,
    bodyTemplate: 'Hello,<br/><br/>' + 
    'Miner for %s H/s.<br/>' +
    '<a href="' + config.www.host + '?miner=%%s">Review latest miner statistics</a> or change notification settings in <a href="' + config.www.host  + '#profile">your user profile</a>.<br/><br/>' +
    'This notification sent by Electroneum mining pool where you registered with your email address.<br/><br/>' +
    '--<br/><b>RustyBlock Team</b><br/><a href="mailto:' + process.env.emailAddressFrom + '">' + process.env.emailAddressFrom + '</a>',
    format: function() {
        return util.format(this.body, this.miderId, this.hashrate, this.limitRate, this.miderId); 
    }
}, rateTooLow = ext({}, rateNotification, { // notification about low rate
    subject: 'Miner is too slow',
    body: util.format(rateNotification.bodyTemplate, '%s has reduced speed to %s H/s which is <b style="color:red;">lower</b> than expected limit of %s')
}),
rateTooHigh = ext({}, rateNotification, { // notification about high rate
    subject: 'Miner is unusually fast',
    body: util.format(rateNotification.bodyTemplate, '%s has reached speed of %s H/s which is <b style="color:red;">higher</b> than expected limit of %s')
}),
rateZero = ext({}, rateNotification, { // notification about zero rate
    subject: 'Miner is idle',
    body: util.format(rateNotification.bodyTemplate, '%s has <b style="color:red;">idle reate of %s H/s</b> with expected minimum of %s')
}), logSystem = 'nf';

exports.rateTooHighMessage = rateTooHigh;
exports.rateTooLowMessage = rateTooLow;
exports.rateZeroMessage = rateZero;

function fixedMinuteIntervalStart(date, numberOfMinutes) {
    date.setMinutes(Math.floor(date.getMinutes() / numberOfMinutes) * numberOfMinutes, 0, 0);
    return Math.floor(date.getTime() / 1000);
}

exports.saveMinerActivity = function(miner, jobDifficulty, dateNow) {
    
    var dateNowSeconds = fixedMinuteIntervalStart(new Date(dateNow), 5); // aggregate by fixed 5 minute intervals

    redisClient.zincrby(config.coin + ':auth:wallets:' + miner.login + ':active-stats', jobDifficulty, dateNowSeconds, function(error, replies) {
        if(error) {
            log('error', logSystem, 'Failed to save miner stats: %s', [error.toString()]);
        }
    });
};

function evaluateNotifications() {
    var cursor = '0';

    function scan() {
        redisClient.scan(cursor, 'MATCH', config.coin + ':auth:users:*:hashNf', 'COUNT', '200', function (error, reply) {
            if(error){
                log('error', logSystem, 'Failed to list users: %s', [error.toString()]);
                return;
            } else {
                log('info', logSystem, 'Evaluating notifications. Cursor %s, %s results', [cursor, reply[1].length]);
            }
	    
            cursor = reply[0];
            async.each(reply[1], function(key, callback) {

                key = key.split(':').slice(0, 4).join(':');

                var redisCommands = [
                    ['hget', key, 'email'],
                    ['lrange', key + ':wallets', 0, -1],
                    ['hgetall', key + ':hashNf']
                ];

                redisClient.multi(redisCommands).exec(function(error, results) {
                    if(error){
                        log('error', logSystem, 'Failed to get user settings: %s', [error.toString()]);
                        callback(error);
                        return;
                    }

                    var email = results[0],
                        wallets = results[1],
                        nfState = results[2];

                    if(wallets.length === 0) {
                        callback();
                        log('info', logSystem, 'Key %s has no wallets, skipping.', [key])
                        return; // skip keys that don't represent a user record or users with no wallets
                    }

                    evaluateMinerNotifications(key, email, wallets, nfState, function(err) {
                        callback(err);
                    });
                });
            }, function(error) {
                if(cursor === '0') {
                    log('info', logSystem, 'NF evaluation completed with %s, snoozing for 10 mintes', [error ? error.toString() : 'no error']);
                    setTimeout(evaluateNotifications, 600000); // process notifications every 10 minutes
                } else {
                    log('info', logSystem, 'NF batch evaluation completed with %s, snoozing for 5 seconds before next batch', [error ? error.toString() : 'no error']);
                    setTimeout(scan, 5000); // process one batch per every 5 seconds
                }
            });
        });
    };

    scan();
}

function evaluateMinerNotifications(userKey, email, wallets, nfState, done) {
    
    if(nfState.loEnabled !== "true" && nfState.hiEnabled !== 'true') {
        done();
        return;
    }

    log('info', logSystem, 'Notifications enabled for %s: %s-%s', 
        [userKey, nfState.loEnabled ? nfState.loRate : 'n/a', nfState.hiEnabled ? nfState.hiRate : 'n/a']);

    async.each(wallets, function(wallet, callback) {

        var redisCommands, walletKey = config.coin + ':auth:wallets:' + wallet,
            lastInterval = fixedMinuteIntervalStart(new Date(), 5) - 300, // excluding the current 5 minute interval,
            beforeLastInterval = lastInterval - 300; // get two 5 minute intervals in the past

        redisCommands = [
            ['ZSCORE', walletKey + ':active-stats', beforeLastInterval],
            ['ZSCORE', walletKey + ':active-stats', lastInterval],
            ['hget', userKey + ':hashNf', 'sentLow'],
            ['hget', userKey + ':hashNf', 'sentHigh'],
            ['hget', userKey + ':hashNf', 'sentZero']
        ];

        redisClient.multi(redisCommands).exec(function(error, results) {
            if(error){
                log('error', logSystem, 'Failed to get full stats for wallet %s: %s', [wallet, error.toString()]);
                callback(error);
                return;
            }

            // calculate shares per second over 10 minutes period
            var avgRate = Math.ceil((parseInt(results[0] ? results[0] : 0, 10) + parseInt(results[1] ? results[1] : 0, 10)) / 600),
                alreadySentLow = results[2], alreadySentHigh = results[3], alreadySentZero = results[4];
            log('info', logSystem, 'NF state for %s within %s-%s: %s-%s, %s, %s, %s, %s', 
                [wallet, beforeLastInterval, lastInterval, results[0], results[1], results[2], results[3], results[4], avgRate]);

            if(alreadySentZero && avgRate > 0) {
                redisClient.hdel(userKey + ':hashNf', 'sentZero', function(error, result) {
                    if(error) {
                        log('error', logSystem, 'Failed to clear flag of zero rate notification: %s', [error.toString()]);
                    }
                });
            }

            async.parallel([
                function(callback) {
                    if(nfState.loEnabled !== 'true') {
                        callback();
                        return;
                    }

                    if(avgRate <= nfState.loRate) {
                        // miner idle notification
                        if(avgRate === 0 && alreadySentZero !== 'true') {
                            notifyUser(userKey, avgRate, wallet, nfState, email, rateZero, function(error) {
                                if(error) {
                                    callback(error);
                                    return;
                                } else {
                                    log('info', logSystem, 'Idle notification sent for wallet %s', [wallet]);
                                }
                                redisClient.hset(userKey + ':hashNf', 'sentZero', 'true', function(error, results) {
                                    if(error) {
                                        log('error', logSystem, 'Failed to set flag of zero rate notification: %s', [error.toString()]);
                                        callback(error);
                                        return;
                                    }
                                    callback();
                                });
                            });
                            return;
                        }
                        // low rate notification
                        if(avgRate > 0 && alreadySentLow !== 'true') {
                            notifyUser(userKey, avgRate, wallet, nfState, email, rateTooLow, function(error) {
                                if(error) {
                                    callback(error);
                                    return;
                                } else {
                                    log('info', logSystem, 'Low rate notification sent for wallet %s', [wallet]);
                                }
                                redisClient.hset(userKey + ':hashNf', 'sentLow', 'true', function(error, results) {
                                    if(error) {
                                        log('error', logSystem, 'Failed to set flag of low rate notification: %s', [error.toString()]);
                                        callback(error);
                                        return;
                                    }
                                    callback();
                                });
                            });
                            return;
                        }
                        callback();

                        // clear "already sent" flags if current speed is higher than limit
                    } else if(alreadySentLow) {
                        redisClient.hdel(userKey + ':hashNf', 'sentLow', function(error, result) {
                            if(error) {
                                log('error', logSystem, 'Failed to clear sent flag of low rate notifications: %s', [error.toString()]);
                                callback(error);
                            } else {
                                callback();
                            }
                        });
                    }
                },
                function(callback) {
                    if(nfState.hiEnabled !== 'true') {
                        callback();
                        return;
                    }
                    if(avgRate >= nfState.hiRate) {
                        if(alreadySentHigh !== 'true') {
                            notifyUser(userKey, avgRate, wallet, nfState, email, rateTooHigh, function() {
                                if(error) {
                                    callback(error);
                                    return;
                                } else {
                                    log('info', logSystem, 'High rate notification sent for wallet %s', [wallet]);
                                }
                                redisClient.hset(userKey + ':hashNf', 'sentHigh', 'true', function(error, results) {
                                    if(error) {
                                        log('error', logSystem, 'Failed to set flag of high rate notification: %s', [error.toString()]);
                                        callback(error);
                                        return;
                                    }
                                    callback();
                                });
                            });
                            return;
                        }
                        callback();
                    } else { // clear "already sent" flag if new shares submitted
                        redisClient.hdel(userKey + ':hashNf', 'sentHigh', function(error, result) {
                            if(error) {
                                log('error', logSystem, 'Failed to clear sent flag of high rate notification: %s', [error.toString()]);
                                callback(error);
                                return;
                            } else {
                                callback();
                            }
                        });
                    }
                }
            ], function(error) {
                log('info', logSystem, 'NF evaluation finished for %s: %s error', 
                    [wallet, error ? error.toString() : 'no']);
                callback(error);
            });
        });
    }, function(error) {
        log('info', logSystem, 'NF evaluation finished for %s: %s error', 
                    [userKey, error ? error.toString() : 'no']);
        done(error);
    });
}

function notifyUser(userKey, rate, walletAddress, nf, email, msg, callback) {
    msg.miderId = walletAddress;
    msg.hashrate = rate;
    msg.limitRate = (msg !== rateTooHigh) ? nf.loRate : nf.hiRate;
    mailer.send(email, msg.subject, null, msg.format(), callback); 
}

exports.notifyUser = notifyUser;

function cleanExpiredStats() {
    var cursor = '0', interval;

    function scan() {
        redisClient.scan(cursor, 'MATCH', config.coin + ':auth:wallets:*:active-stats', 'COUNT', '300', function (error, reply) {
            if(error){
                log('error', logSystem, 'Failed to list wallets: %s', [error.toString()]);
                return;
            }

            cursor = reply[0];
            if(reply[1].length > 0){
                
                reply[1].forEach(function(key) {

                    var windowTime = ((Date.now() / 1000) - config.poolServer.statDays * 24 * 3600) | 0; // history days
                    redisClient.sort(key, 'LIMIT', '0', '1000', function(error, vals){
                        if(error) {
                            log('error', logSystem, 'Failed to get wallet\'s expired stats: %s', [error.toString()]);
                            return;
                        }
			
                        if(!vals || vals.length === 0 || vals[vals.length - 1] >= windowTime) {
                            return;
                        }
			
			            function logCleanupInfo(key, vals, error, res) {
			                if(error) {
                                log('error', logSystem, 'Failed to remove values from %s: %s', [key, error]);
                                return;
                            }
                            log('info', logSystem, 'Cleaned up list on %s, %s items', [key.substr(key.length - 20), res]);
			            }

                        redisClient.zrem(key, vals, function(error, res) {
			                logCleanupInfo(key, vals, error, res);
			            });
			            key = key.substring(0, key.length - 'active-stats'.length) + 'active-count';
                        redisClient.zrem(key, vals, function(error, res) {
                           logCleanupInfo(key, vals, error, res);
                        });
                    });
                });
            }

	        if(reply[0] == '0') {
		        clearInterval(interval);
                return;
           }    
        });
    };

    interval = setInterval(scan, 5000); // process one batch per every 5 seconds
}
setInterval(cleanExpiredStats, 900000); // clean up every 15 minutes

exports.cleanUp = cleanExpiredStats;
exports.evaluateNotifications = evaluateNotifications;
