var fs = require('fs');
var http = require('http');
var url = require("url");
var zlib = require('zlib');
var clone = require('clone');
var uuidv4 = require('uuid/v4');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var activeStats = require('./active-stats');
var poolStats = require('./global-stats');
 
var logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

var globalStats = {};
var minerStats = {};

var liveConnections = {};
var addressConnections = {};

var hashrateByMiner = {};

function collectStats(){
    var redisCommands = [
        ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
        ['zrange', config.coin + ':hashrate', 0, -1],
        ['hgetall', config.coin + ':stats'],
        ['zrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES'],
        ['zrevrange', config.coin + ':blocks:matured', 0, config.api.blocks - 1, 'WITHSCORES'],
        ['hgetall', config.coin + ':shares:roundCurrent'],
        ['zcard', config.coin + ':blocks:matured'],
        ['zrevrange', config.coin + ':payments:all', 0, config.api.payments - 1, 'WITHSCORES'],
        ['zcard', config.coin + ':payments:all'],
        ['keys', config.coin + ':payments:*']
    ];    
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
                    totalBlocks: parseInt(replies[6]) + (replies[3].length / 2),
                    payments: replies[7],
                    totalPayments: parseInt(replies[8]),
                    totalMinersPaid: replies[9].length - 1
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
                        else if(miner.substr(miner.length - 6) !== ':cloud') {
                            data.roundHashes +=  parseInt(replies[5][miner]);
                        }
                    }
                }

                if (replies[2]) {
                    data.lastBlockFound = replies[2].lastBlockFound;
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
            globalStats.currentStatsJson = clone(results);
            zlib.deflateRaw(JSON.stringify(results), function(error, result){
                globalStats.currentStatsCompressed = result;
                broadcastLiveStats();
            });
            setTimeout(function() { poolStats.saveGlobalStats(results); }, 100);
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

var statsHttpHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    'Content-Encoding': 'deflate',
    'Connection': 'keep-alive'
};

function broadcastLiveStats(){

    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [Object.keys(liveConnections).length, Object.keys(addressConnections).length]);

    for (var uid in liveConnections){
        var res = liveConnections[uid];
        if((res.historyFrom && res.historyTo) || 
            (res.poolHistoryFrom && res.poolHistoryTo)) {
            poolStats.getHistory(res.historyFrom, res.historyTo, res.poolHistoryFrom, 
                res.poolHistoryTo, function(result) {
                    handleStatsResult(res, result);
                });
        } else {
            statsHttpHeaders['Content-Length'] = globalStats.currentStatsCompressed ? globalStats.currentStatsCompressed.length : 0;
            res.writeHead(200, statsHttpHeaders);
            res.end(globalStats.currentStatsCompressed);
        }
    }
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
    if (encod && encod.match(/\bdeflate\b/)) {
        hdr['content-encoding'] = 'deflate';
        resp.writeHead(200, hdr);
        zlib.deflateRaw(content, writeCallback);
      } else if (encod && encod.match(/\bgzip\b/)) {
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
            var ret = { cachedUpTo: null, redisLatest: null },
                maxDepth = Math.floor(new Date().getTime() / 1000) - 86400 * config.poolServer.statDays;
            
            if(cachedUpTo == 0) { 
                // no hashrate stats for this miner so return null
                cb(null, ret);
                return;
            }

            // if current cache timestamp is too old, bring it up to the maxDepth
            ret.cachedUpTo = cachedUpTo + Math.floor((maxDepth - cachedUpTo) / statsPoint) * statsPoint;

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

            var queryCounter = 0, scores = [], 
                // query next history point after the one we cached
                time = interval.cachedUpTo;

            if(interval.redisLatest == null || interval.cachedUpTo == null) { // no data on this address
                cb(null, [historyCache.rates, historyCache.cachedUpTo]); // just return what we have cached
                return;
            }

            while(time <= interval.redisLatest) {
                queryCounter++;
                redisClient.zscore(statsKey, time, function(error, result) {
                    if(error) {
                        log('error', logSystem, 'Failed to retrieve score for %s: %s', [statsKey, error.toString()]);
                        queryCounter--;
                        return cb(true);
                    } else if (!result){
                        scores.push(0);
                    } else {
                        scores.push(result);
                    }
                    queryCounter--;
                });
                time += statsPoint;
            }
            // wait until all Redis queries completed
            function captureScores() {
                if(queryCounter > 0) {
                    setTimeout(captureScores, 250);
                } else {
                    cb(null, [scores, time]);
                }
            }
            setTimeout(captureScores, 500);
        },
        // update memory cache for hashrate stats and retrun full result
        function(dbScores, cb) {
            var newArray = historyCache.rates.concat(dbScores[0]);
            
            var trimItems = newArray.length - (86400 * config.poolServer.statDays / statsPoint);
            if(trimItems > 0) {
                newArray.splice(0, trimItems);
            }
            
            historyCache.rates = newArray;

            historyCache.cachedUpTo = dbScores[1];
            if(!hashrateByMiner[address]) {
                hashrateByMiner[address] = historyCache;
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

var blockDetailsCache = {};
function getBlockDetails(height, cb) {
    var ret = blockDetailsCache[height];
    
    if(ret) {
        cb(ret);
        return;
    } else {
        ret = {};
    }

    redisClient.zrangebyscore(config.coin + ':blocks:matured', height, height, function(error, result) {
        
        if(error) {
            log('error', logSystem, 'Failed to get block details for %s: %s', [height, error.toString()]);
            return;
        }

        if(result.length !== 1) {
            cb(ret);
            return;
        }

        var blk = result[0].split(':');
        ret = {
            hash: blk[0],
            timestamp: new Date(parseInt(blk[1]) * 1000),
            difficulty: blk[2],
            roundHashes: blk[3],
            reward: blk[5],
            miner: blk[6]
        };
        blockDetailsCache[height] = ret;
        cb(ret);
    });
}

function applyPenalties(result, reduceLength) {

    function applySinglePenalty(resArray, idx, address, penalty) {
        address = address.substr(0, address.length - 8);
        resArray.splice(idx, 2);

        for(var i=0; i < resArray.length - reduceLength; i += 2) {
            if(resArray[i] === address) {
                resArray[i] = address + ':penalty';
                resArray[i+1] = (parseInt(resArray[i+1]) - penalty).toString();
                break;
            }
        }
    }

    for(var i=0; i < result.length - reduceLength; i += 2) { // length-1 to avoid last 'penalty item' if it's there
        var address = result[i];
        if(address.substr(address.length - 8) !== ':penalty') {
            continue;
        }
        applySinglePenalty(result, i, address, parseInt(result[i+1]));
    }
    if(reduceLength > 0) {
        var last = result[result.length-2];
        if(last.substr(last.length - 8) === ':penalty') {
            applySinglePenalty(result, result.length-2, last, parseInt(result[result.length-1]));
        }
    }
}

function handleRoundStats(urlParts, response) {
    var blockId = urlParts.query.height ? urlParts.query.height : '0',
        key = config.coin + ':shares:round-' + blockId;
    redisClient.zrevrangebyscore(
        key,
        '+inf',
        '-inf',
        'WITHSCORES',
        'LIMIT',
        urlParts.query.rank ? parseInt(urlParts.query.rank)-1 : 0,
        config.api.blocks + 1, // extra element in case there is a 'penalty item'
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
                ['zcount', key, '-inf', '+inf'],
                ['eval', "local sum=0 local z=redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES') for i=2, #z, 2 do sum=sum+z[i] end return sum", 1, key]
            ];
            redisClient.multi(redisCommands).exec(function(error, rank) {
                var reply = {
                    hashes: []
                }, cntr;

                if(error) {
                    log('error', logSystem, 'Failed to load round %s stats: %s', [urlParts.query.height, error.toString()])
                    sendResponse(JSON.stringify({error: 'query failed'}));
                    return;
                }

                cntr = rank[0]+1; // rank is zero-based
                
                applyPenalties(result, config.api.blocks >= result.length ? 0 : 2)
                for(var i=0; i < result.length - (config.api.blocks >= result.length ? 0 : 2); i += 2) { 
                    reply.hashes.push({
                        rank: cntr++,
                        address: result[i],
                        hashes: result[i+1] 
                    });
                }

                reply.roundMinders = rank[1];
                reply.roundHashes = rank[2];
                if(blockId !== '0') {
                    getBlockDetails(blockId, function(blockDetails) {
                        reply.reward = blockDetails.reward;
                        reply.miner = blockDetails.miner;
                        sendResponse(JSON.stringify(reply));    
                    });
                } else {
                    reply.reward = globalStats.currentStatsJson.network.reward;
                    sendResponse(JSON.stringify(reply));
                }
            });
        }
    );    
}

function handleStatsResult(httpResponse, result) {
    var returnObj = clone(globalStats.currentStatsJson);
    returnObj.history = result;
    zlib.deflateRaw(JSON.stringify(returnObj), function(error, compressedJson){
        if(error) {
            log('error', logSystem, 'Failed to compress the stats: %s', [error.toString()]);
            return;
        }
        statsHttpHeaders['Content-Length'] = compressedJson.length;
        httpResponse.writeHead("200", statsHttpHeaders);
        httpResponse.end(compressedJson);
    });            
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
            if((urlParts.query.historyFrom && urlParts.query.historyTo) || 
                (urlParts.query.poolHistoryFrom && urlParts.query.poolHistoryTo)) {
                poolStats.getHistory(urlParts.query.historyFrom, urlParts.query.historyTo, 
                    urlParts.query.poolHistoryFrom, urlParts.query.poolHistoryTo, 
                    function(result) {
                        handleStatsResult(response, result);
                    });
            } else {
                statsHttpHeaders['Content-Length'] = globalStats.currentStatsCompressed ? globalStats.currentStatsCompressed.length : 0;
                response.writeHead(200, statsHttpHeaders);
                response.end(globalStats.currentStatsCompressed);
            }
            break;
        case '/live_stats':
            var uid = uuidv4();
            response.historyFrom = urlParts.query.historyFrom;
            response.historyTo = urlParts.query.historyTo;
            response.poolHistoryFrom = urlParts.query.poolHistoryFrom;
            response.poolHistoryTo = urlParts.query.poolHistoryTo;
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
            activeStats.notifyUser('users', 12345, 'wallet-address', 
                { loRate: 1234, hiRate: 5678 }, 
                process.env.emailAddressFrom, urlParts.href.indexOf('?low') > 0 ? activeStats.rateTooLowMessage : activeStats.rateTooHighMessage, 
                function(error) {
                    var result = error ? error.toString() : "Ok";
                    response.end(result);
                }
            );
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

activeStats.evaluateNotifications();