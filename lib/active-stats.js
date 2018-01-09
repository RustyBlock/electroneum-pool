/**
 * Building miner statistics and handling miner notifications
 * @module active-stats
 */

var util = require('util');
var ext = require('extend');
var mailer = require('./mailer.js');

var rateNotification = { // base notification object
    minerId: 'wallet-address',
    hashrate: 1234,
    limitRate: 1234,
    referenceUrl: config.www.host,
    bodyTemplate: 'Hello,<br/><br/><i>this is notification from the cryptocurrency mining pool where your email was subscribed to receive updates.</i><br/><br/>' + 
    'Miner on %s H/s.<br/>' +
    'You can return to the pool to <a href="' + config.www.host + '?miner=%%s">review the latest miner statistics.</a> or change notification settings in <a href="' + config.www.host  + '#profile">your user profile</a>.<br/><br/>' +
    '--<br/><b>RustyLock Team</b><br/><a href="mailto:' + process.env.emailAddressFrom + '">' + process.env.emailAddressFrom + '</a>',
    format: function() {
        return util.format(this.body, this.miderId, this.hashrate, this.limitRate, this.miderId); 
    }
}, rateTooLow = ext({}, rateNotification, { // notification about low rate
    subject: 'Hashrate is too low',
    body: util.format(rateNotification.bodyTemplate, '%s has dropped hashrate to %s H/s which is <b style="color:red;">lower</b> than your specified minimum rate of %s')
}),
rateTooHigh = ext({}, rateNotification, { // notification about high rate
    subject: 'Hashrate is too high',
    body: util.format(rateNotification.bodyTemplate, '%s has exceeded hashrate with %s H/s which is <b style="color:red;">higher</b> than your specified maximum rate of %s')
}), logSystem = 'pool';

exports.saveMinerActivity = function(miner, job, shareDiff, dateNowSeconds) {
    
    var dateNowSeconds = Math.floor(dateNowSeconds / 300) * 300, // round down to the last 5 minutes
        keyRoot = config.coin + ':auth:wallets:' + miner.login,
        redisCommands = [
            ['zincrby', keyRoot + ':active-stats', job.difficulty, dateNowSeconds],
            ['zincrby', keyRoot + ':active-count', 1, dateNowSeconds]
    ];
    redisClient.multi(redisCommands).exec(function(error, replies) {
        if(error) {
            log('error', logSystem, 'Failed to save miner stats: %s', [error.toString()]);
        }
    });
};

function processNotifications() {
    var cursor = '0', interval;

    function scan() {
        redisClient.scan(cursor, 'MATCH', config.coin + ':auth:users:*:hashNf', 'COUNT', '200', function (error, reply) {
            if(error){
                log('error', logSystem, 'Failed to list users: %s', [error.toString()]);
                return;
            }
	    
            cursor = reply[0];
            if(reply[1].length > 0){
            
                reply[1].forEach(function(key) {

		            key = key.split(':').slice(0, 4).join(':');

                    var redisCommands = [
                        ['hget', key, 'email'],
                        ['lrange', key + ':wallets', 0, -1],
                        ['hgetall', key + ':hashNf']
                    ];

                    redisClient.multi(redisCommands).exec(function(error, results) {
                        if(error){
                            log('error', logSystem, 'Failed to get user settings: %s', [error.toString()]);
                            return;
                        }

                        if(results[1].length === 0) {
                            return; // skip keys that don't represent a user record or users with no wallets
                        }

                        processNotify(key, results[0], results[1], results[2]);
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
setInterval(processNotifications, 600000); // process notifications every 10 minutes

function processNotify(userKey, email, wallets, nf) {
    
    if(nf.loEnabled !== "true" && nf.hiEnabled !== 'true') {
        return;
    }

    wallets.forEach(function(wallet) {

        var redisCommands, baseKey = config.coin + ':auth:wallets:' + wallet;

        // look for 10 minutes interval by checking last 2 stat recods, each representing 5 minutes average rate 
        redisClient.sort(baseKey + ':active-count', 'LIMIT', '0', '2', 'DESC', function(error, result) {

            if(error){
                log('error', logSystem, 'Failed to get 2 stat records for wallet %s: %s', [wallet, error.toString()]);
                return;
            }

            if(result.length < 2) { // not enough stats to evaluate notification criteria
                return;
            }

            if(nf.lastNfTime >= result[1]) { // make sure to not repeat notification for the same time slot
                return;
            }

            redisCommands = [
                ['ZSCORE', baseKey + ':active-stats', result[1]],
                ['ZSCORE', baseKey + ':active-stats', result[0]],
                ['hget', userKey + ':hashNf', 'sentLow'],
                ['hget', userKey + ':hashNf', 'sentHigh'],
                ['hset', userKey + ':hashNf', 'lastNfTime', result[0]]
            ];

            redisClient.multi(redisCommands).exec(function(error, results) {
                if(error){
                    log('error', logSystem, 'Failed to get full stats for wallet %s: %s', [wallet, error.toString()]);
                    return;
                }

                var avgRate = Math.ceil((parseInt(results[0], 10) + parseInt(results[1], 10)) / 600), // calculate shares per second over 10 minutes period
                    alreadySentLow = results[2], alreadySentHigh = results[3];

                if(nf.loEnabled === 'true') {
                    if(avgRate <= nf.loRate) {
                        if(alreadySentLow !== 'true') {
                            notifyUser(userKey, avgRate, wallet, nf, email, true, function(error) {
				                if(error) {
				                    return;
				                }
                        	    redisClient.hset(userKey + ':hashNf', 'sentLow', true, function(error, results) {
				                    if(error) {
                            	    	log('error', logSystem, 'Failed to set flag of low rate notification: %s', [error.toString()]);
				                    }
				                });
                            });
                        }
                    } else { // clear "already sent" flag if new shares submitted 
			            redisClient.hdel(userKey + ':hashNf', 'sentLow', function(error, results) {
                            if(error) {
                            	log('error', logSystem, 'Failed to clear sent flag of low rate notification: %s', [error.toString()]);
                            }
                        });
		            }
                }

                if(nf.hiEnabled === 'true') {
                    if(avgRate >= nf.hiRate) {
                        if(alreadySentHigh !== 'true') {
                            notifyUser(userKey, avgRate, wallet, nf, email, false, function() {
				                if(error) {
				                    return;
				                }
                        	    redisClient.hset(userKey + ':hashNf', 'sentHigh', true, function(error, results) {
				                    if(error) {
                            	        log('error', logSystem, 'Failed to set flag of high rate notification: %s', [error.toString()]);
				                    }
                        	    });
			                });
                        }
                    } else { // clear "already sent" flag if new shares submitted
                        redisClient.hdel(userKey + ':hashNf', 'sentHigh', function(error, results) {
                            if(error) {
                                log('error', logSystem, 'Failed to clear sent flag of high rate notification: %s', [error.toString()]);
                            }
                        });
                    }
                }
            });
        });
    });
}

function notifyUser(userKey, rate, walletAddress, nf, email, isLow, callback) {
    var msg = isLow ? rateTooLow : rateTooHigh;
    msg.miderId = walletAddress;
    msg.hashrate = rate;
    msg.limitRate = isLow ? nf.loRate : nf.hiRate;
    mailer.send(email, msg.subject, null, msg.format(), callback); 
}

exports.notifyUser = notifyUser;

function cleanExpiredStats() {
    var cursor = '0', interval;

    function scan() {
        redisClient.scan(cursor, 'MATCH', config.coin + ':auth:wallets:*', 'COUNT', '300', function (error, reply) {
            if(error){
                log('error', logSystem, 'Failed to list wallets: %s', [error.toString()]);
                return;
            }

            cursor = reply[0];
            if(reply[1].length > 0){
                
                reply[1].forEach(function(key) {

                    var windowTime = (((Date.now() / 1000) - 259200) | 0).toString(), // 3 days
                        redisCommands = [
                            ['zremrangebyscore', key + ':active-stats', '-inf', '(' + windowTime],
                            ['zremrangebyscore', key + ':active-count', '-inf', '(' + windowTime]
                        ];
                    redisClient.multi(redisCommands).exec(function(error, reply){
                        if(error) {
                            log('error', logSystem, 'Failed to delete wallet\' expired stats: %s', [error.toString()]);
                        }
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
