/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
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

/*
 * The throttle object maintains all the state used by the throttle. This state
 * consists of the tunables described above, plus optional dtrace probes that
 * help to describe the runtime operation of the throttle.
 *
 * - `options.dtp` is an optional DTrace Provider on which create dtrace probes.
 *   See the DTrace notes in the README.md.
 *
 * Example usage:
 *      var dtrace = require('dtrace-provider');
 *      var whyyoulittle = require('whyyoulittle');
 *
 *      var throttle = whyyoulittle.createThrottle({
 *          concurrency: 50,
 *          queueTolerance: 25,
 *          dtp: dtrace.createDTraceProvider('myapp-throttle')
 *      });
 */
function Throttle(options) {
    assert.number(options.concurrency, 'options.concurrency');
    assert.ok(options.concurrency > 0, 'concurrency must be positive');
    assert.number(options.queueTolerance, 'options.queueTolerance');
    assert.ok(options.queueTolerance > 0, 'queueTolerance must be positive');
    assert.optionalObject(options.dtp, 'options.dtp');

    this.dtp = options.dtp;
    if (this.dtp) {
        this.throttle_probes = {
            // number of occupied slots, number of queued requests,
            // request rate, url, method
            request_throttled: this.dtp.addProbe('request_throttled',
                'int', 'int', 'char *', 'char *'),
            // number of occupied slots, number of queued requests
            request_handled: this.dtp.addProbe('request_handled',
                'int', 'int', 'char *', 'char *'),
            // request id
            queue_enter: this.dtp.addProbe('queue_enter', 'char *'),
            // request id
            queue_leave: this.dtp.addProbe('queue_leave', 'char *')
        };
        this.dtp.enable();
    }

    this.concurrency = options.concurrency;
    this.queueTolerance = options.queueTolerance;

    this.requestQueue = vasync.queue(function (task, callback) {
        task(callback);
    }, this.concurrency);

    this.taskCbFromReqId = {};
}

Throttle.prototype.wait = function wait(req, res, next) {
    var self = this;

    var req_id = req.getId();
    var qlen = self.requestQueue.length();
    var inflight = self.requestQueue.npending;
    var id = req_id.split('-')[0]; // XXX

    if (qlen >= self.queueTolerance) {
        console.log('[%s req %s] throttle: request_throttled', new Date().toISOString(), id);
        if (self.throttle_probes) {
            self.throttle_probes.request_throttled.fire(function () {
                return ([inflight, qlen, req.url, req.method]);
            });
        }
        // XXX don't see point in all this data for throttled error
        // XXX perhaps want req info in the throttled error?
        next(new VError({name: 'ThrottledError'},
            'request throttled, %d of %d inflight reqs, %d of %d queued',
            inflight, self.concurrency, qlen, self.queueTolerance));
        return;
    }

    console.log('[%s req %s] throttle: queue_enter (inflight=%d, qlen=%d)',
        new Date().toISOString(), id, inflight, qlen);
    if (self.throttle_probes) {
        self.throttle_probes.queue_enter.fire(function () {
            return ([req_id]);
        });
    }

    self.requestQueue.push(function doTask(taskCb) {
        console.log('[%s req %s] throttle: queue_leave', new Date().toISOString(), id);
        if (self.throttle_probes) {
            self.throttle_probes.queue_leave.fire(function () {
                return ([req_id]);
            });
        }
        self.taskCbFromReqId[req_id] = taskCb;
        next();
    });

};

Throttle.prototype.afterRequest = function afterRequest(req, res, route, err) {
   console.log('    XXX call afterRequest id=%s err.domain.req.id=%s', req.getId(), (err && err.domain) ? err.domain.members[0].getId() : err)
    var self = this;
    // XXX use separate _throttleReqId
    var reqId = req.getId();
    var taskCb = self.taskCbFromReqId[reqId];
    if (!taskCb) {
        //XXX // warn about this? crash? ignore? it could be fine
        console.log('    XXX warning: no taskCb for reqId', reqId);
        return;
    }
    delete self.taskCbFromReqId[reqId];

    var qlen = self.requestQueue.queued.length;
    console.log('[%s req %s] throttle: request_handled (%s %s, err=%s, inflight=%d, qlen=%d)',
        new Date().toISOString(), req.getId().split('-')[0],
        req.method, req.url, err, self.requestQueue.npending, qlen);
    if (self.throttle_probes) {
        self.throttle_probes.request_handled.fire(function () {
            return ([self.requestQueue.npending, qlen, req.url, req.method]);
        });
    }

    /*
     * Dev Note: When we call this, we are freeing a slot in `requestQueue`
     * for a possibly queued request, which will then start its `doTask`.
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

    createThrottle: function createThrottle(options) {
        return (new Throttle(options));
    },

    // XXX put these in a restify namespace? or put restify in the nmame, or
    //    just doc that for the future
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
