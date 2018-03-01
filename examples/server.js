var restify = require('restify');
var whyyoulittle = require('../');


var throttle = whyyoulittle.createThrottle({
    concurrency: 2,
    queueTolerance: 2,
})

var server = restify.createServer();

server.use(whyyoulittle.throttleHandler(throttle));

server.get('/slow', function (req, res, next) {
    res.setHeader('content-type', 'text/plain');
    setTimeout(function () {
        res.send('slow response at ' + new Date().toISOString() + '\n');
        next();
    }, 5000);
});

server.on('after', function (req, res, route, err) {
    var id = req.getId().split('-')[0];
    console.log('[%s req %s] after', new Date().toISOString(), id);
});

server.listen(8080, function() {
    console.log('%s listening at %s', server.name, server.url);
});