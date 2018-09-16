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
                promptHtml: 'Calling for ASIC owners to support Electroneum. Happy mining!',
                warningHtml: '<p style="font-size:x-small;font-family: Verdana, Geneva, Tahoma, sans-serif;"><span style="color: red;font-weight: bold;">Orphaned blocks alert!</span> RustyBlock pool recently found multiple orphaned blocks ' +
                    'due to the new mining hardware submitting <b>shares for expired blocks</b> even after the pool\'s notification about new job. We are working on pool improvements to avoid confusions and make sure that expired shares ' +
                    'will not be accepted as blocks. In addition to the fixes for expired shares, we are working on improving transparency of RustyBlock pool by adding <b>live status of our network nodes</b> and real-time tracker for the <b>best shares submitted by miners</b>.</p>',
                walletPromptHtml: '<strong>We support direct mining to exchange accounts with Payment ID, e.g. <a href="https://www.kucoin.com/#/trade.pro/ETN-BTC" target="_blank">KuCoin</a>, <a href="https://accounts.qryptos.com/sign-up?affiliate=LkK_26BZ309235" target="_blank">Qryptos</a>,  <a href="https://www.cryptopia.co.nz/Exchange" target="_blank">Cryptopia</a> and <a href="https://electroneum.com/exchanges/" target="_blank">others</a>.</strong> Use hyphen symbol (-) to separate your ETN wallet address and Payment ID. '+
                    'For example <span style="font-family:Courier New, Courier, monospace">etnjzKFU6ogESSKRZZbdq...BWYqtchtq9tBap8Qr4M<b style="color:chocolate;">-a6e59f7bb27d9ba...8b6df</b></span>.',
                paperWalletHtml: '<a href="https://downloads.electroneum.com/offline_paper_electroneum_walletV1.6.html" style="float:left;padding: 4px;margin: 4px 10px 0 0;background-color: black;" target="_blank">'+
                    '<img alt="Electroneum paper (offline) wallet generator" width="195" '+
                    'src="images/paper-wallet.png" /></a><span>An offline wallet is a public Electroneum wallet that you can transfer funds to that was not generated on the Internet. Please keep the generated PDF document safe and secure. There is no way to recover it if it\'s lost or stolen.</span>',
                desktopWalletPrompt: 'Official Electroneum mobile wallet',
                walletDownloadHtml: '<a href="https://play.google.com/store/apps/details?id=com.electroneum.mobile" style="float:left;margin: 4px 10px 0 0;" target="_blank">'+
                    '<img alt="Get it on Google Play" src="https://developer.android.com/images/brand/en_generic_rgb_wo_45.png" /></a>'
            }, {
                code: 'XHV',
                name: 'Haven Protocol',
                homePage: 'https://havenprotocol.com/',
                logo: 'images/logoXHV.png',
                coinMarketId: 2662,
                walletPrefix: [['hvx', 98],['hvi', 109]],
                warningHtml: '<p style="font-size:x-small;font-family: Verdana, Geneva, Tahoma, sans-serif;"><span style="color: red;font-weight: bold;">Haven Protocol Governance Fee.</span> RustyBlock takes into account ' +
                '<a href="https://www.reddit.com/r/havenprotocol/comments/8ohw6t/haven_v3_hardfork_coming_in_2_weeks/" target="_blank"><b>5% Governance Fee</b> introduced by Haven Protocol community since version 3</a>. ' +
                'Last block reward on the Home page and Reward column on the Stats page display amounts adjusted accordingly, so you may notice the difference of 5% between reward amounts displayed on RustyBlock web site ' +
                'and reward amount on the <a href="https://explorer.havenprotocol.com" target="_blank">Haven Protocol block explorer</a>.</p>',
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
    if(subs.length < 3) {
        throw new Error('Site URL expected to have at least 2 subdomain names');
    }
    subs[2] = subs[2].toLowerCase(); // expect 3rd level domain is currency code
    var retVal = JSON.parse(JSON.stringify(ctx.supportedCurrencies[0]));
    for(var i=1; i<ctx.supportedCurrencies.length;i++) {
        var cur = ctx.supportedCurrencies[i].code.toLowerCase();
        if(cur === subs[2]) {
            retVal = JSON.parse(JSON.stringify(ctx.supportedCurrencies[i]));
            break;
        }
    }
    return retVal;
}
