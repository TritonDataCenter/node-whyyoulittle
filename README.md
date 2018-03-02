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



## Development

### Testing

TODO


### Commiting

Before commit, ensure that the following passes:

    make prepush

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
