require('../lib/configReader.js');

var redis = require('redis'),
    redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth}),
    logSystem = 'dup-clean';

require('../lib/exceptionWriter.js')(logSystem);
require('../lib/logger.js');

function cleanList(path, cursor) {
redisClient.scan(cursor, 'MATCH', path, 'COUNT', '200', function (error, keys) {
    var reply = keys;
    if(error){
        log('error', logSystem, 'Failed to list keys: %s', [error.toString()]);
        return;
    } else {
        log('info', logSystem, 'Processing batch #%s of list with %s items', [cursor, reply[1].length]);
    }

    cursor = reply[0];
    if(cursor === '0') {
        log('info', logSystem, '%s done', [path]);
        return;
    }

    if(reply[1].length === 0) {
        cleanList(path, cursor);
        return;
    }

    var batchCounter = reply[1].length;
    reply[1].forEach(function(key) {
        var walletKey = key;      
        redisClient.lrange(walletKey, 0, -1, function(error, wallets){
            if(error){
                log('error', logSystem, 'Failed to list wallets: %s', [error.toString()]);
                return;
            }
            
            for(var i=0; i<wallets.length; i++) {
                var dupCount = 0;
                for(var j=i+1; j<wallets.length; j++) {
                    if(wallets[i] === wallets[j]) {
                        wallets.splice(j, 1);
                        j--;
                        dupCount++;
                    }
                }
                if(dupCount > 0) {
                    var wallet = wallets[i];
                    log('info', logSystem, 'Removing %s duplicate(s) of %s from %s', [dupCount, wallet, walletKey]);
                    redisClient.lrem(walletKey, dupCount, wallet);    
                }
            }
            batchCounter--;
        });
    });
    
    var waitForBatch = function()
    {
        if(batchCounter === 0) {
            cleanList(path, cursor);
        } else {
            setTimeout(waitForBatch, 100);
        }
    };
    setTimeout(waitForBatch, 100);
});
}

cleanList(config.coin + ':auth:users:*:wallets', '0');
cleanList(config.coin + ':auth:wallets:*:users', '0');