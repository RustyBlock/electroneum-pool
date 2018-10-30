module.exports = function(req) {
    var ctx = {
        currency: {
            code: 'ETN',
            name: 'Electroneum'
        },
        supportedCurrencies: [
            {
                code: 'ETN',
                name: 'Electroneum',
                homePage: 'https://electroneum.com/',
                logo: 'images/logo.png',
                coinMarketId: 2137,
                walletPrefix: [['etn', 98],['f4V', 109]],
                warningHtml: '<p><a href="https://play.google.com/store/apps/details?id=etn.rusty.block" target="_blank"><img src="images/gplay_badge_small.png">Download our new monitoring app</a> for Android and tell us what you think.</p>',
                walletPromptHtml: '<strong>We support direct mining to exchange accounts with Payment ID, e.g. <a href="https://www.kucoin.com/#/trade.pro/ETN-BTC" target="_blank">KuCoin</a>, <a href="https://accounts.qryptos.com/sign-up?affiliate=LkK_26BZ309235" target="_blank">Qryptos</a>,  <a href="https://www.cryptopia.co.nz/Exchange" target="_blank">Cryptopia</a> and <a href="https://electroneum.com/exchanges/" target="_blank">others</a>.</strong> Use hyphen symbol (-) to separate your ETN wallet address and Payment ID. '+
                    'For example <span style="font-family:Courier New, Courier, monospace">etnjzKFU6ogESSKRZZbdq...BWYqtchtq9tBap8Qr4M<b style="color:chocolate;">-a6e59f7bb27d9ba...8b6df</b></span>.',
                paperWalletHtml: '<a href="https://downloads.electroneum.com/offline_paper_electroneum_walletV1.6.html" style="float:left;padding: 4px;margin: 4px 10px 0 0;background-color: black;" target="_blank">'+
                    '<img alt="Electroneum paper (offline) wallet generator" width="195" '+
                    'src="images/paper-wallet.png" /></a><span>An offline wallet is a public Electroneum wallet that you can transfer funds to that was not generated on the Internet. Please keep the generated PDF document safe and secure. There is no way to recover it if it\'s lost or stolen.</span>',
                desktopWalletPrompt: 'Official Electroneum mobile wallet',
                walletDownloadHtml: '<a href="https://play.google.com/store/apps/details?id=com.electroneum.mobile" style="float:left; target="_blank">'+
                    '<img alt="Get it on Google Play" src="images/gplay_badge_medium.png"/></a>'
            }, {
                code: 'XHV',
                name: 'Haven Protocol',
                homePage: 'https://havenprotocol.com/',
                logo: 'images/logoXHV.png',
                coinMarketId: 2662,
                walletPrefix: [['hvx', 98],['hvi', 109]],
                warningHtml: '',
                walletPromptHtml: '<strong>We support direct mining to exchange accounts with Payment ID, e.g. <a href="https://www.southxchange.com/Market/Book/XHV/BTC" target="_blank">southXchange</a>.</strong> Use hyphen symbol (-) to separate your XHV wallet address and Payment ID. '+
                    'For example <span style="font-family:Courier New, Courier, monospace">hvxyC6NNG4zMSX4sA8hUe...gsuvoyjAyq3o8o2JsEpX<b style="color:chocolate;">-b02000cccc124e...e548f</b></span>.',
                paperWalletHtml: '<a href="https://havenwallet.com/#/" style="float:left;margin: 4px 4px 0 0;" target="_blank">'+
                    '<img alt="Haven paper (offline) wallet generator" '+
                    'src="images/havenWallet.png" /></a><span>An offline wallet is a public Haven Protocol wallet that you can transfer funds to that was not generated on the Internet.<br/>'+
                    'Please keep the generated <b>Mnemonic seed</b> safe and secure. There is no way to recover it if it\'s lost or stolen.</span>',
                desktopWalletPrompt: 'Official desktop wallets',
                walletDownloadHtml: '<a href="https://havenprotocol.com/#downloads" style="float:left;margin: 4px 4px 0 0;" target="_blank">'+
                    '<img alt="Download desktop wallet for Haven Protocol" src="images/havenWallets.png" /></a>',
                miningInstructions: '../static/pages/xhv.downloads.html'
            }
        ]
    };

    ctx.currency = getCurrencyFromRequest(ctx, req);
    return ctx;
};

function getCurrencyFromRequest(ctx, req) {
    var subs = req.hostname.split('.').reverse();
    var retVal = JSON.parse(JSON.stringify(ctx.supportedCurrencies[0]));
    if(subs.length < 3) {
        var curr = ctx.supportedCurrencies[0];
        log('warn', logSystem, 'Failed to determine coin from host address %s, defaulted to %s', [req.hostname, retVal.code]);
        return retVal;
    }
    subs[2] = subs[2].toLowerCase(); // expect 3rd level domain is currency code
    for(var i=1; i<ctx.supportedCurrencies.length;i++) {
        var cur = ctx.supportedCurrencies[i].code.toLowerCase();
        if(cur === subs[2]) {
            retVal = JSON.parse(JSON.stringify(ctx.supportedCurrencies[i]));
            break;
        }
    }
    return retVal;
}
