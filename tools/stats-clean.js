var redis = require('redis');
require('../lib/configReader.js');
require('../lib/logger.js');

global.redisClient = redis.createClient(config.redis.port, config.redis.host, {auth_pass: config.redis.auth});

var logSystem = 'cleanup';
require('../lib/exceptionWriter.js')(logSystem);

var clean = require("../lib/active-stats");
clean.cleanUp();
