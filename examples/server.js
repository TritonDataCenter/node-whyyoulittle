#!/usr/bin/env node --abort-on-uncaught-exception

var assert = require('assert');
var restify = require('restify');
var whyyoulittle = require('../');

var server = restify.createServer({
    handleUncaughtExceptions: false
});
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
    res.send({
        throttle: {
            inflight: throttle.requestQueue.npending,
            qlen: throttle.requestQueue.queued.length
        }
    });
    next();
});

assert.equal(server.handleUncaughtExceptions, false,
    'whyyoulittle.Throttle breaks if using restify handleUncaughtExceptions');
server.use(whyyoulittle.throttleHandler(throttle));

server.get('/boom', function (req, res, next) {
    throw new Error('boom');
    next();
});

server.get('/slow', function (req, res, next) {
    res.setHeader('content-type', 'text/plain');
    setTimeout(function () {
        res.send('slow response at ' + new Date().toISOString() + '\n');
        next();
    }, 5000);
});

server.on('after', whyyoulittle.throttleAfterHandler(throttle));

server.listen(8080, function() {
    console.log('%s listening at %s', server.name, server.url);
});