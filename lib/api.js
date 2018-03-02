var fs = require('fs');
var http = require('http');
var url = require("url");
var zlib = require('zlib');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var stats = require('./active-stats.js');
 
var logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

var redisCommands = [
    ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
    ['zrange', config.coin + ':hashrate', 0, -1],
    ['hgetall', config.coin + ':stats'],
    ['zrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES'],
    ['zrevrange', config.coin + ':blocks:matured', 0, config.api.blocks - 1, 'WITHSCORES'],
    ['hgetall', config.coin + ':shares:roundCurrent'],
    ['hgetall', config.coin + ':stats'],
    ['zcard', config.coin + ':blocks:matured'],
    ['zrevrange', config.coin + ':payments:all', 0, config.api.payments - 1, 'WITHSCORES'],
    ['zcard', config.coin + ':payments:all'],
    ['keys', config.coin + ':payments:*']
];

var currentStats = "";
var currentStatsCompressed = "";

var minerStats = {};

var liveConnections = {};
var addressConnections = {};

var hashrateByMiner = {};

function collectStats(){

    var startTime = Date.now();
    var redisFinished;
    var daemonFinished;

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;

    async.parallel({
        pool: function(callback){
            redisClient.multi(redisCommands).exec(function(error, replies){

                redisFinished = Date.now();
                var dateNowSeconds = Date.now() / 1000 | 0;

                if (error){
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[2],
                    blocks: replies[3].concat(replies[4]),
                    totalBlocks: parseInt(replies[7]) + (replies[3].length / 2),
                    payments: replies[8],
                    totalPayments: parseInt(replies[9]),
                    totalMinersPaid: replies[10].length - 1
                };

                var hashrates = replies[1];

                minerStats = {};

                for (var i = 0; i < hashrates.length; i++){
                    var hashParts = hashrates[i].split(':');
                    minerStats[hashParts[1]] = (minerStats[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }

                var totalShares = 0;

                for (var miner in minerStats){
                    var shares = minerStats[miner];
                    var hashrate = shares / config.api.hashrateWindow;
                    totalShares += shares;

                    minerStats[miner + '_raw'] = hashrate;
                    minerStats[miner] = getReadableHashRateString(hashrate);
                }

                data.miners = Object.keys(minerStats).length;

                data.hashrate = totalShares / config.api.hashrateWindow;

                data.roundHashes = 0;

                if (replies[5]){
                    for (var miner in replies[5]){
                        if (config.poolServer.slushMining.enabled) {
                            data.roundHashes +=  parseInt(replies[5][miner]) / Math.pow(Math.E, ((data.lastBlockFound - dateNowSeconds) / config.poolServer.slushMining.weight)); //TODO: Abstract: If something different than lastBlockfound is used for scoreTime, this needs change. 
                        }
                        else {
                            data.roundHashes +=  parseInt(replies[5][miner]);
                        }
                    }
                }

                if (replies[6]) {
                    data.lastBlockFound = replies[6].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback){
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply){
                daemonFinished = Date.now();
                if (error){
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height,
                    timestamp: blockHeader.timestamp,
                    reward: blockHeader.reward,
                    hash:  blockHeader.hash
                });
            });
        },
        config: function(callback){
            callback(null, {
                ports: getPublicPorts(config.poolServer.ports),
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                coin: config.coin,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                donation: config.blockUnlocker.devDonation,
                coreDonation: config.blockUnlocker.coreDevDonation,
                doDonations: doDonations,
                version: version,
                minPaymentThreshold: config.payments.minPayment,
                paymentFrequency: config.payments.interval,
                denominationUnit: config.payments.denomination,
                blockTime: config.poolServer.slushMining.blockTime,
                slushMiningEnabled: config.poolServer.slushMining.enabled,
                weight: config.poolServer.slushMining.weight
            });
        }
    }, function(error, results){

        log('info', logSystem, 'Stat collection finished: %d ms redis, %d ms daemon', [redisFinished - startTime, daemonFinished - startTime]);

        if (error){
            log('error', logSystem, 'Error collecting all stats');
        }
        else{
            currentStats = JSON.stringify(results);
            zlib.deflateRaw(currentStats, function(error, result){
                currentStatsCompressed = result;
                broadcastLiveStats();
            });

        }

        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

function getPublicPorts(ports){
    return ports.filter(function(port) {
        return !port.hidden;
    });
}

function getReadableHashRateString(hashrate){
    var i = 0;
    var byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH' ];
    while (hashrate > 1000){
        hashrate = hashrate / 1000;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function broadcastLiveStats(){

    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [Object.keys(liveConnections).length, Object.keys(addressConnections).length]);

    for (var uid in liveConnections){
        var res = liveConnections[uid];
        res.end(currentStatsCompressed);
    }

    var redisCommands = [];
    for (var address in addressConnections){
        redisCommands.push(['hgetall', config.coin + ':workers:' + address]);
        redisCommands.push(['hget', config.coin + ':shares:roundCurrent', address]);
        redisCommands.push(['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES']);
    }
    redisClient.multi(redisCommands).exec(function(error, replies){

        var addresses = Object.keys(addressConnections);

        for (var i = 0; i < addresses.length; i++){
            var offset = i * 3;
            var address = addresses[i];
            var stats = replies[offset];
            var res = addressConnections[address];
            if (!stats) {
                res.end(JSON.stringify({error: "not found"}));
                return;
            }
            stats.hashrate = minerStats[address];
            stats.hashrate_raw = minerStats[address + '_raw'];
            stats.roundCurrent = replies[offset + 1];
            function completeRequest(results) {
                if(results) {
                    stats.history = results;
                }
                res.end(JSON.stringify({stats: stats, payments: replies[offset + 2]}));
            }

            if(res.includeHashrateHistory === 'true') {
                getHashrateHistory(address, completeRequest, function(error){
                    res.end(JSON.stringify({error: 'not found'}));
                });
            } else {
                completeRequest();
            }
        }
    });
}

function handleMinerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;
    var redisCommands = [
        ['hgetall', config.coin + ':workers:' + address]
    ];
    console.log(urlParts);

    if (urlParts.query.longpoll !== 'true') {
        redisCommands.push(['hget', config.coin + ':shares:roundCurrent', address]);
        redisCommands.push(['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES']);
    }

    redisClient.multi(redisCommands).exec(function(error, replies){
        if (error || !replies[0]){
            response.end(JSON.stringify({error: 'not found'}));
            return;
        }
        if (urlParts.query.longpoll === 'true') {
            response.includeHashrateHistory = urlParts.query.history;
            addressConnections[address] = response;
            response.on('finish', function(){
                delete addressConnections[address];
            });
        } else {
            var stats = replies[0];
            stats.roundCurrent = replies[1];                
            stats.hashrate = minerStats[address];
            stats.hashrate_raw = minerStats[address + '_raw'];
            function completeRequest(results){
                if(results) {
                    stats.history = results;
                }
                response.end(JSON.stringify({stats: stats, payments: replies[2]}));    
            }

            if(urlParts.query.history === 'true') {
                getHashrateHistory(address, completeRequest, function(error){
                    response.end(JSON.stringify({error: 'not found'}));
                });
            } else {
                completeRequest();
            }
        }
    });
}

function getHashrateHistory(address, success, fail) {
    var baseKey = config.coin + ':auth:wallets:' + address;
    var statsKey = baseKey + ':active-stats';
    var rates = hashrateByMiner[address] || { cachedUpTo: null, rates: [] };
    var statsPeriod = 300;

    async.waterfall([
        // in case it's the first request for stats
        // set the latest time to the earliest available in redis
        // so we load full stats
        function(cb) {
            if(rates.cachedUpTo) {
                cb(null, rates.cachedUpTo);
                return;
            }
            redisClient.sort(statsKey, 'LIMIT', '0', '1', function(error, result) {
                if(error) {
                    log('error', logSystem, 'Failed to get first stats record for address %s: %s', [address, error.toString()]);
                    fail(error);
                    cb(true);
                    return;
                }
                cb(null, parseInt(result));
            });
        },

        function(cachedUpTo, cb) {
            var maxDepth = Math.floor(new Date().getTime() / 1000) - 86400 * config.poolServer.statDays;
            if(!cachedUpTo) {
                cb(null, null);
                return;
            } else if(cachedUpTo < maxDepth) {
                cachedUpTo += Math.floor((maxDepth - cachedUpTo) / statsPeriod) * statsPeriod;
            }
            redisClient.sort(statsKey, 'LIMIT', '1', '1', 'DESC', function(error, result) {
                if(error) {
                    log('error', logSystem, 'Failed to get active stats for address %s: %s', [address, error.toString()]);
                    fail(error);
                    cb(true);
                    return;
                }
                cb(null, { cachedUpTo: cachedUpTo, redisLatest: result.length === 1 ? parseInt(result[0]) : null });
            });
        },

        function(times, cb) {
            if(!times.redisLatest) { // no data on this address
                cb(null, [rates.rates, rates.cachedUpTo]); // just return what we have cached
                return;
            }

            // retrieving scores one by one as multi approach hangs
            var counter = 0, results = [], time = times.cachedUpTo + statsPeriod;
            while(time <= times.redisLatest) {
                counter++;
                redisClient.zscore(statsKey, time, function(error, result) {
                    counter--;
                    if(error) {
                        log('error', 'Failed to retrieve score for %s: %s', [statsKey, error.toString()]);
                        return;
                    }
                    results.push(result);
                });
                time += statsPeriod;
            }
            function captureScores() {
                if(counter > 0) {
                    log('info', '%s items to populate scores', [counter]);
                    setTimeout(captureScores, 500);        
                }
                cb(null, [results, times.cachedUpTo]);
            }
            setTimeout(captureScores, 500);
        },

        function(scores, cb) {
            var newArray = rates.rates.concat(scores[0]);
            var trimItems = newArray.length - (86400 * config.poolServer.statDays / 300);
            if(trimItems > 0) {
                rates.rates = newArray.splice(0, trimItems);
            } else {
                rates.rates = newArray;
            }
            rates.cachedUpTo = scores[1];
            success(rates.rates);
        }
    ]);
}

function handleGetPayments(urlParts, response){
    var paymentKey = ':payments:all';

    if (urlParts.query.address)
        paymentKey = ':payments:' + urlParts.query.address;

    redisClient.zrevrangebyscore(
            config.coin + paymentKey,
            '(' + urlParts.query.time,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.payments,
        function(err, result){

            var reply;

            if (err)
                reply = JSON.stringify({error: 'query failed'});
            else
                reply = JSON.stringify(result);

            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);

        }
    )
}

function handleGetBlocks(urlParts, response){
    redisClient.zrevrangebyscore(
            config.coin + ':blocks:matured',
            '(' + urlParts.query.height,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.blocks,
        function(err, result){

        var reply;

        if (err)
            reply = JSON.stringify({error: 'query failed'});
        else
            reply = JSON.stringify(result);

        response.writeHead("200", {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': reply.length
        });
        response.end(reply);

    });
}


collectStats();

function authorize(request, response){

    response.setHeader('Access-Control-Allow-Origin', '*');

    var sentPass = url.parse(request.url, true).query.password;

    if (sentPass !== config.api.password){
        response.statusCode = 401;
        response.end('invalid password');
        return;
    }

    response.statusCode = 200;
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', 'application/json');

    return true;
}

function handleAdminStats(response){

    async.waterfall([

        //Get worker keys & unlocked blocks
        function(callback){
            redisClient.multi([
                ['keys', config.coin + ':workers:*'],
                ['zrange', config.coin + ':blocks:matured', 0, -1]
            ]).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error trying to get admin data from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, replies[0], replies[1]);
            });
        },

        //Get worker balances
        function(workerKeys, blocks, callback){
            var redisCommands = workerKeys.map(function(k){
                return ['hmget', k, 'balance', 'paid'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }

                callback(null, replies, blocks);
            });
        },
        function(workerData, blocks, callback){
            var stats = {
                totalOwed: 0,
                totalPaid: 0,
                totalRevenue: 0,
                totalDiff: 0,
                totalShares: 0,
                blocksOrphaned: 0,
                blocksUnlocked: 0,
                totalWorkers: 0
            };

            for (var i = 0; i < workerData.length; i++){
                stats.totalOwed += parseInt(workerData[i][0]) || 0;
                stats.totalPaid += parseInt(workerData[i][1]) || 0;
                stats.totalWorkers++;
            }

            for (var i = 0; i < blocks.length; i++){
                var block = blocks[i].split(':');
                if (block[5]) {
                    stats.blocksUnlocked++;
                    stats.totalDiff += parseInt(block[2]);
                    stats.totalShares += parseInt(block[3]);
                    stats.totalRevenue += parseInt(block[5]);
                }
                else{
                    stats.blocksOrphaned++;
                }
            }
            callback(null, stats);
        }
    ], function(error, stats){
            if (error){
                response.end(JSON.stringify({error: 'error collecting stats'}));
                return;
            }
            response.end(JSON.stringify(stats));
        }
    );

}

var server = http.createServer(function(request, response){

    if (request.method.toUpperCase() === "OPTIONS"){

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });

        return(response.end());
    }


    var urlParts = url.parse(request.url, true);

    switch(urlParts.pathname){
        case '/stats':
            var reply = currentStatsCompressed;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Connection': 'keep-alive'
            });
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("finish", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;
        case '/get_payments':
            handleGetPayments(urlParts, response);
            break;
        case '/get_blocks':
            handleGetBlocks(urlParts, response);
            break;
        case '/test_mail':
            stats.notifyUser('users', 12345, 'wallet-address', { loRate: 1234, hiRate: 5678 }, process.env.emailAddressFrom, urlParts.href.indexOf('?low') > 0, function(error) {
                var result = error ? error.toString() : "Ok";
                response.end(result);
            });
            break;
        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }


});


server.listen(config.api.port, function(){
    log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
});

module.exports = {
    getHashrateHistory: getHashrateHistory
};