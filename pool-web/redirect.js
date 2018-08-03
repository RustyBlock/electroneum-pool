module.exports = function(req, res) {
    var host = req.get('Host').toLowerCase();
    // redirect old domain to new and all to HTTPS
    if(host.indexOf('.rustylock.club') > 0 || req.get('X-Forwarded-Proto') !== 'https' || 
        host.indexOf('www') !== 0) {
      return res.redirect(301, 'https://www.etn.rustyblock.com' + req.originalUrl);
    }
    // fix URL format broken by automated newsletters - they add '?...' after '#...'
    if(req.originalUrl.indexOf('?') > 0 && req.originalUrl.substr(1,1) === '#') {
        log('info', 'poolweb', 'URL: %s', [req.originalUrl]);
        var parts = req.originalUrl.substr(1).split('?');
        if(parts.length != 2) { // multiple question marks in the URL, don't know what to do with it
            return;
        }
        return res.redirect(301, 'https://www.etn.rustyblock.com/?' + parts[1] + parts[0]);
    }
}
