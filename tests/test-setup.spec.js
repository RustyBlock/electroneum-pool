const sinon = require('sinon')
const chai = require('chai')
const redis = require('redis')

beforeEach(function () {
  this.sandbox = sinon.sandbox.create();
});

afterEach(function () {
  this.sandbox.restore();
});

before(function(){
  global.redisClient = redis.createClient(6379, "127.0.0.1");
  global.config = {};
  global.config.coin = "electroneum";
});
