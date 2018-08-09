var fs = require('fs');
var net = require('net');
var tls = require('tls');
var crypto = require('crypto');

var async = require('async');
var bignum = require('bignum');
var multiHashing = require('multi-hashing');
var cnUtil = require('cryptonote-util');

// Must exactly be 8 hex chars
var noncePattern = new RegExp("^[0-9A-Fa-f]{8}$");

var threadId = '(Thread ' + process.env.forkId + ') ';

var logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var utils = require('./utils.js');

var log = function(severity, system, text, data){
    global.log(severity, system, threadId + text, data);
};

var actStats = require('./active-stats');

var cryptoNight = multiHashing['cryptonight'];

function cryptoNightFast(buf) {
    return cryptoNight(Buffer.concat([new Buffer([buf.length]), buf]), true);
}

var diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

var currentBlockTemplate;

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
                log('warn', logSystem, 'Miner timed out and disconnected %s@%s, id: %s', [miner.login, miner.ip, minerId]);
                delete connectedMiners[minerId];
            } else {
                log('warn', logSystem, 'Miner timed out but is still connected %s@%s, id: %s', [miner.login, miner.ip, minerId]);
            }
        }
    }

    if (banningEnabled){
        for (ip in bannedIPs){
            var banTime = bannedIPs[ip];
            if (now - banTime > config.poolServer.banning.time * 1000) {
                delete bannedIPs[ip];
                delete perIPStats[ip];
                log('info', logSystem, 'Ban dropped for %s', [ip]);
            }
        }
    }

}, 30000);


process.on('message', function(message) {
    switch (message.type) {
        case 'banIP':
            bannedIPs[message.ip] = Date.now();
            break;
    }
});


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
        log('info', logSystem, 'Ban dropped for %s', [ip]);
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
        output += (newChar.length == 1 ? '0' : '') + newChar;
    }
    return output;
}

function BlockTemplate(template){
    this.difficulty = template.difficulty;
    this.height = template.height;
    this.blockTemplateBlob = template.blocktemplate_blob;
    this.originalHashingBlob = template.blockhashing_blob;
    this.hashingBlob = template.blockhashing_blob;
    this.blobClount = 0;
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

        if(++this.blobClount == 120) {
            var that = this;
            jobRefresh(false, function(){
                that.blobClount = 0;
                log('warn', logSystem, 'Forced to call job refresh!');
            });
        }
  
        return this.hashingBlob;
    }
};

function getBlockTemplate(callback) {
    apiInterfaces.rpcDaemon('getblocktemplate', {reserve_size: 8, wallet_address: config.poolServer.poolAddress}, callback);
}

function jobRefresh(loop, callback) {
    callback = callback || function(){};
    getBlockTemplate(function(error, result){
        if (loop)
            setTimeout(function(){
                jobRefresh(true);
            }, config.poolServer.blockRefreshInterval);
        if (error){
            log('error', logSystem, 'Error polling getblocktemplate %j', [error]);
            callback(false);
            return;
        }
        processBlockTemplate(result, callback);
    })
}

function processBlockTemplate(template, callback) {
    var newTemplate = false;
    if (!currentBlockTemplate || template.height != currentBlockTemplate.height){
        log('info', logSystem, 'New block to mine at height %d w/ difficulty of %d', [template.height, template.difficulty]);
        newTemplate = true;
    }

    currentBlockTemplate = new BlockTemplate(template);

    if(newTemplate) {
        for (var minerId in connectedMiners){
            var miner = connectedMiners[minerId];
            if(miner.socket.writable) {
                miner.pushMessage('job', miner.getJob());
            }
        }
    }
    callback(true);
}

(function init(){
    jobRefresh(true, function(sucessful){
        if (!sucessful){
            log('error', logSystem, 'Could not start pool');
            return;
        }
        startPoolServerTcp(function(successful){

        });
    });
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

function Miner(id, login, pass, socket, startingDiff, pushMessage, minDifficultyOverride){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = socket.remoteAddress;
    this.socket = socket;
    this.pushMessage = pushMessage;
    this.heartbeat();
    this.difficulty = startingDiff;
    this.validJobs = [];
    this.minDifficultyOverride = minDifficultyOverride ? 
        minDifficultyOverride : config.poolServer.varDiff.minDiff;

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

    this.noJobSince = new Date();
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
        log('info', logSystem, 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login]);
        this.pendingDifficulty = newDiff;
        this.pushMessage('job', this.getJob());
    },
    heartbeat: function(){
        this.lastBeat = Date.now();
    },
    getTargetHex: function(){
        if (this.pendingDifficulty){
            this.lastDifficulty = this.difficulty;
            this.difficulty = this.pendingDifficulty;
            this.pendingDifficulty = null;
        }

        var padded = new Buffer(32);
        padded.fill(0);

        var diffBuff = diff1.div(this.difficulty).toBuffer();
        diffBuff.copy(padded, 32 - diffBuff.length);

        var buff = padded.slice(0, 4);
        var buffArray = buff.toJSON();
        buffArray.reverse();
        var buffReversed = new Buffer(buffArray);
        this.target = buffReversed.readUInt32BE(0);
        var hex = buffReversed.toString('hex');
        return hex;
    },
    getJob: function(){
        if (this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty && 
                (new Date() - this.noJobSince < 300000)) { // no new job for 5 minutes
            return {
                blob: '',
                job_id: '',
                target: ''
            };
        } else {
            this.noJobSince = new Date();
        }

        var blob = currentBlockTemplate.nextBlob();
        this.lastBlockHeight = currentBlockTemplate.height;
        var target = this.getTargetHex();

        var newJob = {
            id: utils.uid(),
            blockTemplate: JSON.stringify(currentBlockTemplate),
            height: currentBlockTemplate.height,
            difficulty: this.difficulty,
            score: this.score,
            diffHex: this.diffHex,
            submissions: []
        };

        this.validJobs.push(newJob);

        if (this.validJobs.length > 20) {
            log('warn', logSystem, 'Valid jobs overflow, shift out job %s', [this.validJobs[0].id]);
            this.validJobs.shift();
        }

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
                log('warn', logSystem, 'Banned %s', [fullAddress]);
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
 * @param {boolean} hashHex is share good enough to be a block?
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
        if (lastChecked + config.poolServer.slushMining.lastBlockCheckRate <= dateNowSeconds || lastChecked == 0) {
            redisClient.hget(config.coin + ':stats', 'lastBlockFound', function(error, result) {
                if (error) {
                    log('error', logSystem, 'Unable to determine the timestamp of the last block found');
                    return;
                }
                scoreTime = result / 1000 | 0; //scoreTime could potentially be something else than the beginning of the current round, though this would warrant changes in api.js (and potentially the redis db)
                lastChecked = dateNowSeconds;
            });
        }
        
        job.score = job.difficulty * Math.pow(Math.E, ((dateNowSeconds - scoreTime) / config.poolServer.slushMining.weight)); //Score Calculation
        log('info', logSystem, 'Submitted score ' + job.score + ' with difficulty ' + job.difficulty + ' and the time ' + scoreTime);
    }
    else {
        job.score = job.difficulty;
    }

    var redisCommands = [
        ['hincrby', config.coin + ':shares:roundCurrent', miner.login, job.score],
        ['zincrby', config.coin + ':shares:round-0', job.score, miner.login],
        ['zadd', config.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login, dateNow].join(':')],
        ['hincrby', config.coin + ':workers:' + miner.login, 'hashes', job.difficulty],
        ['hset', config.coin + ':workers:' + miner.login, 'lastShare', dateNowSeconds]
    ];

    if (fromCloud) {
        // record the last time miner sumbitted a share on cloud mining port
        redisCommands.push(['hset', config.coin + ':shares:roundCurrent', miner.login + ':cloud', dateNow]);
    }
    
    if (blockCandidate){
        redisCommands.push(['hset', config.coin + ':stats', 'lastBlockFound', dateNow]);
        redisCommands.push(['rename', config.coin + ':shares:roundCurrent', config.coin + ':shares:round' + job.height]);
        redisCommands.push(['rename', config.coin + ':shares:round-0', config.coin + ':shares:round-' + job.height]);
        redisCommands.push(['zadd', config.coin + ':auth:wallets:' + miner.login + ':blocks', job.height, dateNowSeconds]);
        redisCommands.push(['hgetall', config.coin + ':shares:round' + job.height]);
    }

    function logResult()
    {
        log('info', logSystem, 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty, shareDiff, miner.login, miner.ip]);
    }

    redisClient.multi(redisCommands).exec(function(err, replies){
        if (err){
            log('error', logSystem, 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
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
            redisClient.zadd(config.coin + ':blocks:candidates', job.height, [
                hashHex,
                dateNowSeconds,
                blockTemplate.difficulty,
                totalShares,
                miner.login
            ].join(':'), function(err, result){
                if (err){
                    log('error', logSystem, 'Failed inserting block candidate %s \n %j', [hashHex, err]);
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
    var hashArray = resultHash.toJSON();
    hashArray.reverse();
    var hashNum = bignum.fromBuffer(new Buffer(hashArray));
    return diff1.div(hashNum);
}

function processShare(miner, job, blockTemplate, nonce, resultHash, minDifficulty){
    var hashBuffer = new Buffer(blockTemplate.hashingBlob, 'hex'),
        fromCloud = minDifficulty ? true : false,
        nonceBuffer = new Buffer(nonce, 'hex');

    var hash;
    var shareType;

    nonceBuffer.copy(hashBuffer, 39);

    if (shareTrustEnabled && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 && Math.random() > miner.trust.probability){
        hash = new Buffer(resultHash, 'hex');
        shareType = 'trusted';
    }
    else {
        hash = cryptoNight(hashBuffer, 0);
        shareType = 'valid';

        if (hash.toString('hex') !== resultHash) {
            log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
            return 1;
        }
    }

    var hashDiff = getHashDifficulty(hash);

    if (hashDiff.ge(blockTemplate.difficulty)){
        var shareBuffer = new Buffer(blockTemplate.blockTemplateBlob, 'hex');
        nonceBuffer.copy(shareBuffer, 39);
        apiInterfaces.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function(error, result){
            if (error){
                log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
                if(shareType === 'valid') {
                    recordShareData(miner, job, hashDiff.toString(), false, null, shareType, null, fromCloud);
                }
            }
            else{
                var blockFastHash = cryptoNightFast(cnUtil.convert_blob(shareBuffer)).toString('hex');
                log('info', logSystem,
                    'Block %s found at height %d by miner %s@%s - submit result: %j',
                    [blockFastHash.substr(0, 6), job.height, miner.login, miner.ip, result]
                );
                recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate, fromCloud);
                jobRefresh();
            }
        });
    }
    else if (hashDiff.lt(job.difficulty)){
        log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip]);
        return 2;
    }
    else{
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType, null, fromCloud);
    }

    return 0;
}


function handleMinerMethod(method, params, socket, portData, sendReply, pushMessage) {

    var miner = connectedMiners[params.id];
    var ip = socket.remoteAddress;

    // Check for ban here, so preconnected attackers can't continue to screw you
    if (miner && IsBannedIp(miner.login + '@' + ip)) {
        sendReply('Your miner is banned');
        return;
    }
    
    switch(method){
        case 'login':
            if (!params.login){
                sendReply('missing login');
                log('warn', logSystem, 'Miner is missing login, params sent: %j', [params]);
                return;
            }
            
            // parse address for additional paramaters after '.'
            var addressParts = params.login.split('.');
            var addressAndPaymentId = null;
            
            params.login = addressParts[0];
            addressAndPaymentId = params.login.split("-");

            if (!utils.isValidAddress(addressAndPaymentId[0])) {
                sendReply('invalid address used for login');
                return;
            } else
            if(addressAndPaymentId.length > 2 ||
                (addressAndPaymentId.length == 2 && !addressAndPaymentId[1].match(/[0-9a-fA-F]{64}/))){
                    sendReply('invalid Paymet ID used for login');
                    return;
            }

            global.getWallet(params.login, function(result){
                if(typeof result === 'undefined') {
                    sendReply(params.login + 
                        ' is not registered. Please register your user and add ' + params.login + ' to your miner wallets list in "My settings" section.');
                    return;
                }

                var minerId = utils.uid();
                miner = new Miner(minerId, params.login, params.pass, socket, portData.difficulty, pushMessage, portData.minDifficulty);
                socket.minerId = minerId;
                connectedMiners[minerId] = miner;                
                sendReply(null, {
                    id: minerId,
                    job: miner.getJob(),
                    status: 'OK'
                });
                log('info', logSystem, 'Miner connected %s@%s, id: %s',  [params.login, miner.ip, minerId]);
            }, function(err) {
                log('error', logSystem, 'Failed to read wallet details: %s', [err.toString()])
                sendReply('Miner login failed. Please report to the pool admin quoting your wallet address.');
            })
            break;
        case 'getjob':
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
                log('warn', logSystem, 'Failed to submit shares, miner not found: %j, ip: %s on port %j, share difficulty: %s', [params, ip, portData, getHashDifficulty(new Buffer(params.result, 'hex'))]);
                return;
            }
            miner.heartbeat();

            var job = miner.validJobs.filter(function(job){
                return job.id == params.job_id;
            })[0];

            if (!job){
                log('warn', logSystem, "Failed to find original job id %s (in %s jobs) for %s@%s, share difficulty: %s", [params.job_id, miner.validJobs.length, miner.login, miner.ip, getHashDifficulty(new Buffer(params.result, 'hex'))]);
                sendReply('Invalid job id');
                return;
            }

            if (!noncePattern.test(params.nonce)) {
                var fullAddress = miner.login + '@' + miner.ip,
                    minerText = miner ? (' ' + fullAddress) : '';
                log('warn', logSystem, 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + minerText);
                perIPStats[fullAddress] = { validShares: 0, invalidShares: 999999 };
                miner.checkBan(false);
                sendReply('Malformed nonce');
                return;
            }

            // Force lowercase for further comparison
            params.nonce = params.nonce.toLowerCase();

            if (job.submissions.indexOf(params.nonce) !== -1){
                 var fullAddress = miner.login + '@' + miner.ip,
                     minerText = miner ? (' ' + fullAddress) : '';
                 log('warn', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
                 perIPStats[fullAddress] = { validShares: 0, invalidShares: 999999 };
                 miner.checkBan(false);
                 sendReply('Duplicate share');
                 return;
            }

            job.submissions.push(params.nonce);

            var blockTemplate = 
                currentBlockTemplate.height === job.height ? JSON.parse(job.blockTemplate) : null;
            if (!blockTemplate){
                sendReply('Block expired');
                log('warn', logSystem, 'Block expired from %s@%s: share height: %s, current height: %s, share difficulty: %s', 
                    [miner.login, miner.ip, job.height, currentBlockTemplate.height, getHashDifficulty(new Buffer(params.result, 'hex'))]);
                return;
            }
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
                    log('warn', logSystem, 'Share trust broken by %s@%s', [miner.login, miner.ip]);
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
                    default:
                        log('error', logSystem, 'Failed to process share with unexpected status %s', [shareAccepted]);
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
            miner.heartbeat()
            sendReply(null, { status:'KEEPALIVED' });
            break;
        default:
            sendReply("invalid method");
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', logSystem, 'Invalid method: %s (%j) from %s', [method, params, minerText]);
            break;
    }
}


var httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nmining server online';


function startPoolServerTcp(callback){
    async.each(config.poolServer.ports, function(portData, cback){
        var handleMessage = function(socket, jsonData, pushMessage){
            if (!jsonData.id) {
                log('warn', logSystem, 'Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                log('warn', logSystem, 'Miner RPC request missing RPC method');
                return;
            }
            else if (!jsonData.params) {
                log('warn', logSystem, 'Miner RPC request missing RPC params');
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

        var onConnection = function(socket){
            var ip = socket.remoteAddress;
            if(blackList.ips[ip]) {
                socket.destroy();
                log('info', logSystem, 'End socket from blacklisted IP %s', [ip]);
                return;
            }

            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            var dataBuffer = '';

            var pushMessage = function(method, params){
                if(!socket.writable) {
                    log('warn', logSystem, 'Failed to push [%s] method to miner on %s as socket is disconnected', [method, ip]);
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
                    log('warn', logSystem, 'Socket flooding detected and prevented from %s', [socket.remoteAddress]);
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

                            log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message]);
                            socket.destroy();

                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function(err){
                if (err.code !== 'ECONNRESET') {
                    log('warn', logSystem, 'Socket error from %s %j', [ip, err]);
                }
            }).on('close', function(had_error){
                pushMessage = function(){};
            });
        };

        var srv, tlsSrv, tlsOpts = {
            cert: fs.readFileSync(config.poolServer.ssl.cert),
            key: fs.readFileSync(config.poolServer.ssl.key),
          };
        tlsSrv = tls.createServer(tlsOpts, onConnection);

        net.createServer(function(socket) {
            socket.once('data', function(data) {
              if (data[0] == 0x16 || data[0] == 0x80 || data[0] == 0x00) {
                log('info', logSystem, 'Switching to TLS from %s', [socket.remoteAddress]);
                tlsSrv.emit('connection', socket);
                socket.pause();
                process.nextTick(function () {
                    socket.emit('data', data);
                    socket.resume();
                  });
              } else {
                onConnection(socket);
                socket.emit('data', data);
              }
            });
        }).listen(portData.port, function (error, result) {
            if (error) {
                log('error', logSystem, 'Could not start server listening on port %d, error: $j', [portData.port, error]);
                cback(true);
                return;
            }
            log('info', logSystem, 'Started server listening on port %d', [portData.port]);
            cback();
        });

    }, function(err){
        if (err)
            callback(false);
        else
            callback(true);
    });
}




