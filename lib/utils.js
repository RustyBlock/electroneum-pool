var cnUtil = require('cryptoforknote-util');
var addressBase58Prefix = {};
var addressBase58PrefixInt = {};

exports.ringBuffer = function(maxSize){
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
};

exports.varIntEncode = function(n){

};

exports.isValidAddress = function(addr, coin){

    var addrBuf = new Buffer(addr),
        minerPref = cnUtil.address_decode(addrBuf), isIntegrated = false,
        poolPrefs = addressBase58Prefix;

    if(isNaN(minerPref)) {
        minerPref = cnUtil.address_decode_integrated(addrBuf);
        isIntegrated = true;
        poolPrefs = addressBase58PrefixInt;
    }

    var pref;
    if(poolPrefs[coin]) {
        pref = poolPrefs[coin];
    } else {
        if(isIntegrated) {
            pref = poolPrefs[coin] = cnUtil.address_decode_integrated(new Buffer(config.poolServer.poolAddressIntegrated[coin]));
        } else {
            pref = poolPrefs[coin] = cnUtil.address_decode(new Buffer(config.poolServer.poolAddress[coin]));
        }
    }

    return pref === minerPref;
};
