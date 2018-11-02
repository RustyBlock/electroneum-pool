var redis = require('redis');
require('../lib/configReader.js');
require('../lib/logger.js');

global.redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth});

var logSystem = 'tools', coin = process.argv[2];
require('../lib/exceptionWriter.js')(logSystem);

var from = process.argv[3], to = process.argv[4], commission = parseFloat(process.argv[5]);
if(!coin || isNaN(from) || isNaN(to) || isNaN(commission)) {
    throw Error('Must specify arguments: <coin> <start block> <end block> <commission percentage>');
}

from = from === '0' ? '-inf' : from;
to = to === '0' ? '+inf' : to;

var wallets = {}, block, blockCount, blockNum;

redisClient.zrangebyscore(coin + ':blocks:matured', from, to, 'WITHSCORES', function (error, results) {
    if(error) {
        throw Error('Failed to get blocks: ' + error.toString());
    }

    blockCount = results.length / 2;
    for(var i=0; i < results.length; i+=2) {
        block = results[i].split(':');
        blockNum = results[i+1];
        var reward = block[5] - (block[5] * commission / 100); // subtract commission
        (function(blockNum, reward) {
            redisClient.zrange(coin + ':shares:round-' + results[i + 1], 0, -1, 'WITHSCORES', function (error, res) {
                if (error) {
                    throw Error('Failed to get round ' + results[i + 1] + ': ' + error.toString());
                }
                var sum = 0, roundWallets = {};
                for (var j = 0; j < res.length; j += 2) {
                    sum += parseInt(res[j + 1]);
                    roundWallets[res[j]] = res[j + 1];
                }
                for (var wal in roundWallets) {
                    if (!roundWallets.hasOwnProperty(wal)) {
                        continue;
                    }
                    var cut = (roundWallets[wal] / sum) * reward;
                    wallets[wal] = (wallets[wal] ? wallets[wal] : 0) + cut;
                    //log('info', logSystem, 'Added %s to %s for %s', [cut, wal, blockNum]);
                }
                blockCount--;
                if (blockCount === 0) {
                    for (var wal in wallets) {
                        if (!wallets.hasOwnProperty(wal)) {
                            continue;
                        }
                        (function (wal) {
                            redisClient.hgetall(coin + ':workers:' + wal, function (error, bal) {
                                if (error) {
                                    throw new Error('Failed to get worker data: ' + error.toString());
                                }
                                if(bal) {
                                    log('info', logSystem, '%s,%s,%s,%s', [wal, wallets[wal], bal.paid ? bal.paid : 0, bal.balance]);
                                } else {
                                    throw new Error('No worker record for ' + wal + ' in round ' + blockNum);
                                }
                            });
                        })(wal);
                    }
                }
            });
        })(blockNum, reward);
    }
});
