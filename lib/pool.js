var fs = require('fs');
var net = require('net');
var tls = require('tls');

var async = require('async');
var bignum = require('bignum');
var cnUtil = require('cryptoforknote-util');
var Muxer = require('port-mux');

// Must exactly be 8 hex chars
var noncePattern = new RegExp("^[0-9A-Fa-f]{8}$");

var threadId = '(Thread ' + process.env.forkId + ') ';

var logSystem = {};
require('./exceptionWriter.js')('pool');

var aif = require('./apiInterfaces.js');
var apiInterfaces = {};
for(var i=0;i<config.coins.length;i++) {
    var curr = config.coins[i];
    apiInterfaces[curr] = aif(config.daemon[curr], config.wallet[curr]);
    logSystem[curr] = 'pool-' + config.symbols[i].toLowerCase();
}

var utils = require('./utils.js');
var uuidv4 = require('uuid/v4');

var log = function(severity, system, text, data){
    global.log(severity, system, threadId + text, data);
};

var actStats = require('./active-stats');

var cryptoNight = {};
config.coins.forEach(function(coin) {
    var algo = config.poolServer.algos[coin], hashLib = require(algo[0])[algo[1]];
    cryptoNight[coin] = function (data) {
        if(algo.length === 2) {
            return hashLib(data);
        } else {
            return hashLib(data, algo[2]);
        }
    };
});

var diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

/**
 * Convert buffer to byte array
 **/
Buffer.prototype.toByteArray = function () {
    return Array.prototype.slice.call(this, 0);
};

var currentBlockTemplate = {};

//Vars for slush mining
var scoreTime;
var lastChecked = 0;

var connectedMiners = {};

var bannedIPs = {};
var perIPStats = {};

var shareTrustEnabled = config.poolServer.shareTrust && config.poolServer.shareTrust.enabled;
var shareTrustStepFloat = shareTrustEnabled ? config.poolServer.shareTrust.stepDown / 100 : 0;
var shareTrustMinFloat = shareTrustEnabled ? config.poolServer.shareTrust.min / 100 : 0;
var banningEnabled = config.poolServer.banning && config.poolServer.banning.enabled;

var blackList = JSON.parse(fs.readFileSync('blacklist.json'));

setInterval(function(){
    var now = Date.now() / 1000 | 0;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        miner.retarget(now);
    }
}, config.poolServer.varDiff.retargetTime * 1000);

/* Every 30 seconds clear out timed-out miners and old bans */
setInterval(function(){
    var now = Date.now();
    var timeout = config.poolServer.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout) {
            if(!miner.socket.writable) {
                log('warn', logSystem[miner.coin], 'Miner timed out and disconnected %s@%s, id: %s', [miner.login, miner.ip, minerId]);
                delete connectedMiners[minerId];
            } else {
                log('warn', logSystem[miner.coin], 'Miner timed out but is still connected %s@%s, id: %s', [miner.login, miner.ip, minerId]);
            }
        }
    }

    if (banningEnabled){
        var ip;
        for (ip in bannedIPs){
            var banTime = bannedIPs[ip];
            if (now - banTime > config.poolServer.banning.time * 1000) {
                delete bannedIPs[ip];
                delete perIPStats[ip];
                log('info', 'pool', 'Ban dropped for %s', [ip]);
            }
        }
    }

}, 30000);


process.on('message', function(message) {
    switch (message.type) {
        case 'banIP':
            bannedIPs[message.ip] = Date.now();
            break;
        case 'poolCache':
            cache.set(message.key, message.data, message.ttl, function(error) {
                if(error) {
                    log('error', 'pool', 'Failed to set pool cache: %s', [error.toString()]);
                }
            });
            break;
    }
});

/**
 * @return {boolean}
 */
function IsBannedIp(ip){
    if (!banningEnabled || !bannedIPs[ip]) return false;

    var bannedTime = bannedIPs[ip];
    var bannedTimeAgo = Date.now() - bannedTime;
    var timeLeft = config.poolServer.banning.time * 1000 - bannedTimeAgo;
    if (timeLeft > 0){
        return true;
    }
    else {
        delete bannedIPs[ip];
        log('info', 'pool', 'Ban dropped for %s', [ip]);
        return false;
    }
}

function incrementHexString(input, maxBytes) {
    var output = "", carryOver = 0, increment = 1;
    for(var i=0; i<maxBytes; i++) {
        var newChar = parseInt(input.substr(i*2, 2), 16)+increment+carryOver;
        if(newChar === 0x100) {
            newChar = i === 0 ? 0x80 : 0;
            carryOver = 1;
        } else {
            carryOver = 0;
        }
        increment = 0;
        newChar = newChar.toString(16);
        output += (newChar.length === 1 ? '0' : '') + newChar;
    }
    return output;
}

function BlockTemplate(coin, template){
    this.difficulty = template.difficulty;
    this.height = template.height;
    this.blockTemplateBlob = template.blocktemplate_blob;
    this.hashingBlob = template.blockhashing_blob;
    this.blobClount = 0;
    this.coin = coin;
}
BlockTemplate.prototype = {
    nextBlob: function() {

        if(this.blobClount > 0) {
            this.hashingBlob = this.hashingBlob.substr(0, 4) + 
                incrementHexString(this.hashingBlob.substr(4, 10), 5) + 
                this.hashingBlob.substr(14);
            this.blockTemplateBlob = this.hashingBlob.substr(0, 14) +
                this.blockTemplateBlob.substr(14);
        }

        if(++this.blobClount === 120) {
            var that = this;
            jobRefresh(this.coin, false, function(){
                that.blobClount = 0;
                log('warn', logSystem[this.coin], 'Forced to call job refresh!');
            });
        }
  
        return this.hashingBlob;
    }
};

function getBlockTemplate(coin, callback) {
    apiInterfaces[coin].rpcDaemon('getblocktemplate', {reserve_size: 8, wallet_address: config.poolServer.poolAddress[coin]}, callback);
}

function jobRefresh(coin, loop, callback) {
    callback = callback || function(){};
    getBlockTemplate(coin, function(error, result){
        if (error){
            log('error', logSystem[coin], 'Error polling getblocktemplate %j', [error]);
            callback(false);
        } else {
            processBlockTemplate(coin, result);
            callback(true);
        }
        if (loop) {
            setTimeout(function () {
                jobRefresh(coin, true);
            }, config.poolServer.blockRefreshInterval);
        }
    })
}

function processBlockTemplate(coin, template) {
    var newTemplate = false;
    if (!currentBlockTemplate[coin] || template.height !== currentBlockTemplate[coin].height){
        log('info', logSystem[coin], 'New block to mine at height %d w/ difficulty of %d', [template.height, template.difficulty]);
        newTemplate = true;
    }

    currentBlockTemplate[coin] = new BlockTemplate(coin, template);

    if(newTemplate) {
        for (var minerId in connectedMiners){
            var miner = connectedMiners[minerId];
            if(miner.coin === coin && miner.socket.writable) {
                miner.pushMessage('job', miner.getJob());
            }
        }
    }
}

(function init(){
    for(var i=0;i<config.coins.length;i++){
        (function(coin) {
            jobRefresh(coin, true, function (successful) {
                if (!successful) {
                    log('error', logSystem[coin], 'Could not start pool');
                    return;
                }
                startPoolServerTcp(coin);
            });
        })(config.coins[i]);
    }
})();

var VarDiff = (function(){
    var variance = config.poolServer.varDiff.variancePercent / 100 * config.poolServer.varDiff.targetTime;
    return {
        variance: variance,
        bufferSize: config.poolServer.varDiff.retargetTime / config.poolServer.varDiff.targetTime * 4,
        tMin: config.poolServer.varDiff.targetTime - variance,
        tMax: config.poolServer.varDiff.targetTime + variance,
        maxJump: config.poolServer.varDiff.maxJump
    };
})();

function Miner(id, login, pass, socket, portData, pushMessage){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = socket.originalRemoteAddress;
    this.socket = socket;
    this.pushMessage = pushMessage;
    this.heartbeat();
    this.difficulty = portData.difficulty;
    this.minDifficultyOverride = portData.minDifficulty ? 
        portData.minDifficulty : config.poolServer.varDiff.minDiff;
    this.coin = portData.coin;

    // Vardiff related variables
    this.shareTimeRing = utils.ringBuffer(16);
    this.lastShareTime = Date.now() / 1000 | 0;

    if (shareTrustEnabled) {
        this.trust = {
            threshold: config.poolServer.shareTrust.threshold,
            probability: 1,
            penalty: 0
        };
    }
}
Miner.prototype = {
    retarget: function(now){

        var options = config.poolServer.varDiff;

        var sinceLast = now - this.lastShareTime;
        var decreaser = sinceLast > VarDiff.tMax;

        var avg = this.shareTimeRing.avg(decreaser ? sinceLast : null);
        var newDiff;

        var direction;

        if (avg > VarDiff.tMax && this.difficulty > this.minDifficultyOverride){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff > options.minDiff ? newDiff : this.minDifficultyOverride;
            direction = -1;
        }
        else if (avg < VarDiff.tMin && this.difficulty < options.maxDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff < options.maxDiff ? newDiff : options.maxDiff;
            direction = 1;
        }
        else{
            return;
        }

        if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > options.maxJump){
            var change = options.maxJump / 100 * this.difficulty * direction;
            newDiff = this.difficulty + change;
        }

        this.setNewDiff(newDiff);
        this.shareTimeRing.clear();
        if (decreaser) this.lastShareTime = now;    
    },
    setNewDiff: function(newDiff){
        newDiff = Math.round(newDiff);
        if (this.difficulty === newDiff) return;
        log('info', logSystem[this.coin], 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login]);
        this.pendingDifficulty = newDiff;
        this.pushMessage('job', this.getJob());
    },
    heartbeat: function(){
        this.lastBeat = Date.now();
    },
    getTargetHex: function(){
        if (this.pendingDifficulty){
            this.difficulty = this.pendingDifficulty;
            this.pendingDifficulty = null;
        }

        var padded = new Buffer(32);
        padded.fill(0);

        var diffBuff = diff1.div(this.difficulty).toBuffer();
        diffBuff.copy(padded, 32 - diffBuff.length);

        var buff = padded.slice(0, 4);
        var buffArray = buff.toByteArray().reverse();
        var buffReversed = new Buffer(buffArray);
        this.target = buffReversed.readUInt32BE(0);
        var hex = buffReversed.toString('hex');
        return hex;
    },
    getJob: function(){
        var jobsKey = this.coin + ':jobs:';
        if (this.lastBlockHeight === currentBlockTemplate[this.coin].height && !this.pendingDifficulty) {
            return {
                blob: '',
                job_id: '',
                target: ''
            };
        }

        var blob = currentBlockTemplate[this.coin].nextBlob();
        this.lastBlockHeight = currentBlockTemplate[this.coin].height;
        var target = this.getTargetHex();

        var newJob = {
            id: uuidv4(),
            blockTemplate: JSON.stringify(currentBlockTemplate[this.coin]),
            height: currentBlockTemplate[this.coin].height,
            difficulty: this.difficulty,
            score: this.score,
            diffHex: this.diffHex,
            submissions: []
        };

        process.send({type: 'poolCache', key: jobsKey + newJob.id, data: newJob, ttl: 600});
        return {
            blob: blob,
            job_id: newJob.id,
            target: target,
            id: this.id
        };
    },
    checkBan: function(validShare){
        if (!banningEnabled) return;

        var fullAddress = this.login + '@' + this.ip;
        // Init global per-IP shares stats
        if (!perIPStats[fullAddress]){
            perIPStats[fullAddress] = { validShares: 0, invalidShares: 0 };
        }

        var stats = perIPStats[fullAddress];
        validShare ? stats.validShares++ : stats.invalidShares++;

        if (stats.validShares + stats.invalidShares >= config.poolServer.banning.checkThreshold){
            if (stats.invalidShares / stats.validShares >= config.poolServer.banning.invalidPercent / 100){
                log('warn', logSystem[this.coin], 'Banned %s', [fullAddress]);
                bannedIPs[fullAddress] = Date.now();
                delete connectedMiners[this.id];
                process.send({type: 'banIP', ip: fullAddress});
            }
            else{
                stats.invalidShares = 0;
                stats.validShares = 0;
            }
        }
    }
};

/**
 * Saves share data in DB.
 * @param {Miner} miner instance of the @see Miner that submits this share
 * @param {Object} job object describing the parameters of the job matching to this share
 * @param {string} shareDiff difficulty of the share
 * @param {boolean} blockCandidate indicate that this share is going to be submitted as block
 * @param {Object} hashHex block hash
 * @param {string} shareType 'valid' or 'trusted' or null if this is a block
 * @param {Object} blockTemplate Block template returned by the network node and targeted by this share
 * @param {boolean} fromCloud true if this share is submitted to the cloud mining port
 * 
 * @returns {void}
 */
function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate, fromCloud){

    var dateNow = Date.now();
    var dateNowSeconds = dateNow / 1000 | 0;

    //Weighting older shares lower than newer ones to prevent pool hopping
    if (config.poolServer.slushMining.enabled) {                
        if (lastChecked + config.poolServer.slushMining.lastBlockCheckRate <= dateNowSeconds || lastChecked === 0) {
            redisClient.hget(miner.coin + ':stats', 'lastBlockFound', function(error, result) {
                if (error) {
                    log('error', logSystem[miner.coin], 'Unable to determine the timestamp of the last block found');
                    return;
                }
                scoreTime = result / 1000 | 0; //scoreTime could potentially be something else than the beginning of the current round, though this would warrant changes in api.js (and potentially the redis db)
                lastChecked = dateNowSeconds;
            });
        }
        
        job.score = job.difficulty * Math.pow(Math.E, ((dateNowSeconds - scoreTime) / config.poolServer.slushMining.weight)); //Score Calculation
        log('info', logSystem[miner.coin], 'Submitted score ' + job.score + ' with difficulty ' + job.difficulty + ' and the time ' + scoreTime);
    }
    else {
        job.score = job.difficulty;
    }

    var redisCommands = [
        ['hincrby', miner.coin + ':shares:roundCurrent', miner.login, job.score],
        ['zincrby', miner.coin + ':shares:round-0', job.score, miner.login],
        ['zadd', miner.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login, dateNow].join(':')],
        ['hincrby', miner.coin + ':workers:' + miner.login, 'hashes', job.difficulty],
        ['hset', miner.coin + ':workers:' + miner.login, 'lastShare', dateNowSeconds]
    ];

    if (fromCloud) {
        // record the last time miner sumbitted a share on cloud mining port
        redisCommands.push(['hset', miner.coin + ':shares:roundCurrent', miner.login + ':cloud', dateNow]);
    }
    
    if (blockCandidate){
        redisCommands.push(['hset', miner.coin + ':stats', 'lastBlockFound', dateNow]);
        redisCommands.push(['rename', miner.coin + ':shares:roundCurrent', miner.coin + ':shares:round' + job.height]);
        redisCommands.push(['rename', miner.coin + ':shares:round-0', miner.coin + ':shares:round-' + job.height]);
        redisCommands.push(['zadd', miner.coin + ':auth:wallets:' + miner.login + ':blocks', job.height, dateNowSeconds]);
        redisCommands.push(['hgetall', miner.coin + ':shares:round' + job.height]);
    }

    function logResult()
    {
        log('info', logSystem[miner.coin], 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty, shareDiff, miner.login, miner.ip]);
    }

    redisClient.multi(redisCommands).exec(function(err, replies){
        if (err){
            log('error', logSystem[miner.coin], 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
            return;
        }
        if (blockCandidate){
            var workerShares = replies[replies.length - 1];
            var totalShares = Object.keys(workerShares).reduce(function(p, c){
                if(c.substr(c.length - 6) === ':cloud') {
                    return p; // skip cloud marker
                } else {
                    return p + parseInt(workerShares[c]);
                }
            }, 0);
            redisClient.zadd(miner.coin + ':blocks:candidates', job.height, [
                hashHex,
                dateNowSeconds,
                blockTemplate.difficulty,
                totalShares,
                miner.login
            ].join(':'), function(err){
                if (err){
                    log('error', logSystem[miner.coin], 'Failed inserting block candidate %s \n %j', [hashHex, err]);
                }
                logResult();
            });

        } else {
            logResult();
        }
    });

    actStats.saveMinerActivity(miner, job.difficulty, dateNow);
}

function getHashDifficulty(resultHash) {
    var hashArray = resultHash.toByteArray().reverse();
    var hashNum = bignum.fromBuffer(new Buffer(hashArray));
    return diff1.div(hashNum);
}

function processShare(miner, job, blockTemplate, nonce, resultHash, minDifficulty){
    var fromCloud = !!minDifficulty, difficulty = blockTemplate.difficulty,
        template = new Buffer(blockTemplate.blockTemplateBlob, 'hex'), jobExpired = job.height !== blockTemplate.height;
    var shareBuffer = cnUtil.construct_block_blob(template, new Buffer(nonce, 'hex'));

    var convertedBlob;
    var hash;
    var shareType;

    if (shareTrustEnabled && !jobExpired &&
            miner.trust.threshold <= 0 &&
            miner.trust.penalty <= 0 && Math.random() > miner.trust.probability) {
        hash = new Buffer(resultHash, 'hex');
        shareType = 'trusted';
    }
    else {
        convertedBlob = cnUtil.convert_blob(shareBuffer);
        hash = cryptoNight[miner.coin](convertedBlob);
        shareType = 'valid';
    }

    if (hash.toString('hex') !== resultHash) {
        log('warn', logSystem[miner.coin], 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
        return 1;
    }

    var hashDiff = getHashDifficulty(hash);

    if (hashDiff.ge(difficulty) && !jobExpired){
        log('info', logSystem[miner.coin], 'Block candidate found at height %d by miner %s@%s',
            [job.height, miner.login, miner.ip]);
        apiInterfaces[miner.coin].rpcDaemon('submitblock', [shareBuffer.toString('hex')], function(error, result){
            if (error){
                log('error', logSystem[miner.coin], 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
                if(shareType === 'valid') {
                    recordShareData(miner, job, hashDiff.toString(), false, null, shareType, null, fromCloud);
                }
            }
            else{
                var blockHash = cnUtil.get_block_id(shareBuffer).toString('hex');
                if(job.height !== currentBlockTemplate[miner.coin].height) {
                    log('warn', logSystem[miner.coin],
                        'Orphaned block %s at height %d found by miner %s@%s',
                        [blockHash.substr(0, 6), job.height, miner.login, miner.ip]);
                    jobRefresh(miner.coin);
                    return 4;
                } else {
                    log('info', logSystem[miner.coin],
                        'Block %s found at height %d by miner %s@%s - submit result: %j',
                        [blockHash.substr(0, 6), job.height, miner.login, miner.ip, result]
                    );
                    recordShareData(miner, job, hashDiff.toString(), true, blockHash, shareType, blockTemplate, fromCloud);
                    jobRefresh(miner.coin);
                }
            }
        });
    }
    else if (hashDiff.lt(job.difficulty)){
        log('warn', logSystem[miner.coin], 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip]);
        return 2;
    }
    else{
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType, null, fromCloud);
    }

    return 0;
}


function handleMinerMethod(method, params, socket, portData, sendReply, pushMessage) {

    var miner = connectedMiners[params.id];
    var ip = socket.originalRemoteAddress;
    var logger = miner ? logSystem[miner.coin] : 'pool';

    // Check for ban here, so preconnected attackers can't continue to screw you
    if (miner && IsBannedIp(miner.login + '@' + ip)) {
        sendReply('Your miner is banned');
        return;
    }
    
    switch(method){
        case 'login':
            if (!params.login){
                sendReply('missing login');
                log('warn', logger, 'Miner is missing login, params sent: %j', [params]);
                return;
            }
            
            // parse address for additional paramaters after '.'
            var addressParts = params.login.split('.');
            var addressAndPaymentId = null;
            
            params.login = addressParts[0];
            addressAndPaymentId = params.login.split("-");

            if (!utils.isValidAddress(addressAndPaymentId[0], portData.coin)) {
                sendReply('invalid address used for login');
                return;
            } else
            if(addressAndPaymentId.length > 2 ||
                (addressAndPaymentId.length === 2 && !addressAndPaymentId[1].match(/[0-9a-fA-F]{64}/))){
                    sendReply('invalid Paymet ID used for login');
                    return;
            }

            global.getWallet(portData.coin, params.login, function(result){
                if(typeof result === 'undefined') {
                    sendReply(params.login + 
                        ' is not registered. Please register your user and add ' + params.login + ' to your miner wallets list in "My settings" section.');
                    return;
                }

                var minerId = uuidv4();
                miner = new Miner(minerId, params.login, params.pass, socket, portData, pushMessage);
                socket.minerId = minerId;
                connectedMiners[minerId] = miner;
                sendReply(null, {
                    id: minerId,
                    job: miner.getJob(),
                    status: 'OK'
                });
                log('info', logSystem[miner.coin], 'Miner connected %s@%s, id: %s',  [params.login, miner.ip, minerId]);
            }, function(err) {
                log('error', logger, 'Failed to read wallet details: %s', [err.toString()]);
                sendReply('Miner login failed. Please report to the pool admin quoting your wallet address.');
            });
            break;
        case 'getjob':
            log('info', logger, 'Get job');
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, miner.getJob());
            break;
        case 'submit':
            if (!miner){
                sendReply('Unauthenticated');
                log('warn', logger, 'Failed to submit shares, miner not found: %j, ip: %s on port %j, share difficulty: %s', [params, ip, portData, getHashDifficulty(new Buffer(params.result, 'hex'))]);
                return;
            }
            miner.heartbeat();

            var job = cache.get(miner.coin + ':jobs:' + params.job_id);
            if (!job){
                log('warn', logger, "Failed to find original job id %s for %s@%s, share difficulty: %s",
                    [params.job_id, miner.login, miner.ip, getHashDifficulty(new Buffer(params.result, 'hex'))]);
                sendReply('Invalid job id');
                return;
            }            

            if (!noncePattern.test(params.nonce)) {
                var fullAddress = miner.login + '@' + miner.ip,
                    minerText = miner ? (' ' + fullAddress) : '';
                log('warn', logger, 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + minerText);
                perIPStats[fullAddress] = { validShares: 0, invalidShares: 999999 };
                miner.checkBan(false);
                sendReply('Malformed nonce');
                return;
            }
    
            // Force lowercase for further comparison
            params.nonce = params.nonce.toLowerCase();
    
            if (job.submissions.indexOf(params.nonce) !== -1) {
                var fullAddress = miner.login + '@' + miner.ip,
                    minerText = miner ? (' ' + fullAddress) : '';
                log('warn', logger, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
                perIPStats[fullAddress] = { validShares: 0, invalidShares: 999999 };
                miner.checkBan(false);
                sendReply('Duplicate share');
                return;
            }

            job.submissions.push(params.nonce);

            // take original block template sent to miner for hashing or use the latest block template if miner's work is expired
            var blockTemplate = 
                currentBlockTemplate[miner.coin].height === job.height ? JSON.parse(job.blockTemplate) : currentBlockTemplate[miner.coin];
            var shareAccepted = processShare(miner, job, blockTemplate, params.nonce, params.result, portData.minDifficulty);

            miner.checkBan(shareAccepted === 0);
            if (shareTrustEnabled){
                if (shareAccepted === 0){
                    miner.trust.probability -= shareTrustStepFloat;
                    if (miner.trust.probability < shareTrustMinFloat)
                        miner.trust.probability = shareTrustMinFloat;
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                }
                else{
                    log('warn', logger, 'Share trust broken by %s@%s', [miner.login, miner.ip]);
                    miner.trust.probability = 1;
                    miner.trust.penalty = config.poolServer.shareTrust.penalty;
                }
            }
                    
            if (shareAccepted !== 0) {
                var reply;
                switch(shareAccepted) {
                    case 1:
                        reply = 'Bad share. Check your miner configuration or contact pool administrator.';
                        break;
                    case 2:
                        reply = 'Rejected low difficulty share.';
                        break;
                    case 3:
                        reply = 'Failed to submit block';
                        break;
                    case 4:
                        reply = 'Block expired';
                        break;
                    default:
                        log('error', logger, 'Failed to process share with unexpected status %s', [shareAccepted]);
                        return;
                }
                setTimeout(function() { // hold a bit to prevent flooding if banning is disabled
                    sendReply(reply);
                }, banningEnabled ? 1 : 1000);
                return;
            }
                    
            var now = Date.now() / 1000 | 0;
            miner.shareTimeRing.append(now - miner.lastShareTime);
            miner.lastShareTime = now;

            sendReply(null, {status: 'OK'});        
            break;
        case 'keepalived' :
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, { status:'KEEPALIVED' });
            break;
        default:
            sendReply("invalid method");
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', logger, 'Invalid method: %s (%j) from %s', [method, params, minerText]);
            break;
    }
}


var httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nmining server online';

function startPoolServerTcp(coin, callback){
    async.each(config.poolServer.ports[coin], function(portData, cback){
        var handleMessage = function(socket, jsonData, pushMessage){
            if (!jsonData.id) {
                log('warn', logSystem[coin], 'Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                log('warn', logSystem[coin], 'Miner RPC request missing RPC method');
                return;
            }
            else if (!jsonData.params) {
                log('warn', logSystem[coin], 'Miner RPC request missing RPC params');
                return;
            }

            var sendReply = function(error, result){
                if(!socket.writable) {
                    return;
                }
                var sendData = JSON.stringify({
                    id: jsonData.id,
                    jsonrpc: "2.0",
                    error: error ? {code: -1, message: error} : null,
                    result: result
                }) + "\n";
                socket.write(sendData);
            };

            handleMinerMethod(jsonData.method, jsonData.params, socket, portData, sendReply, pushMessage);
        };

        if(portData.SSL) { return; } // use tunneling application for now to listen to SSL port and redirect traffic to common ports of the pool

        var proxySockets = {};
        var diag = function(proxy, conn) {
            log('info', logSystem[coin], 'Incoming connection from %s passed to %s:%s',
                [conn.remoteAddress, proxy.remoteAddress, proxy.remotePort]);
            proxySockets[proxy.address().port] = conn.remoteAddress;
        };

        var onConnection = function(socket){
            var ip = socket.originalRemoteAddress = proxySockets[socket.remotePort];
            delete socket.remotePort;

            if(blackList.ips[ip]) {
                socket.destroy();
                log('info', logSystem[coin], 'End socket from blacklisted IP %s', [ip]);
                return;
            }

            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            var dataBuffer = '';

            var pushMessage = function(method, params){
                if(!socket.writable) {
                    log('warn', logSystem[coin], 'Failed to push [%s] method to miner on %s as socket is disconnected', [method, ip]);
                    return;
                }
                var sendData = JSON.stringify({
                    jsonrpc: "2.0",
                    method: method,
                    params: params
                }) + "\n";
                socket.write(sendData);
            };

            socket.on('data', function(d){
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                    dataBuffer = null;
                    log('warn', logSystem[coin], 'Socket flooding detected and prevented from %s', [ip]);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1){
                    var messages = dataBuffer.split('\n');
                    var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (var i = 0; i < messages.length; i++){
                        var message = messages[i];
                        if (message.trim() === '') continue;
                        var jsonData;
                        try{
                            jsonData = JSON.parse(message);
                        }
                        catch(e){
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }

                            log('warn', logSystem[coin], 'Malformed message from %s: %s', [ip, message]);
                            socket.destroy();

                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function(err){
                if (err.code !== 'ECONNRESET') {
                    var errStr = JSON.stringify(err);
                    if(errStr !== '{}') {
                        log('warn', logSystem[coin], 'Socket error from %s %j', [ip, err]);
                    }
                }
            }).on('close', function(){
                pushMessage = function(){};
            });
        };

        var tlsSrv, tlsOpts = {
            cert: fs.readFileSync(config.poolServer.ssl.cert),
            key: fs.readFileSync(config.poolServer.ssl.key)
          };
        tlsSrv = tls.createServer(tlsOpts, onConnection)
            .listen(portData.port - 1);

        net.createServer(null, onConnection)
            .listen(portData.port + 1);

        Muxer()
            .addRule(/^\x16\x03[\x00-\x03]/, portData.port - 1, diag)
            .addRule(/^{/, portData.port + 1, diag)
            .listen(portData.port, function (error) {
                if (error) {
                    log('error', logSystem[coin], 'Could not start server listening on port %d, error: $j', [portData.port, error]);
                    cback(true);
                    return;
                }
                log('info', logSystem[coin], 'Started server listening on port %d', [portData.port]);
                cback();
            });

    }, function(err){
        if (callback) {
            callback(err);
        }
    });
}

ringBuffer = function(maxSize){
    var data = [];
    var cursor = 0;
    var isFull = false;

    return {
        append: function(x){
            if (isFull){
                data[cursor] = x;
                cursor = (cursor + 1) % maxSize;
            }
            else{
                data.push(x);
                cursor++;
                if (data.length === maxSize){
                    cursor = 0;
                    isFull = true;
                }
            }
        },
        avg: function(plusOne){
            var sum = data.reduce(function(a, b){ return a + b }, plusOne || 0);
            return sum / ((isFull ? maxSize : cursor) + (plusOne ? 1 : 0));
        },
        size: function(){
            return isFull ? maxSize : cursor;
        },
        clear: function(){
            data = [];
            cursor = 0;
            isFull = false;
        }
    };
}
