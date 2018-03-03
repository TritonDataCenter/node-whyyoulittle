![why, you little](https://frinkiac.com/meme/Movie/3190604.jpg?b64lines=V2h5LCB5b3UgbGl0dGxlIC0gcmVxdWVzdA==)

# node-whyyoulittle

This is a Node.js module that provides [restify](http://restify.com/) middleware
to throttle requests based on the number of inflight requests. It is similar
to restify 5.x+'s built in
[inflightRequestThrottle](http://restify.com/docs/plugins-api/#inflightrequestthrottle),
but adds support for queueing N requests when the concurrency limit is reached.
The primary use case for this middleware is to allow a server to ensure its
processing stays within its resource limits.
See "Increased latency and resource exhaustion" in the [Fail at
Scale](https://queue.acm.org/detail.cfm?id=2839461) paper for some inspiration
-- though this module does not (yet?) support many of the techniques described
there.

The code originates from [MANTA-3284](https://smartos.org/bugview/MANTA-3284)
work for [muskie](https://github.com/joyent/manta-muskie/) (Joyent Manta's
webapi), see also [MANTA-3591](https://smartos.org/bugview/MANTA-3591).

(This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.)


## Overview

The throttling support provides a configurable queue for incoming requests that
will:

- limit the number of concurrent requests being handled (`concurrency`),
- have a number of requests beyond that that it will queue (`queueTolerance`),
  and
- respond with HTTP 503s (the throttle error is configurable) for requests
  beyond that.

This middleware isn't compatible with restify servers that handle uncaught
exceptions. See the "Warning" section below.


## Usage

There are four pieces to using this throttle with a restify server:

1. Ensure your server does *not* handle uncaught exceptions via
   `handleUncaughtExceptions: false`. See the "Warning" section below.
2. Create the throttle with `whyyoulittle.createThrottle(...)`.
3. Add the throttle handler. This can be a `server.pre` to have it apply
   to all routes and before routing is done (which is good to avoid excess
   processing if a req will be throttled), a `server.use` that is perhaps
   added after some endpoints are mounted (e.g. excluding a ping or
   debugging endpoints), a handler anywhere on an endpoint chain (e.g. if
   restricting throttling to a certain endpoint).
4. Add the `server.on('after', ...)` handler. This is used to know when an
   inflight request is complete, to release another from the queue, if there
   are any.


```js
var assert = require('assert');
var dtrace = require('dtrace-provider'); // optional
var restify = require('restify');
var whyyoulittle = require('whyyoulittle');

var server = restify.createServer({
    handleUncaughtExceptions: false,
    // ...
});

var throttle = whyyoulittle.createThrottle({
    concurrency: CONCURRENCY,
    queueTolerance: QUEUE_TOLERANCE,
    // Optional:
    createThrottledError: function create503(throttle, req) {
        return new restify.ServiceUnavailableError('request throttled');
    },
    dtraceProvider: dtrace.createDTraceProvider('myapp-throttle')
})

server.pre(whyyoulittle.throttleHandler(throttle));
// Or can be `server.use(...)` if you want to mount it after some request
// processing, or exclude some routes define above this point:
//      server.use(whyyoulittle.throttleHandler(throttle));

server.on('after', whyyoulittle.throttleAfterHandler(throttle));

// ...
```

There is [a more complete example server.js here](./examples/server.js).


### Warning: handleUncaughtExceptions

This middleware is not compatible with a restify server that handles
`uncaughtException`s because of the interaction with domains used to implemented
this. See [this issue](https://github.com/joyent/node-whyyoulittle/issues/1) and
[this block comment](https://github.com/joyent/node-whyyoulittle/blob/f930bdb85f70ccd33e4411743f27684a61c46cc1/lib/throttle.js#L268-L289)
for details.

If you use this throttle with `handleUncaughtExceptions: true` it is possible
that requests that throw an error will not correctly be removed from the
"inflight" count. Enough of those and the throttle will be jammed shut,
never scheduling subsequent requests.

Restify versions up to and including 4.x handle uncaught exceptions
by default. The latest 4.x and later support [`handleUncaughtExceptions:
false`](http://restify.com/docs/server-api/#createserver). Starting in restify
5.x the default behaviour is `handleUncaughtExceptions: false`.


## Bunyan Logging

Throttling details are logged via the restify `req.log`, [if that is setup
on your restify server](http://restify.com/docs/request-api/#log). All
log records from this module are at the TRACE-level and include a
`throttle: true`. The latter is useful for watching just throttle-related
logs, e.g. via:

    node server.js > >(bunyan -c this.throttle)

See [examples/server.js](./examples/server.js) for a server that sets up
logging. An [example run showing logs is
here](https://gist.github.com/trentm/04a229a102b485141e3b35c58366c913).


## DTrace probes

TODO: describe this. For now, some ideal is provided in the "muskie-throttle"
dtrace probes docs at https://github.com/joyent/manta-muskie/#dtrace-probes


## Development

The following sections are about developing this module.

### Testing

TODO


### Commiting

Before commit, ensure that the following passes:

    make check fmt

You can setup a local git pre-commit hook that'll do that by running

    make git-hooks

Also see the note at the top that https://cr.joyent.us is used for code review
for this repo.


### Releasing

Changes with possible user impact should:

1. Add a note to the changelog (CHANGES.md).
2. Bump the package version appropriately.
3. Once merged to master, the new version should be tagged and published to npm
   via:

        make cutarelease

   To list to npm accounts that have publish access:

        npm owner ls whyyoulittle

The desire is that users of this package use published versions in their
package.json `dependencies`, rather than depending on git shas.
