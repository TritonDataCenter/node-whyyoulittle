/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var uuidv4 = require('uuid/v4');
var vasync = require('vasync');
var VError = require('verror');

/*
 * High Level Operation
 *
 * This module exports a 'wait' method, which serves as the entry point
 * to all throttling operations the module provides. Users of the module
 * simply call the 'wait' function in a request-processing code path,
 * passing in a callback representing the work required to handle the
 * request. Currently, 'req' and 'res' arguments are also supplied
 * because the throttle is plugged in as restify middleware in muskie.
 * Future iterations of this throttle will aim to be generic across all
 * communication protocols, requiring only an argumentless work function
 * as input.
 *
 * The operation of wait() can be summarized as follows:
 *  - If the number of queued requests exceeds 'queueTolerance',
 *    throttle the incoming request and return.
 *  - Else, put the incoming request-processing function on the request
 *    queue. This will result in either the request callback being
 *    scheduled immediately or, if all slots are occupied, being put on
 *    the request queue.
 *
 * Overview of Tunables and Tradeoffs
 *
 * The following parameters are implemented as tunables.
 *
 * queueTolerance - the number of requests the throttle can queue before
 * it starts sending indications that requests have been throttled to
 * clients. There is one 'global' queue to which incoming request are
 * added if all 'concurrency' slots in a vasync queue are occupied.
 *
 * Higher 'queueTolerance' values make it less likely that the throttle
 * will reject incoming requests and will increase muskies memory footprint
 * during period of high load. Lower 'queueTolerance' values make it more
 * likely that muskie will reject incoming requests.
 *
 * concurrency - the number of slots the request queue has for scheduling
 * request-handling worker callbacks concurrently. When all the slots are
 * filled, the throttle will queue up to 'queueTolerance' callbacks before
 * throttling requests.
 *
 * Higher 'concurrency' values allow the using server to handle more requests
 * concurrently and also makes it less likely that requests will spend time in
 * the queue and/or be throttled. Lower 'concurrency' values restrict
 * the number of requests the server can handle at once and make it more likely
 * that requests will spend time in the queue and/or be throttled.
 *
 * To prevent dropping incoming traffic needlessly, it is recommended that
 * lower 'concurrency' values be accompanied by proportionally higher
 * 'queueTolerance' values. Higher 'concurrency' values will result in
 * more requests be handled concurrently, and thus fewer requests being
 * queued (assuming the same load as in the previous scenario). This is
 * effectively a CPU/memory trade-off.
 */

function defaultCreateThrottledError(throttle, req) {
    return (new VError({name: 'ThrottledError'}, 'request throttled'));
}

/*
 * The throttle object maintains all the state used by the throttle. This state
 * consists of the tunables described above, plus optional dtrace probes that
 * help to describe the runtime operation of the throttle.
 *
 * - `opts.dtraceProvider` is an optional DTrace Provider on which to
 *   create dtrace probes and fire them for throttling events.
 *   See the DTrace notes in the README.md.
 * - `opts.createThrottledError` is an optional function that will be called
 *   to create an Error instance when a request is throttled. It is called as
 *   `function (throttle, req)`. By default an error named `ThrottledError`
 *   with message `request throttled` is created. To get a restify 503 error
 *   one might want:
 *      function create503(throttle, req) {
 *          return new restify.ServiceUnavailableError('request throttled');
 *      }
 *
 * Logging is done on `req.log`, if it is present (typically via
 * https://github.com/restify/node-restify/blob/master/lib/plugins/bunyan.js).
 * All logging is at the TRACE-level and with the `throttle: true` field.
 *
 * Example usage:
 *      var dtrace = require('dtrace-provider');
 *      var whyyoulittle = require('whyyoulittle');
 *
 *      var throttle = whyyoulittle.createThrottle({
 *          concurrency: 50,
 *          queueTolerance: 25,
 *          dtraceProvider: dtrace.createDTraceProvider('myapp-throttle')
 *      });
 */
function Throttle(opts) {
    assert.number(opts.concurrency, 'opts.concurrency');
    assert.ok(opts.concurrency > 0, 'concurrency must be positive');
    assert.number(opts.queueTolerance, 'opts.queueTolerance');
    assert.ok(opts.queueTolerance > 0, 'queueTolerance must be positive');
    assert.optionalObject(opts.dtraceProvider, 'opts.dtraceProvider');
    assert.optionalFunc(opts.createThrottledError, 'opts.createThrottledError');

    this.concurrency = opts.concurrency;
    this.queueTolerance = opts.queueTolerance;

    this._dtp = opts.dtraceProvider;
    if (this._dtp) {
        this._dtProbes = {
            // number of inflight reqs, number of queued reqs, url, method
            request_throttled: this._dtp.addProbe('request_throttled',
                'int', 'int', 'char *', 'char *'),
            // number of inflight reqs, number of queued reqs
            request_handled: this._dtp.addProbe('request_handled',
                'int', 'int', 'char *', 'char *'),
            // request id
            queue_enter: this._dtp.addProbe('queue_enter', 'char *'),
            // request id
            queue_leave: this._dtp.addProbe('queue_leave', 'char *')
        };
        this._dtp.enable();
    }

    this.createThrottledError = opts.createThrottledError
        || defaultCreateThrottledError;

    this.requestQueue = vasync.queue(function performTask(task, callback) {
        task(callback);
    }, this.concurrency);

    this._taskCbFromWylReqId = {};
}

Throttle.prototype.wait = function wait(req, res, next) {
    var self = this;

    var inflight = self.requestQueue.npending;
    var nqueued = self.requestQueue.queued.length;
    var reqId = req.getId();
    /*
     * Request IDs *can* be re-used if the client passes in an [x-]request-id
     * header. E.g., Triton workflows will sometimes re-use a single UUID for
     * the request id for multiple requests to various services.
     *
     * For `afterRequest` handling, the Throttle needs to keep those requests
     * separate, so we generate our own and stuff it on the `req` object. It
     * also helps in `afterRequest` to recognize requests that are not expected
     * to be in the throttle queue.
     */
    var wylReqId = uuidv4();

    if (nqueued >= self.queueTolerance) {
        req.log && req.log.trace(
            {throttle: true, wylReqId: wylReqId, inflight: inflight, nqueued: nqueued},
            'request_throttled');
        if (self._dtProbes) {
            self._dtProbes.request_throttled.fire(function () {
                return ([inflight, nqueued, req.url, req.method]);
            });
        }
        var err = self.createThrottledError(self, req);
        next(err);
        return;
    }

    req._wylReqId = wylReqId;

    req.log && req.log.trace(
        {throttle: true, wylReqId: wylReqId, inflight: inflight, nqueued: nqueued},
        'queue_enter');
    if (self._dtProbes) {
        self._dtProbes.queue_enter.fire(function () {
            return ([reqId]);
        });
    }

    self.requestQueue.push(function aTask(taskCb) {
        req.log && req.log.trace(
            {throttle: true, wylReqId: wylReqId, inflight: self.requestQueue.npending, nqueued: self.requestQueue.queued.length},
            'queue_leave');
        if (self._dtProbes) {
            self._dtProbes.queue_leave.fire(function () {
                return ([reqId]);
            });
        }

        self._taskCbFromWylReqId[wylReqId] = taskCb;
        next();
    });

};

Throttle.prototype.afterRequest = function afterRequest(req, res, route, err) {
    var self = this;
    var wylReqId = req._wylReqId;

    if (!wylReqId) {
        // This isn't a throttled request.
        return;
    }

    var taskCb = self._taskCbFromWylReqId[wylReqId];
    assert.func(taskCb, 'expect a taskCb for req wylReqId=' + wylReqId);
    delete self._taskCbFromWylReqId[wylReqId];

    var inflight = self.requestQueue.npending;
    var nqueued = self.requestQueue.queued.length;
    req.log && req.log.trace(
        {throttle: true, wylReqId: wylReqId, inflight: inflight, nqueued: nqueued},
        'request_handled');
    if (self._dtProbes) {
        self._dtProbes.request_handled.fire(function () {
            return ([inflight, nqueued, req.url, req.method]);
        });
    }

    /*
     * Dev Note: When we call this, we are freeing a slot in `requestQueue`
     * for a possibly queued request, which will then start its `aTask`.
     * If restify's usage of domains is active (i.e.
     * `server.handleUncaughtExceptions=true`) then the subsequent processing
     * for this request is accidentally *on the domain for the request we
     * just finished*.
     *
     * This is a problem because if the newly unqueued request has an
     * uncaughtException, then any possible hook to this `afterRequest`:
     *      server.on('after', wyl.throttleAfterHandler(throttle));
     * or
     *      server.on('uncaughtException', wyl.throttleAfterHandler(throttle));
     * will be called with the wrong request (the earlier one).
     * I don't know of a way around this. Restify does not expose that
     * per-request domain on which we could `domain.bind(taskCb)`.
     *
     * As a result a limitation of this module it cannot be used with a restify
     * server with `handleUncaughtExceptions=true`. If it *is*, then requests
     * that throw those exceptions will be zombies in this queue and will
     * eventually clog it up.
     */
    taskCb();
};


// ---- Exports

module.exports = {
    createThrottle: function createThrottle(opts) {
        return (new Throttle(opts));
    },

    throttleHandler: function throttleHandler(throttle) {
        function throttleRequest(req, res, next) {
            throttle.wait(req, res, next);
        }
        return (throttleRequest);
    },

    throttleAfterHandler: function throttleAfterHandler(throttle) {
        function throttleAfterRequest(req, res, route, err) {
            throttle.afterRequest(req, res, route, err);
        }
        return (throttleAfterRequest);
    }
};
