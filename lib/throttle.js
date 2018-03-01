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
}

Throttle.prototype.wait = function wait(req, res, next) {
    var self = this;

    var req_id = req.getId();
    var id = req_id.split('-')[0];
    console.log('[%s req %s] throttle: start', new Date().toISOString(), id);

    if (self.requestQueue.length() >= self.queueTolerance) {
        console.log('[%s req %s] throttle: throttled (q.length >= tolerance: %d >= %d)', new Date().toISOString(), id,
            self.requestQueue.length(), self.queueTolerance);
        if (self.throttle_probes) {
            self.throttle_probes.request_throttled.fire(function () {
                return ([self.requestQueue.npending, self.requestQueue.length(),
                    req.url, req.method]);
            });
        }
        var state = {
            queuedRequests: self.requestQueue.npending,
            inFlightRequests: self.requestQueue.length()
        };
        var cfg = {
            queueTolerance: self.queueTolerance,
            concurrency: self.concurrency
        };
        next(new VError({name: 'ThrottledError'},
            'request throttled, observed: %j, configured with: %j',
            state, cfg));
        return;
    }

    if (self.throttle_probes) {
        self.throttle_probes.queue_enter.fire(function () {
            return ([req_id]);
        });
    }

    self.requestQueue.push(function doTask(cb) {
        console.log('[%s req %s] throttle: calling next', new Date().toISOString(), id);
        if (self.throttle_probes) {
            self.throttle_probes.queue_leave.fire(function () {
                return ([req_id]);
            });
        }
        next();

        // XXX shouldn't this only be called when the full req handling is done?
        cb();
    });
    console.log('[%s req %s] throttle: pushed on requestQueue', new Date().toISOString(), id);

    if (self.throttle_probes) {
        self.throttle_probes.request_handled.fire(function () {
            return ([self.requestQueue.npending, self.requestQueue.length(),
                req.url, req.method]);
        });
    }
};


// ---- Exports

module.exports = {

    createThrottle: function createThrottle(options) {
        return (new Throttle(options));
    },

    throttleHandler: function throttleHandler(throttle) {
        function throttleRequest(req, res, next) {
            throttle.wait(req, res, next);
        }
        return (throttleRequest);
    }

};
