var poolHosts = {
    "etn": "etn.rustyblock.com",
    "xhv": "xhv.rustyblock.com"
};
var blockchainExplorers = {
    "etn": "https://blockexplorer.electroneum.com/block/",
    "xhv": "https://explorer.havenprotocol.com/block/"
};
var transactionExplorers = {
    "etn": "https://blockexplorer.electroneum.com/tx/",
    "xhv": "https://explorer.havenprotocol.com/tx/"
};
var coinUnitSizes = {
    "etn": 100,
    "xhv": 1000000000000
};
var coinDecimals = {
    "etn": 2,
    "xhv": 4
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
var api = (isHttps ? 'https' : 'http') + "://api." + poolHost;
var coinSymbol = GetCoinSymbol(), coinUnits = coinUnitSizes[coinSymbol],
    coinDecimalPlaces = coinDecimals[coinSymbol];
