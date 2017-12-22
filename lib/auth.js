var fs = require('fs');

var poolAccess = JSON.parse(fs.readFileSync("pool-access.json")), poolWallets = {},
    poolUsers = {};

// build wallets hashtable
poolAccess.wallets.forEach(w => {
    w.users = {};
    w.users.indexed = [];
    poolWallets[w.address] = poolWallets["id-" + w.id] = w;
});

// build users hashtables
poolAccess.users.forEach(u => {
    u.wallets.forEach(w => {
        var wallet = poolWallets["id-" + w];
        if(typeof wallet === "undefined") {
            throw new Error("User has reference to a non-existing wallet"); 
        }
        // users linked to wallets as simple array, then indexed by email and user id 
        wallet.users[u.email] = wallet.users["id-" + u.id] =
            wallet.users.indexed[wallet.users.indexed.length] = u;
    });
    // global user collection indexed by email and user id
    poolUsers[u.email] = poolUsers["id-" + u.id] = u; 
});

/**
 * Returns wallet object by address
 * @param {string} walletAddress wallet address
 * @return {*} Wallet object or undefined.
 */
global.getWallet = function(walletAddress) {
    return poolWallets[walletAddress];
};

/**
 * Returns array of users linked to a wallet address
 * @param {string} walletAddress Wallet address
 * @returns {*} Array of users or [] if address is not registered 
 */
global.getWalletUsers = function(walletAddress) {
    var w = poolWallets[walletAddress];
    return w ? w.users.indexed : [];
};

/**
 * Returns a user with specified email address
 * @param {string} email Email address
 * @returns {*} User object matching the email address or undefined  
 */
global.getEmailUser = function(email) {
    return poolUsers[email];
};
