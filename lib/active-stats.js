/**
 * Active stats module.
 * @module active-stats
 */

exports.saveMinerActivity = function(miner, job, shareDiff, dateNowSeconds) {
    
    var dateNowSeconds = Math.floor(dateNowSeconds / 300) * 300, // round down to the last 5 minutes
        keyRoot = config.coin + 'auth:wallets:' + miner.login,
        redisCommands = [
            ['zincrby', keyRoot + ':active-stats', job.difficulty, dateNowSeconds],
            ['zincrby', keyRoot + ':active-count', 1, dateNowSeconds]
    ];
    redisClient.multi(redisCommands).exec(function(err, replies) {
        if(error) {
            log('error', logSystem, 'Failed to save miner stats: %s', [error.toString()]);
        }
    });
};

function cleanExpiredStats()
{
    var cursor = '0', interval;

    function scan() {
        redisClient.scan(cursor, 'MATCH', config,coin + ':auth:wallets:*', 'COUNT', '300', function (error, reply) {
            if(error){
                log('error', logSystem, 'Failed to list wallets: %s', [error.toString()]);
                return;
            }

            cursor = reply[0];
            if( cursor === '0' ){
                clearInterval(interval);
                return;
            } else {
                reply[1].forEach(key => {

                    var windowTime = (((Date.now() / 1000) - 259200) | 0).toString(), // 3 days
                        redisCommands = [
                            ['zremrangebyscore', key + ':active-stats', '-inf', '(' + windowTime],
                            ['zremrangebyscore', key + ':active-count', '-inf', '(' + windowTime]
                        ];
                    redisClient.multi(redisCommands).exec(function(error, reply){
                        if(error) {
                            log('error', logSystem, 'Failed to delete wallet\' expired stats: %s', [error.toString()]);
                        }
                    });
                });
            }    
        });
    };

    interval = setInterval(scan, 5000); // process one batch per every 5 seconds
}

setInterval(cleanExpiredStats, 900000); // clean up every 15 minutes
