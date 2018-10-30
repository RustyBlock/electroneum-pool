module.exports = function(req, res, next) {
    var host = req.get('Host').toLowerCase();
    // redirect old domain to new and all to HTTPS
    if(host.indexOf('.rustylock.club') > 0 || req.get('X-Forwarded-Proto') !== 'https' || 
        host.indexOf('www') !== 0) {
      return res.redirect(301, 'https://www.etn.rustyblock.com' + req.originalUrl);
    }
    return next();
};
