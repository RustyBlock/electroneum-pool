module.exports = function(req, res) {
    var host = req.get('Host').toLowerCase();
    if (host.indexOf('.rustylock.club') > 0 || req.get('X-Forwarded-Proto') !== 'https' || 
        host.indexOf('www') !== 0) {
      return res.redirect(301, 'https://www.etn.rustyblock.com' + req.originalUrl);
    }    
}