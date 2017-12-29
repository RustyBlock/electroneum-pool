const fs = require('fs')
require('../lib/auth.js')

const expect = require('chai').expect
const assert = require('chai').assert

describe('Authentication module', function () {
  
  it('exports getWallet global API', function * () {
    assert.exists(getWallet);
  });

  it('finds a wallet object by address', function * () {
    getWallet('etnkNn3izXrXazWDgZo2LYECBeyTDmJxqedxtFsRNP1hb5znsr36dxp8EPz4svfGAXXMTkHJ7rGHFJYSFhVRSVUY8WJ3zzKJrQ', 
      function(w){
        assert.isTrue(typeof w !== 'undefined');
        assert.isTrue(typeof w.users !== 'undefined');
        assert.isAbove(w.users.length, 0);
      }, function(err) {
        assert.fail("error", "success", err.toString());
      });
  });

  it('doesn\'t find a wallet object by address', function * () {
    getWallet('non-existing-address', 
      function(w){
        assert.isTrue(typeof w === 'undefined');
      }, function(err) {
        assert.fail("error", "success", err.toString());
      });
  });
  
});