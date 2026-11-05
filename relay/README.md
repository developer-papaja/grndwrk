# grndwrk relay

Mailboxes between colleagues' phones and your team's grndwrk, for testers who are not on your Wi-Fi. You host it yourself, on your own Cloudflare account (the free plan is enough): one relay, with a mailbox per project. Someone else using grndwrk sets up their own. Not wired into grndwrk yet: `grndwrk relay deploy` and joining come next.

## Mailboxes

- **One per project,** each a Durable Object with its own storage, keys and limits. A comment goes to the mailbox of the project the phone joined, and only that project's team can fetch it. A key for one mailbox does nothing in another, and a request signed for one cannot be sent to another (the path is signed).
- **Only whoever deployed the relay opens or closes a mailbox,** with the owner key kept on their Mac (the relay has a key made from it, `OWNER_AUTH`). So nobody who finds the relay's address can fill it with mailboxes. The owner key opens no mailbox's contents.

## What it can and cannot see

- It keeps **sealed envelopes** (AES-256-GCM). The key that seals a phone's envelopes is made from the phone's own key, which the relay never gets. It cannot read a comment or a picture, and a changed or moved envelope fails to open.
- It knows each phone's **signing key**, so it can refuse requests that are not from a phone the team let in. Requests are signed like `--lan`: method, path, time, a nonce and a hash of the body, within five minutes, each nonce once.
- Each project's team signs in with a key made from that project's **team key**. The team key itself never reaches the relay; neither does the part of it that seals the phones' keys for teammates.
- An invite is known to the relay only by a hash of its secret. A phone can join with it once, within seven days.
- Envelopes are deleted once fetched, or after 30 days. A phone can leave at most 120 envelopes and 200 MB an hour, 4 MB each; a mailbox holds at most 1000 envelopes and 1 GB waiting.

## Code

- `src/relay.ts`: everything the relay does, without Cloudflare, so the tests run on Node (`test/relay.test.ts`).
- `src/crypto.ts`: signing, key derivation and sealing in WebCrypto, shared with grndwrk. The iOS package does the same in CryptoKit.
- `src/worker.ts`: the Worker; each request goes to its mailbox's Durable Object (SQLite storage).
- `wrangler.toml`: the Worker's settings.
