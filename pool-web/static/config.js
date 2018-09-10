var poolHosts = {
    "etn": "etn.rustyblock.com:8117",
    "xhv": "xhv.rustyblock.com:9117"
};
var blockchainExplorers = {
    "etn": "https://blockexplorer.electroneum.com/block/",
    "xhv": "https://explorer.havenprotocol.com/block/"
};
var transactionExplorers = {
    "etn": "https://blockexplorer.electroneum.com/tx/",
    "xhv": "https://explorer.havenprotocol.com/tx/"
};
window.GetCoinSymbol = function() {
    if(window._coinSymbol) {
        return window._coinSymbol;
    }
    var hostNames = window.location.hostname.split("."), topName = hostNames[0].toLowerCase();
    if(topName === 'www' || topName === 'dev') {
        topName = hostNames[1].toLowerCase();
    }
    window._coinSymbol = topName;
    return topName;
};
var poolHost = poolHosts[GetCoinSymbol()];
var email = "admin@rustyblock.com";
var blockchainExplorer = blockchainExplorers[GetCoinSymbol()];
var transactionExplorer = transactionExplorers[GetCoinSymbol()];

//noinspection JSUnusedGlobalSymbols
var isHttps = location.protocol === 'https:';
var api = (isHttps ? 'https' : 'http') + "://devapi." + poolHost;
var coinUnits = 100;
var coinDecimalPlaces = 2;
