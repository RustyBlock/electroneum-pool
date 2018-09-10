var cnUtil = require('cryptonote-util');

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

    var addressBase58Prefix;
    if(cnUtil[coin]) {
        addressBase58Prefix = cnUtil[coin];
    } else {
        cnUtil[coin] = addressBase58Prefix = cnUtil.address_decode(new Buffer(config.poolServer.poolAddress[coin]));
    }
    return addressBase58Prefix === cnUtil.address_decode(new Buffer(addr));
};
