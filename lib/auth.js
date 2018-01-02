/**
 * Returns wallet object by address
 * @param {string} walletAddress wallet address
 * @param {function} success callback for success data retrieval, wallet object is passed as an argument
 * @param {function} fail callback for error handling, error obnject is passed as an argument
 * @return {*} none
 */
global.getWallet = function(walletAddress, success, fail) {
    redisClient.lrange(config.coin + ":auth:wallets:" + walletAddress + ":users", 0, -1, function(err, result){
        if(err) {
            fail(err);
            return;
        }
        success(result.length === 0 ? undefined : {
            users: result
        });
    });
};
