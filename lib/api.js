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
        redisCommands.push(['zrevrange', config.coin + ':auth:wallets:' + address + ':blocks', 0, config.api.blocks - 1, 'WITHSCORES']);
    }
    redisClient.multi(redisCommands).exec(function(error, replies){

        var addresses = Object.keys(addressConnections);

        for (var i = 0; i < addresses.length; i++){
            var offset = i * 4;
            var address = addresses[i];
            var stats = replies[offset];
            var res = addressConnections[address];
            if (!stats) {
                endResponse(res.__acceptEncoding, res.__headers, JSON.stringify({error: "not found"}), res);
                return;
            }
            stats.hashrate = minerStats[address];
            stats.hashrate_raw = minerStats[address + '_raw'];
            stats.roundCurrent = replies[offset + 1];
            stats.blocks = replies[offset + 3];
            function completeResponse(results) {
                if(results) {
                    stats.history = results.rates;
                    stats.historyTimestamp = results.cachedUpTo;
                }
                endResponse(res.__acceptEncoding, res.__headers, JSON.stringify({stats: stats, payments: replies[offset + 2]}), res);
            }

            if(res.includeHashrateHistory === 'true') {
                getHashrateHistory(address, 
                    completeResponse, 
                    function(error) {
                        endResponse(res.__acceptEncoding, res.__headers, JSON.stringify({error: 'not found'}), res);
                    }
                );
            } else {
                completeResponse();
            }
        }
    });
}

function endResponse(acceptEncoding, headers, content, response)
{
    var encod = acceptEncoding, hdr = headers, respText = content, resp = response;
    function writeCallback(err, result) {
        if(err) {
            log('error', logSystem, 'Failed to zip content: %s', [err.toString()]);
            resp.end(JSON.stringify({error: 'not found'}));
            return;
        }
        resp.end(result);
    }
    if (encod.match(/\bdeflate\b/)) {
        hdr['content-encoding'] = 'deflate';
        resp.writeHead(200, hdr);
        zlib.deflateRaw(content, writeCallback);
      } else if (encod.match(/\bgzip\b/)) {
        hdr['content-encoding'] = 'gzip';
        resp.writeHead(200, hdr);
        zlib.gzip(content, writeCallback);
      } else {
        resp.writeHead(200, hdr);
        resp.end(content);
      }
}    

function handleMinerStats(urlParts, request, response){

    var acceptEncoding = request.headers['accept-encoding'],
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive'
        };

    var address = urlParts.query.address;
    var redisCommands = [
        ['hgetall', config.coin + ':workers:' + address]
    ];
    console.log(urlParts);

    if (urlParts.query.longpoll !== 'true') {
        redisCommands.push(['hget', config.coin + ':shares:roundCurrent', address]);
        redisCommands.push(['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES']);
        redisCommands.push(['zrevrange', config.coin + ':auth:wallets:' + address + ':blocks', 0, config.api.blocks - 1, 'WITHSCORES']);
    }

    redisClient.multi(redisCommands).exec(function(error, replies){
        if (error || !replies[0]){
            endResponse(acceptEncoding, headers, JSON.stringify({error: 'not found'}), response);
            return;
        }
        if (urlParts.query.longpoll === 'true') {
            response.includeHashrateHistory = urlParts.query.history;
            response.__acceptEncoding = acceptEncoding;
            response.__headers = headers;
            addressConnections[address] = response;
            response.on('finish', function(){
                delete addressConnections[address];
            });
        } else {
            var stats = replies[0];
            stats.roundCurrent = replies[1];                
            stats.hashrate = minerStats[address];
            stats.hashrate_raw = minerStats[address + '_raw'];
            stats.blocks = replies[3];
            function completeResponse(results){
                if(results) {
                    stats.history = results.rates;
                    stats.historyTimestamp = results.cachedUpTo;
                }
                endResponse(acceptEncoding, headers, JSON.stringify({stats: stats, payments: replies[2]}), response);
            }

            if(urlParts.query.history === 'true') {
                getHashrateHistory(address, 
                    completeResponse, 
                    function(error) { // end response with error
                        endResponse(acceptEncoding, headers, JSON.stringify({error: 'not found'}), response);
                    }
                );
            } else {
                completeResponse();
            }
        }
    });
}

function getHashrateHistory(address, success, fail) {
    var baseKey = config.coin + ':auth:wallets:' + address;
    var statsKey = baseKey + ':active-stats';
    var historyCache = hashrateByMiner[address] || { cachedUpTo: null, rates: [] };
    var statsPoint = 300; // 5 minutes

    async.waterfall([
        // returns the latest cached hashrate timestamp available for the miner
        function(cb) {
            if(historyCache.cachedUpTo) {
                cb(null, historyCache.cachedUpTo);
                return;
            }
            // no memory cache available so need to check the oldest stats timestamp in db
            redisClient.sort(statsKey, 'LIMIT', '1', '1', function(error, result) {
                if(error) {
                    log('error', logSystem, 'Failed to get first stats record for address %s: %s', [address, error.toString()]);
                    fail(error);
                    return cb(true);
                }
                cb(null, result.length ? parseInt(result[0]) : 0);
            });
        },
        // fills the latest hashrate timestamp available for the miner
        function(cachedUpTo, cb) {
            var ret = { cachedUpTo: null, redisLatest: null };
            if(cachedUpTo == 0) { 
                // no hashrate stats for this miner so return null
                cb(null, ret);
                return;
            }
            var maxDepth = Math.floor(new Date().getTime() / 1000) - 86400 * config.poolServer.statDays;
            while(cachedUpTo < maxDepth) { 
                // if current cache timestamp is too old, bring it up to the maxDepth
                cachedUpTo += statsPoint;
            }
            ret.cachedUpTo = cachedUpTo;

            redisClient.sort(statsKey, 'LIMIT', '1', '1', 'DESC', function(error, result) {
                if(error) {
                    log('error', logSystem, 'Failed to get last stats record for address %s: %s', [address, error.toString()]);
                    fail(error);
                    return cb(true);
                }    
                ret.redisLatest = result.length ? parseInt(result[0]) : null;
                cb(null, ret);
            });
        },
        // collects hashrate records from Redis since last cached timestamp
        function(interval, cb) {

            var queryCounter = 0, results = [], 
                // query next history point after the one we cached
                time = interval.cachedUpTo;

            if(!interval.redisLatest || !interval.cachedUpTo) { // no data on this address
                cb(null, [historyCache.rates, historyCache.cachedUpTo]); // just return what we have cached
                return;
            }

            while(time <= interval.redisLatest) {
                queryCounter++;
                redisClient.zscore(statsKey, time, function(error, result) {
                    if(error) {
                        log('error', 'Failed to retrieve score for %s: %s', [statsKey, error.toString()]);
                        queryCounter--;
                        return cb(true);
                    }
                    results.push(result || 0);
                    queryCounter--;
                });
                time += statsPoint;
            }
            // wait until all Redis queries completed
            function captureScores() {
                if(queryCounter > 0) {
                    setTimeout(captureScores, 250);
                }
                cb(null, [results, time]);
            }
            setTimeout(captureScores, 500);
        },
        // update memory cache for hashrate stats and retrun full result
        function(dbScores, cb) {
            var newArray = historyCache.rates.concat(dbScores[0]),
                nao = new Date(), time = new Date(dbScores[1] * 1000);
            var trimItems = newArray.length - (86400 * config.poolServer.statDays / 300);
            if(trimItems > 0) {
                historyCache.rates = newArray.splice(0, trimItems);
            } else {
                historyCache.rates = newArray;
            }
            historyCache.cachedUpTo = dbScores[1];
            if(!hashrateByMiner[address]) {
                hashrateByMiner[address] = historyCache;
            }

            nao.setMinutes(Math.floor(nao.getMinutes() / 5) *5, 0, 0);
            while(time < nao) {
                historyCache.rates.push(0);
                time = new Date(time.getTime() + 300000);
            }
            success(historyCache);
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

function handleRoundStats(urlParts, response) {
    var key = config.coin + ':shares:round-' + (urlParts.query.height ? urlParts.query.height : '0');
    redisClient.zrevrangebyscore(
        key,
        '+inf',
        '-inf',
        'WITHSCORES',
        'LIMIT',
        urlParts.query.rank ? parseInt(urlParts.query.rank)-1 : 0,
        config.api.blocks,
        function(err, result) {

            function sendResponse(content)
            {
                response.writeHead("200", {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'application/json',
                    'Content-Length': content.length
                });
                response.end(content);    
            }

            if (err) {
                log('error', logSystem, 'Failed to load round %s stats: %s', [urlParts.query.height, err.toString()])
                sendResponse(JSON.stringify({error: 'query failed'}));
                return;
            }

            if(!result || result.length === 0) {
                sendResponse(JSON.stringify([]));
                return;
            }

            var redisCommands = [
                ['zrevrank', key, result[0]],
                ['zcount', key, '-inf', '+inf']
            ];
            redisClient.multi(redisCommands).exec(function(error, rank) {
                var reply = {
                    hashes: []
                }, cntr, fullStats;

                if(error) {
                    log('error', logSystem, 'Failed to load round %s stats: %s', [urlParts.query.height, error.toString()])
                    sendResponse(JSON.stringify({error: 'query failed'}));
                    return;
                }

                cntr = rank[0]+1; // rank is zero-based
                for(var i=0; i < result.length; i += 2) {
                    reply.hashes.push({
                        rank: cntr++,
                        address: result[i],
                        hashes: result[i+1] 
                    });
                }

                fullStats = JSON.parse(currentStats);
                reply.reward = fullStats.network.reward;
                reply.roundHashes = fullStats.pool.roundHashes;
                reply.roundMinders = rank[1];
                sendResponse(JSON.stringify(reply));
            });
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
            handleMinerStats(urlParts, request, response);
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
        case '/get_round':
            handleRoundStats(urlParts, response);
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