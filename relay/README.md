# grndwrk relay

Mailboxes between colleagues' phones and your team's grndwrk, for testers who are not on your Wi-Fi. You host it yourself, on your own Cloudflare account (the free plan is enough): one relay, with a mailbox per project. Someone else using grndwrk sets up their own. grndwrk's side is in `src/relay/` (`grndwrk relay deploy`, `add`, `join`); the iOS package joins and sends through it next.

## Mailboxes

- **One per project,** each a Durable Object with its own storage, keys and limits. A comment goes to the mailbox of the project the phone joined, and only that project's team can fetch it. A key for one mailbox does nothing in another, and a request signed for one cannot be sent to another (the path is signed).
- **Only whoever deployed the relay opens or closes a mailbox,** with the owner key kept on their Mac (the relay has a key made from it, `OWNER_AUTH`). So nobody who finds the relay's address can fill it with mailboxes. The owner key opens no mailbox's contents.

## A staging site

A team can name one staging site per mailbox (`grndwrk relay site https://staging.example.com`, signed as the team). Colleagues then comment from that site in their browser, the same way a phone does:

- The relay serves the Comment button (`/v1/<mailbox>/feedback.js`: `overlay/relay.js` in front of `overlay/feedback.js`, with the relay's address, the mailbox and the site) and its picture library (`/screenshot.js`), and only to a page on that site (by `Referer`); the button itself runs only when the page's origin is the site. A tag left in production does nothing.
- A browser joins with an invite once, pasted into the button, and waits until someone allows it in the map with four digits, as a phone does. Its key is never kept: only the signing and sealing keys made from it, in the site's IndexedDB, as WebCrypto keys that cannot be read back out.
- Its comments are sealed and signed exactly as a phone's (`inbox:<device>`). The relay answers that site's browsers with CORS on a phone's three paths only (`join`, `inbox`, `outbox`), never another origin and never the team's paths.
- grndwrk keeps a comment's address only when it is on the site.
- The scripts are put into the Worker when it is deployed (`src/assets.ts`, written by `grndwrk relay deploy` from the grndwrk that runs it; empty here, so a relay deployed before this serves no button).

## What it can and cannot see

- It keeps **sealed envelopes** (AES-256-GCM). The key that seals a phone's envelopes is made from the phone's own key, which the relay never gets. It cannot read a comment or a picture, and a changed or moved envelope fails to open.
- It knows each phone's **signing key**, so it can refuse requests that are not from a phone the team let in. Requests are signed like `--lan`: method, path, time, a nonce and a hash of the body, within five minutes, each nonce once.
- Each project's team signs in with a key made from that project's **team key**. The team key itself never reaches the relay; neither does the part of it that seals the phones' keys for teammates.
- An invite is known to the relay only by a hash of its secret. A phone can join with it once, within seven days, and is let in only when someone allows it in grndwrk's map, with four digits the phone shows too. Links are `grndwrk:invite/...` and `grndwrk:team/...`, never web addresses, so a browser never takes a secret to the relay's pages (it serves none).
- A nonce is stored only for requests that change something; a read sent again reads again. The team's grndwrk asks for everything in one request (`/sync`) every 15 seconds. Envelopes carry an id and a time sealed inside, and grndwrk refuses one handed over again.
- Envelopes are deleted once fetched, or after 30 days. A phone can leave at most 60 envelopes and 100 MB an hour and 300 and 300 MB a day, 4 MB each; a mailbox holds at most 1000 envelopes and 1 GB waiting.

## Code

- `src/relay.ts`: everything the relay does, without Cloudflare, so the tests run on Node (`test/relay.test.ts`).
- `src/crypto.ts`: signing, key derivation and sealing in WebCrypto, shared with grndwrk. The iOS package does the same in CryptoKit.
- `src/assets.ts`: the staging site's scripts, filled in at deploy.
- `src/worker.ts`: the Worker; each request goes to its mailbox's Durable Object (SQLite storage).
- `wrangler.toml`: the Worker's settings.
- `package.json`, `package-lock.json`: the exact wrangler, and everything under it, that `grndwrk relay deploy` installs in grndwrk's user folder to deploy with.
