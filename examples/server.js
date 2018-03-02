#!/usr/bin/env node --abort-on-uncaught-exception

/*
 * An example showing how to use a throttle with a simple restify server.
 *
 * Setup:
 *      git clone https://github.com/joyent/node-whyyoulittle.git
 *      cd node-whyyoulittle
 *      npm install
 *      npm install -g bunyan  # optional, so you use `bunyan` in the cmd below
 *
 * To see this in action, in one terminal run:
 *      node examples/server.js  > >(bunyan -c this.throttle -o short)
 *
 * In another terminal, call it 10 times:
 *      for i in `seq 1 10`; do sleep 0.3; (curl -i localhost:8080/slow &) ; done
 *
 * Here is the output from one run:
 * https://gist.github.com/trentm/04a229a102b485141e3b35c58366c913
 */

var assert = require('assert');
var bunyan = require('bunyan');
var restify = require('restify');
var whyyoulittle = require('../');

var server = restify.createServer({
    handleUncaughtExceptions: false,
    log: bunyan.createLogger({
        name: 'example-server',
        level: 'trace',
        serializers: restify.bunyan.serializers,
        src: true
    }),
});

var throttle = whyyoulittle.createThrottle({
    concurrency: 2,
    queueTolerance: 2,
    createThrottledError:  function create503(throttle, req) {
        return new restify.ServiceUnavailableError('request throttled');
    }
})

server.use(restify.requestLogger());

server.use(function stdTritonResHeaders(req, res, next) {
    res.on('header', function onHeader() {
        res.header('x-request-id', req.getId());
    });
    next();
});

server.get('/status', function getStatus(req, res, next) {
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

server.get('/boom', function getBoom(req, res, next) {
    throw new Error('boom');
    next();
});

server.get('/slow', function getSlow(req, res, next) {
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