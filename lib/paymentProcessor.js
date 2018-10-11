var fs = require('fs');

var async = require('async');
var utils = require('./utils.js');

var aif = require('./apiInterfaces.js');
var apiInterfaces = {};
for(var i=0;i<config.coins.length;i++) {
    var curr = config.coins[i];
    apiInterfaces[curr] = aif(config.daemon[curr], config.wallet[curr]);
}

var logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);


log('info', logSystem, 'Started');


function runInterval(coin){
    async.waterfall([

        //Get worker keys
        function(callback){
            redisClient.keys(coin + ':workers:*', function(error, result) {
                if (error) {
                    log('error', logSystem, 'Error trying to get worker balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, result);
            });
        },

        //Get worker balances
        function(keys, callback){
            var redisCommands = [];
            keys.forEach(function(k) {
                redisCommands.push(['hget', k, 'balance']);
                redisCommands.push(['hget', k, 'blocks']);
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                var balances = {}, blocks = {};
                for (var i = 0; i < replies.length; i+=2){
                    var parts = keys[i/2].split(':');
                    var workerId = parts[parts.length - 1];
                    balances[workerId] = parseInt(replies[i]) || 0;
                    blocks[workerId] = replies[i+1];
                }
                callback(null, { amounts: balances, blocks: blocks });
            });
        },

        //Filter workers under balance threshold for payment
        function(balances, callback){

            var payments = {};

            for (var worker in balances.amounts){
                var balance = balances.amounts[worker];
                if (balance >= config.payments.minPayment[coin]){
                    var remainder = balance % config.payments.denomination[coin];
                    var payout = balance - remainder;
                    if (payout < 0) continue;
                    payments[worker] = payout;
                }
            }

            if (Object.keys(payments).length === 0){
                log('info', logSystem, 'No workers\' balances reached the minimum payment threshold');
                callback(true);
                return;
            }

            var transferCommands = [];
            var addresses = 0;
            var commandIndex = 0;
            var addressInfo = {};

            for (var worker in payments) {
		        var anAmount = payments[worker].toString();
                var amount = parseFloat(anAmount);
                var addressAndPaymentId = worker.split('-');
                var blank = {
                    redis: [],
                    amount : 0,
                    rpc: {
                        destinations: [],
                        mixin: config.payments.mixin,
                        unlock_time: 0,
                        get_tx_keys: true
                    }
                };

                // detect if address is integrated
                utils.isValidAddress(addressAndPaymentId[0], coin, addressInfo);

                if(commandIndex > transferCommands.length - 1) {
                    transferCommands.push(blank);
                } else if(addressAndPaymentId.length > 1 || addressInfo.isIntegrated) {
                    // not the first destination in TX but it has payment ID
                    commandIndex++;
                    transferCommands.push(blank);
                    if(addressAndPaymentId.length > 1) { // set payment ID if specified
                        transferCommands[commandIndex].rpc.payment_id = addressAndPaymentId[1];
                    }
                }

                transferCommands[commandIndex].rpc.destinations.push({amount: amount, address: addressAndPaymentId[0]});
                transferCommands[commandIndex].redis.push(['hincrby', coin + ':workers:' + worker, 'balance', -amount]);
                transferCommands[commandIndex].redis.push(['hincrby', coin + ':workers:' + worker, 'paid', amount]);
                transferCommands[commandIndex].amount += amount;

                addresses++;
                if (addresses >= config.payments.maxAddresses 
                    || addressAndPaymentId.length > 1  || addressInfo.isIntegrated) {
                    // next payment in separate TX if payment ID used for the current one
                    commandIndex++;
                    addresses = 0;
                }
            }

            var timeOffset = 0;

            async.filter(transferCommands, function(transferCmd, cback){
                apiInterfaces[coin].rpcWallet('transfer_split', transferCmd.rpc, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with transfer RPC command %j to wallet daemon: %j', [transferCmd.rpc, error]);
                        cback(false);
                        return;
                    } else {
                        log('info', logSystem, 'Successfully processed payment %j with result %j', [transferCmd.rpc, result]);
                    }

                    var now = (timeOffset++) + Date.now() / 1000 | 0;
                    result.tx_hash_list.forEach(function(tx, idx) {
                        var txHash = tx.replace('<', '').replace('>', '');
                        transferCmd.redis.push(['zadd', coin + ':payments:all', now, [
                            txHash,
                            transferCmd.amount,
                            result.fee_list[idx],
                            transferCmd.rpc.mixin,
                            Object.keys(transferCmd.rpc.destinations).length,
                            result.tx_key_list[idx]
                        ].join(':')]);
    
    
                        for (var i = 0; i < transferCmd.rpc.destinations.length; i++){
                            var destination = transferCmd.rpc.destinations[i];
                            if(transferCmd.rpc.payment_id) {
                                destination.address += '-' + transferCmd.rpc.payment_id;
                            }
                            transferCmd.redis.push(['zadd', coin + ':payments:' + destination.address, now, [
                                txHash,
                                destination.amount,
                                result.fee_list[idx],
                                balances.blocks[destination.address],
                                result.tx_key_list[idx]
                            ].join(':')]);
                            transferCmd.redis.push(['hdel', coin + ':workers:' + destination.address, 'blocks']);
                        }
    
                        log('info', logSystem, 'Payments sent via wallet daemon %j', [tx]);
                    });
                    redisClient.multi(transferCmd.redis).exec(function(error){
                        if (error){
                            log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error]);
                            log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.destinations);
                            cback(false);
                            return;
                        }
                        cback(true);
                    });
                });
            }, function(succeeded){
                var failedAmount = transferCommands.length - succeeded.length;
                log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount]);
                callback(null);
            });
        }

    ], function(){
        setTimeout(function() { runInterval(coin); }, config.payments.interval * 1000);
    });
}

for(var i=0; i<config.coins.length; i++){
    runInterval(config.coins[i]);
}
