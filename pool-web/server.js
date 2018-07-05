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

var morgan       = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser   = require('body-parser');
var session      = require('express-session');

require('../lib/configReader.js');

// configuration ===============================================================
mongoose.connect(process.env.rustyDbUrl, { useMongoClient: true }); // connect to our database

require('./config/passport')(passport); // pass passport for configuration

logSystem = 'poolweb';
require('../lib/logger.js');
require('../lib/exceptionWriter.js')(logSystem);

// set up our express application
app.use(morgan('dev')); // log every request to the console
app.use(cookieParser()); // read cookies (needed for auth)
app.use(bodyParser.json()); // get information from html forms
app.use(bodyParser.urlencoded({ extended: true }));

app.use(function (req, res, next) {
    var host = req.get('Host');
    if (host.toLowerCase().indexOf('.rustylock.club') > 0 || req.get('X-Forwarded-Proto') !== 'https') {
      return res.redirect(301, 'https://www.etn.rustyblock.com' + req.originalUrl);
    }
    return next();
});

app.set('view engine', 'ejs'); // set up ejs for templating
app.set('views', path.join(__dirname, '/views'));

// required for passport
app.use(session({
    secret: process.env.rustySessionSecret, // session secret
    resave: true,
    saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session()); // persistent login sessions
app.use(flash()); // use connect-flash for flash messages stored in session

// custom static content integration
app.use('/pages', express.static(path.join(__dirname, '/static/pages')));
app.get('/pages/undefined', function(request, response, next) {
    response.redirect('/login');
  });
app.use('/', express.static(path.join(__dirname,'/static')));

// routes ======================================================================
require('./app/routes.js')(app, passport); // load our routes and pass in our app and fully configured passport

app.listen(port, '0.0.0.0');
log('info', logSystem, 'Started web site on port ' + port);
