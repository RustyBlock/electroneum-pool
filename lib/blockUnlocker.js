var async = require('async');

var aif = require('./apiInterfaces.js');
var apiInterfaces = {};
for(var i=0;i<config.coins.length;i++) {
    var curr = config.coins[i];
    apiInterfaces[curr] = aif(config.daemon[curr], config.wallet[curr]);
}

var logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);


log('info', logSystem, 'Started');

    function runInterval(coin){
    async.waterfall([

        //Get all block candidates in redis
        function(callback){
            redisClient.zrange(coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function(error, results){
                if (error){
                    log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
                    callback(true);
                    return;
                }
                if (results.length === 0){
                    log('info', logSystem, 'No blocks candidates in redis');
                    callback(true);
                    return;
                }

                var blocks = [];

                for (var i = 0; i < results.length; i += 2){
                    var parts = results[i].split(':');
                    blocks.push({
                        serialized: results[i],
                        height: parseInt(results[i + 1]),
                        hash: parts[0],
                        time: parts[1],
                        difficulty: parts[2],
                        shares: parts[3],
                        miner: parts[4]
                    });
                }

                callback(null, blocks);
            });
        },

        //Check if blocks are orphaned
        function(blocks, callback){
            async.filter(blocks, function(block, mapCback){
                apiInterfaces[coin].rpcDaemon('getblockheaderbyheight', {height: block.height}, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with getblockheaderbyheight RPC request for block %s - %j', [block.serialized, error]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    if (!result.block_header){
                        log('error', logSystem, 'Error with getblockheaderbyheight, no details returned for %s - %j', [block.serialized, result]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    var blockHeader = result.block_header;
                    block.orphaned = blockHeader.hash === block.hash ? 0 : 1;
                    if(block.orphaned) {
                        log('warn', logSystem, 'Orphaned block hash %s but node returned %s', [block.hash, blockHeader.hash]);
                    }
                    block.unlocked = blockHeader.depth >= config.blockUnlocker.depth;
                    block.reward = blockHeader.reward;
                    mapCback(block.unlocked);
                });
            }, function(unlockedBlocks){

                if (unlockedBlocks.length === 0){
                    log('info', logSystem, 'No pending blocks are unlocked yet (%d pending)', [blocks.length]);
                    callback(true);
                    return;
                }

                callback(null, unlockedBlocks)
            })
        },

        //Get worker shares for each unlocked block
        function(blocks, callback){

            var redisCommands = blocks.map(function(block){
                return ['hgetall', coin + ':shares:round' + block.height];
            });


            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
                    callback(true);
                    return;
                }
                for (var i = 0; i < replies.length; i++){
                    blocks[i].workerShares = replies[i];
                }
                callback(null, blocks);
            });
        },

        //Handle orphaned blocks
        function(blocks, callback){
            var orphanCommands = [];

            blocks.forEach(function(block){
                if (!block.orphaned) return;

                orphanCommands.push(['del', coin + ':shares:round' + block.height]);
                orphanCommands.push(['zrem', coin + ':blocks:candidates', block.serialized]);
                orphanCommands.push(['zadd', coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned
                ].join(':')]);

                if (block.workerShares) {
                    var workerShares = block.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        if(worker.substr(worker.length - 6) === ':cloud') {
                            // don't transfer cloud marker to the current round - 
                            // there should be a new one if miner is still submitting shares on the cloud port
                            return;
                        }
                        orphanCommands.push(['hincrby', coin + ':shares:roundCurrent', worker, workerShares[worker]]);
                        orphanCommands.push(['zincrby', coin + ':shares:round-0', workerShares[worker], worker]);
                    });
                }
            });

            if (orphanCommands.length > 0){
                redisClient.multi(orphanCommands).exec(function(error){
                    if (error){
                        log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
                        callback(true);
                        return;
                    }
                    callback(null, blocks);
                });
            }
            else{
                callback(null, blocks);
            }
        },

        //Handle unlocked blocks
        function(blocks, callback){
            var unlockedBlocksCommands = [];
            var payments = {};
            var totalBlocksUnlocked = 0;
            blocks.forEach(function(block){
                if (block.orphaned) return;
                totalBlocksUnlocked++;

                unlockedBlocksCommands.push(['del', coin + ':shares:round' + block.height]);
                unlockedBlocksCommands.push(['zrem', coin + ':blocks:candidates', block.serialized]);
                unlockedBlocksCommands.push(['zadd', coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned,
                    block.reward,
                    block.miner
                ].join(':')]);

                var feePercent = config.blockUnlocker.poolFee / 100;

                if (doDonations[coin]) {
                    feePercent += config.blockUnlocker.devDonation / 100;
                    feePercent += config.blockUnlocker.coreDevDonation / 100;

                    payments[devDonationAddress] = block.reward * (config.blockUnlocker.devDonation / 100);
                    payments[coreDevDonationAddress] = block.reward * (config.blockUnlocker.coreDevDonation / 100);
                }

                var reward = block.reward - (block.reward * feePercent);

                if (block.workerShares) {
                    adjustBlockRewardForCloudMiners(coin, block);
                    var totalShares = parseInt(block.shares);
                    Object.keys(block.workerShares).forEach(function (worker) {
                        if(worker.substr(worker.length - 6) === ':cloud') {
                            return;
                        }
                        var percent = block.workerShares[worker] / totalShares;
                        var workerReward = reward * percent;
                        payments[worker] = (payments[worker] || 0) + workerReward;
                        saveBlockHistory(coin, worker, block.height.toString());
                    });
                }
            });

            for (var worker in payments) {
                var amount = parseInt(payments[worker]);
                if (amount <= 0){
                    delete payments[worker];
                    continue;
                }
                unlockedBlocksCommands.push(['hincrby', coin + ':workers:' + worker, 'balance', amount]);
            }

            if (unlockedBlocksCommands.length === 0){
                log('info', logSystem, 'No unlocked blocks yet (%d pending)', [blocks.length]);
                callback(true);
                return;
            }

            redisClient.multi(unlockedBlocksCommands).exec(function(error){
                if (error){
                    log('error', logSystem, 'Error with unlocking blocks %j', [error]);
                    callback(true);
                    return;
                }
                log('info', logSystem, 'Unlocked %d blocks and update balances for %d workers', [totalBlocksUnlocked, Object.keys(payments).length]);
                callback(null);
            });
        }
    ], function(error){
        setTimeout(runInterval, config.blockUnlocker.interval * 1000);
    })
}

function saveBlockHistory(coin, worker, blockHeight) {
    var key = coin + ':workers:' + worker;
    redisClient.hget(key, 'blocks', function(error, result) {
        if(error) {
            log('error', logSystem, 'Failed to get %s blocks history: %s', [worker, error.toString()]);
            return;
        }
        var value = blockHeight.toString();
        if(result) {
            value = result + ',' + value;
        }
        redisClient.hset(key, 'blocks', value, function(error) {
            if(error) {
                log('error', logSystem, 'Failed to set %s blocks history: %s', [worker, error.toString()]);
            }
        });
    });
}

function adjustBlockRewardForCloudMiners(coin, block) {
    var totalShares = parseInt(block.shares);
    Object.keys(block.workerShares).forEach(function (worker) {
        if(worker.substr(worker.length - 6) !== ':cloud') {
            return;
        }
        var lastShareTimestamp = parseInt(block.workerShares[worker]) / 1000,
            ts = parseInt(block.time);
        if((ts - lastShareTimestamp) <= config.maxShareInterval) {
            return;
        }
        var miner = worker.substr(0, worker.length - 6),
            shares = parseInt(block.workerShares[miner]),
            penalty = Math.ceil(shares * config.hopperPenalty);
        block.workerShares[miner] = shares - penalty;
        totalShares -= penalty;
        redisClient.zincrby(coin + ':shares:round-' + block.height, penalty, miner + ':penalty', function(error) {
            if(error) {
                log('error', logSystem, 'Failed to register penalty for %s: %s', [miner, error.toString()]);
                return;
            }
            log('info', logSystem, 'Cloud miner\'s %s original shares of %s reduced by %s', [miner, shares, penalty]);
        });
    });
    block.shares = totalShares;
}

for(var i=0;i<config.coins.length;i++) {
    runInterval(config.coins[i]);
}
