var fs = require('fs');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);


var logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);


log('info', logSystem, 'Started');


function runInterval(){
    async.waterfall([

        //Get worker keys
        function(callback){
            redisClient.keys(config.coin + ':workers:*', function(error, result) {
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
            var redisCommands = keys.map(function(k){
                return ['hget', k, 'balance'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                var balances = {};
                for (var i = 0; i < replies.length; i++){
                    var parts = keys[i].split(':');
                    var workerId = parts[parts.length - 1];
                    balances[workerId] = parseInt(replies[i]) || 0

                }
                callback(null, balances);
            });
        },

        //Filter workers under balance threshold for payment
        function(balances, callback){

            var payments = {};

            for (var worker in balances){
                var balance = balances[worker];
                if (balance >= config.payments.minPayment){
                    var remainder = balance % config.payments.denomination;
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

            for (var worker in payments) {
		        var anAmount = payments[worker].toString();
                var amount = parseFloat(anAmount);
                var addressAndPaymentId = worker.split('-');
                var blank = {
                    redis: [],
                    amount : 0,
                    rpc: {
                        destinations: [],
                        fee: config.payments.transferFee,
                        mixin: config.payments.mixin,
                        unlock_time: 0,
                        get_tx_key: true
                    }
                };

                if(commandIndex > transferCommands.length - 1) {
                    transferCommands.push(blank);
                } else if(addressAndPaymentId.length > 1) { // not the first destination in TX but it has payment ID
                    commandIndex++;
                    transferCommands.push(blank);
                }

                if(addressAndPaymentId.length > 1) { // set payment ID if specified
                    transferCommands[commandIndex].rpc.payment_id = addressAndPaymentId[1];
                }

                transferCommands[commandIndex].rpc.destinations.push({amount: amount, address: addressAndPaymentId[0]});
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
                transferCommands[commandIndex].amount += amount;

                addresses++;
                if (addresses >= config.payments.maxAddresses 
                    || addressAndPaymentId.length > 1) { // next payment in separate TX if payment ID used for the current one
                    commandIndex++;
                    addresses = 0;
                }
            }

            var timeOffset = 0;

            async.filter(transferCommands, function(transferCmd, cback){
                apiInterfaces.rpcWallet('transfer', transferCmd.rpc, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with transfer RPC command %j to wallet daemon: %j', [transferCmd.rpc, error]);
                        cback(false);
                        return;
                    }

                    var now = (timeOffset++) + Date.now() / 1000 | 0;
                    var txHash = result.tx_hash.replace('<', '').replace('>', '');

                    transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
                        txHash,
                        transferCmd.amount,
                        result.fee,
                        transferCmd.rpc.mixin,
                        Object.keys(transferCmd.rpc.destinations).length,
                        result.tx_key
                    ].join(':')]);


                    for (var i = 0; i < transferCmd.rpc.destinations.length; i++){
                        var destination = transferCmd.rpc.destinations[i];
                        if(transferCmd.rpc.payment_id) {
                            destination.address += '-' + transferCmd.rpc.payment_id;
                        }
                        transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
                            txHash,
                            destination.amount,
                            result.fee,
                            transferCmd.rpc.mixin,
                            result.tx_key
                        ].join(':')]);
                    }

                    log('info', logSystem, 'Payments sent via wallet daemon %j', [result]);
                    redisClient.multi(transferCmd.redis).exec(function(error, replies){
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

    ], function(error, result){
        setTimeout(runInterval, config.payments.interval * 1000);
    });
}

runInterval();
