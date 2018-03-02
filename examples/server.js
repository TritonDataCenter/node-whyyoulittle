var restify = require('restify');
var whyyoulittle = require('../');

var n = 0;
var server = restify.createServer();
var throttle = whyyoulittle.createThrottle({
    concurrency: 2,
    queueTolerance: 2,
})

server.use(function stdTritonResHeaders(req, res, next) {
    res.on('header', function onHeader() {
        res.header('x-request-id', req.getId());
    });
    next();
});

server.get('/status', function (req, res, next) {
    console.log('throttle status: inflight=%d, qlen=%d', throttle.requestQueue.npending, throttle.requestQueue.queued.length)
    res.send(200);
    next();
});

server.use(whyyoulittle.throttleHandler(throttle));

/*
 * GET /boom - Trigger uncaughtException.
 */
server.get('/boom', function (req, res, next) {
    throw new Error('boom');
    next();
});

/*
 * GET /slow - Take 5s to respond. Every third call throws an exception.
 */
server.get('/slow', function (req, res, next) {
    res.setHeader('content-type', 'text/plain');
    setTimeout(function () {
        n += 1;
        if (n % 3 === 0) {
            throw new Error('mod 3 error in req ' + req.getId());
        }
        res.send('slow response at ' + new Date().toISOString() + '\n');
        next();
    }, 5000);
});

server.on('after', whyyoulittle.throttleAfterHandler(throttle));

// An attempt to see if this can be made to work with a server that handles
// uncaught exceptions. tl;dr: It can't.
if (server.handleUncaughtExceptions) {
    server.on('uncaughtException', whyyoulittle.throttleAfterHandler(throttle));
    server.on('uncaughtException', function (req, res, route, e) {
        console.log('    XXX handling uncaughtException req_id %s, %j, err=%s',
            req.getId(), res.headersSent, e && e.message)
        if (res.headersSent) {
            return;
        }

        res.send(new Error(e, e.message || 'unexpected error'));
    });
}

server.listen(8080, function() {
    console.log('%s listening at %s', server.name, server.url);
});