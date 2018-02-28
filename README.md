![why, you little](https://frinkiac.com/meme/Movie/3190604.jpg?b64lines=V2h5LCB5b3UgbGl0dGxlIC0gcmVxdWVzdA==)

# node-whyyoulittle

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

This Node.js module provides restify request throttling support. Eventually
it may be extended to not be specific to a restify server. The code originates
from [MANTA-3284](https://smartos.org/bugview/MANTA-3284) work for
[muskie](https://github.com/joyent/manta-muskie/) (Joyent Manta's webapi).


## Testing

TODO


## Development

Before commit, ensure that the following checks are clean:

    make prepush

Also see the note at the top that https://cr.joyent.us is used for code review
for this repo.


## Releases

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
