# grndwrk relay

A mailbox between colleagues' phones and your team's grndwrk, for testers who are not on your Wi-Fi. You host it yourself, on your own Cloudflare account (the free plan is enough). Not wired into grndwrk yet: `grndwrk relay deploy` and joining come next.

## What it can and cannot see

- It keeps **sealed envelopes** (AES-256-GCM). The key that seals a phone's envelopes is made from the phone's own key, which the relay never gets. It cannot read a comment or a picture, and a changed or moved envelope fails to open.
- It knows each phone's **signing key**, so it can refuse requests that are not from a phone the team let in. Requests are signed like `--lan`: method, path, time, a nonce and a hash of the body, within five minutes, each nonce once.
- The team signs in with a key made from the **team key**. The team key itself never reaches the relay; neither does the part of it that seals the phones' keys for teammates.
- An invite is known to the relay only by a hash of its secret. A phone can join with it once, within seven days.
- Envelopes are deleted once fetched, or after 30 days. A phone can leave at most 120 envelopes and 200 MB an hour, 4 MB each; the relay holds at most 1000 envelopes and 1 GB waiting.

## Code

- `src/relay.ts`: everything the relay does, without Cloudflare, so the tests run on Node (`test/relay.test.ts`).
- `src/crypto.ts`: signing, key derivation and sealing in WebCrypto, shared with grndwrk. The iOS package does the same in CryptoKit.
- `src/worker.ts`: the Worker; every request goes to one Durable Object (SQLite storage).
- `wrangler.toml`: the Worker's settings.
