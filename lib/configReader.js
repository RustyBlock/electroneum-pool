var fs = require('fs');
var url = require('url');

var configFile = (function(){
    for (var i = 0; i < process.argv.length; i++){
        if (process.argv[i].indexOf('-config=') === 0)
            return process.argv[i].split('=')[1];
    }
    return 'config.json';
})();

try {
    global.config = JSON.parse(fs.readFileSync(configFile));
    // set coin property on each port definition for faster access
    for(var i=0; i < config.coins.length; i++) {
        var coin = config.coins[i], ports = config.poolServer.ports[coin];
        for(var j=0; j < ports.length; j++) {
            ports[j].coin = coin;
        }
    }
}
catch(e){
    console.error('Failed to read config file ' + configFile + '\n\n' + e);
    return;
}

global.version = "v0.1";
global.coreDevDonationAddress = global.devDonationAddress = {
    'electroneum' : 'etnkCg2XsNghSa2f6ckETNCP6EHuhemP1ecnPW9ikVcaHMDFkQ1vtE2CY19NPEkFp73ygx3VfUCXD5JJGyKx6HXy2kfDi4eHTu',
    'haven' : 'hvta9ojCiuAXaxLNbDLLWi6xNEzzBJ2He5WSf7He8peuPt4nTyakAFyNuXqrHAGQt1PBSBonCRRj8daUtF7TPXFW42YQhvocsg'
};
global.doDonations = {};
for(var i=0; i<config.coins.length; i++) {
    var coin = config.coins[i];
    global.doDonations[coin] =  devDonationAddress[coin] === config.poolServer.poolAddress[coin] && (
            config.blockUnlocker.devDonation > 0 || config.blockUnlocker.coreDevDonation > 0
        );
}

// return coin by various contexts, e.g. HTTP request or parsed URL
global.config.coin = function(ctx) {
    if(ctx.coinName) {
        return ctx.coinName; // use simple cache
    }

    var hostNames = '', topName = '';
    if(ctx.hostname) { // context is Express request
        hostNames = ctx.hostname.split('.');
    } else if(ctx.method) { // context is http.IncomingMessage
        hostNames = url.parse(ctx.headers.origin ? ctx.headers.origin : ctx.headers.referer).host.split('.');
    } else {
        throw new Error('Unknown context type');
    }

    topName = hostNames[0].toLowerCase();
    if(topName === 'www' || topName === 'api' || topName === 'dev' || topName === 'devapi') {
        topName = hostNames[1].toLowerCase();
    }

    for(var i=0; i<config.symbols.length; i++) {
        if(config.symbols[i].toLowerCase() === topName) {
            return config.coins[i];
        }
    }

    throw new Error('Coin ' + topName + ' not in the config');
};