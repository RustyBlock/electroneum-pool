require('../lib/configReader.js');
require('../lib/logger.js');

var redis = require('redis');
global.redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth});

var api = require('../lib/api');
api.getHashrateHistory(24, 'etnkNn3izXrXazWDgZo2LYECBeyTDmJxqedxtFsRNP1hb5znsr36dxp8EPz4svfGAXXMTkHJ7rGHFJYSFhVRSVUY8WJ3zzKJrQ',
function(rates) {
    console.log(rates.toString());
}, function(error) {
    console.error(error.toString());
});