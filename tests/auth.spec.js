const fs = require('fs')
require('../lib/auth.js')

const expect = require('chai').expect
const assert = require('chai').assert

describe('Authentication module', function () {
  
  it('exports getWallet global API', function * () {
    assert.exists(global.getWallet);
  });

  it('exports getWalletUsers global API', function * () {
    assert.exists(global.getWalletUsers);
  });

  it('finds a wallet object by address', function * () {
    var w = global.getWallet('etnkNn3izXrXazWDgZo2LYECBeyTDmJxqedxtFsRNP1hb5znsr36dxp8EPz4svfGAXXMTkHJ7rGHFJYSFhVRSVUY8WJ3zzKJrQ');
    assert.exists(w);
    assert.exists(w.users);
    assert.exists(w.users.indexed);
  });

  it('finds user objects linked to a wallet address', function * () {
    var u = global.getWalletUsers('etnkNn3izXrXazWDgZo2LYECBeyTDmJxqedxtFsRNP1hb5znsr36dxp8EPz4svfGAXXMTkHJ7rGHFJYSFhVRSVUY8WJ3zzKJrQ')
    
    assert.notEqual(u.length, 0, " number of users");
    assert.notSameDeepMembers(u.splice(u.find(function(e) { return e.id === "1" }), 1), u, " users 1 present");
    assert.notSameDeepMembers(u.splice(u.find(function(e) { return e.id === "2" }), 1), u, " user 2 present");
    assert.notSameDeepMembers(u.splice(u.find(function(e) { return e.id === "4" }), 1), u, " user 4 present");
    assert.equal(u.length, 0, " no users left");
  });

});