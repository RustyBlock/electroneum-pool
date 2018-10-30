// server.js

// set up ======================================================================
// get all the tools we need
var express  = require('express');
var app      = express();
var path     = require('path');
var port     = process.env.PORT || 8080;
var mongoose = require('mongoose');
var passport = require('passport');
var flash    = require('connect-flash');
var fs       = require('fs');

var morgan       = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser   = require('body-parser');
var session      = require('express-session');
var redirect     = require('./redirect');
var poolCtx      = require('./config/pool-context');
require('../lib/configReader.js');

// configuration ===============================================================
mongoose.connect(process.env.rustyDbUrl, { useMongoClient: true }); // connect to our database

require('./config/passport')(passport); // pass passport for configuration

globals.logSystem = 'poolweb';
require('../lib/logger.js');
require('../lib/exceptionWriter.js')(logSystem);

// set up our express application
app.use(morgan('dev')); // log every request to the console
app.use(cookieParser()); // read cookies (needed for auth)
app.use(bodyParser.json()); // get information from html forms
app.use(bodyParser.urlencoded({ extended: true }));

app.use(function (req, res, next) {
    var ret = redirect(req, res);
    return ret ? ret : next();
});

app.set('view engine', 'ejs'); // set up ejs for templating
app.set('views', path.join(__dirname, '/views'));
// redirect static html pages to server-side rendered views
app.use('/pages/', function(req, res, next) {
    var filename = req.originalUrl.split('/').pop().split('#')[0].split('?')[0];
    var ext = filename.substr(filename.length - 5).toLowerCase();
    var ejs = __dirname + '/views/' + filename + '.ejs';
    if (ext === '.html' && fs.existsSync(ejs)) {
        //noinspection JSCheckFunctionSignatures
        return res.render(ejs, { req: req, res: res, pool : poolCtx(req) });
    }
    next();
  });

// required for passport
var nao = new Date();
app.use(session({
    secret: process.env.rustySessionSecret, // session secret
    cookie: { domain:'.rustyblock.com', expires: new Date(nao.getFullYear() + 20, nao.getMonth(), nao.getDate()) },
    resave: true,
    saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session()); // persistent login sessions
app.use(flash()); // use connect-flash for flash messages stored in session

app.get('/pages/undefined', function(request, response) {
    response.redirect('/login');
  });
// custom static content integration
app.use('/', express.static(path.join(__dirname,'/static')));

// routes ======================================================================
require('./app/routes.js')(app, passport); // load our routes and pass in our app and fully configured passport

app.listen(port, '0.0.0.0');
log('info', logSystem, 'Started web site on port ' + port);
