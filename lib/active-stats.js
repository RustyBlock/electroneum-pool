/**
 * Building miner statistics and handling miner notifications
 * @module active-stats
 */

var util = require('util');
var mailer = require('mailer');

var rateTooLow = {
    subject: 'Hahsrate is too low',
    body: 'Miner on %s has dropped hashrate to %s which is lower than minimum rate of %s'
}, rateTooHigh = {
    subject: 'Hahsrate is too high',
    body: 'Miner on %s has exceeded hashrate to %s which is hgher than maximum rate of %s'
}, logSystem = 'pool';

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
    
    if(!nf.loEnabled && !nf.hiEnabled) {
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
                ['ZSCORE', baseKey + ':active-count', result[1]],
                ['ZSCORE', baseKey + ':active-stats', result[0]],
                ['ZSCORE', baseKey + ':active-count', result[0]],
                ['hget', userKey + ':hashNf', 'sentLow'],
                ['hget', userKey + ':hashNf', 'sentHigh'],
                ['hset', userKey + ':hashNf', 'lastNfTime', result[0]]
            ];

            redisClient.multi(redisCommands).exec(function(error, results) {
                if(error){
                    log('error', logSystem, 'Failed to get full stats for wallet %s: %s', [wallet, error.toString()]);
                    return;
                }

                var avgRate = (results[0] + results[2]) / (results[1] + results[2]) / 600, // calculate shares per second over 10 minutes period
                    alreadySentLow = results[4], alreadySentHigh = results[5];

                if(nf.loEnabled) {
                    if(avgRate <= nf.loRate) {
                        if(!alreadySentLow) {
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

                if(nf.hiEnabled) {
                    if(avgRate >= nf.hiRate) {
                        if(!alreadySentHigh) {
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
    mailer.send(email, 
        isLow ? rateTooLow.subject : rateTooHigh.subject, 
        util.format(isLow ? rateTooLow.body : rateTooHigh.body, walletAddress, rate, isLow ? nf.loRate : nf.hiRate), null, callback);
}

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