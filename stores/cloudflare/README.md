# A grndwrk store on Cloudflare

An example to copy and change, not a product. It answers every call in [the store protocol](../../docs/store-protocol.md) from a Worker on your own Cloudflare account, with one Durable Object per project. Make it yours: your login, your limits, your logs.

## What it does

- `https://<worker>/<project>/v1/...` is the protocol for one project. A project's name is lowercase letters, digits and dashes (`clinic`, `clinic-staging`). Each project is a Durable Object of its own, with its own files and tokens, so a token for one project does nothing in another.
- Every write needs `If-None-Match: *` or `If-Match`, and the check and the write happen one at a time inside the object, so a stale write is always refused with `412`, never written.
- `changes` keeps each path once, at its latest change, so a cursor is a number. Pages hold at most 500 changes (`more: true` for the rest). A long poll (`wait`, up to 25 seconds) is held in the object until the next write. Deletions are kept, so a cursor this store gave never goes stale; a cursor it never gave gets `410`.
- Files are served with `nosniff` and a sandboxing Content-Security-Policy, and never rendered.

## Storage: chunks in the Durable Object

A Durable Object keeps at most 128 KiB in one value (more on the SQLite backend, which this uses), and the protocol allows text up to 1 MB, pictures up to 10 MB and comments up to 14 MB. Each file is kept in chunks of 120 KiB under keys of their own version (`blob:<version>:<n>`), then a small record points at them (`meta:<path>`). A reader never sees half a file, and the old version's chunks are deleted after the new one is in place.

Why not R2: one binding, one thing to deploy, nothing to clean up in two places, and the free plan's Durable Object storage is plenty for a map of text and screenshots. If your team keeps many large pictures, move chunks over a size to an R2 bucket in `store.ts` (`write` and `read`).

## Deploy

On your own account, from this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put OWNER_AUTH      # a long random string; keep it, it mints tokens
```

`package.json` pins wrangler, the same version grndwrk's relay uses. It is not a dependency of grndwrk.

## Tokens (the default)

Whoever has `OWNER_AUTH` hands out tokens, one per person or device, per project. The store keeps only a SHA-256 hash of each, and shows a token once.

```
# A teammate's Mac, which syncs the map
curl -X POST https://grndwrk-store.<you>.workers.dev/clinic/admin/tokens \
  -H "Authorization: Bearer $OWNER_AUTH" \
  -d '{"role": "write", "label": "Front desk Mac"}'

# Someone who only reads the map
  -d '{"role": "read", "label": "Practice manager"}'

# A tester's phone that leaves comments: its commenter id, and the name grndwrk shows
  -d '{"role": "comment", "commenter": "dev_frontdesk1", "name": "Front desk"}'
```

The answer holds `id` and `token`. `GET .../clinic/admin/tokens` lists them without their secrets; `DELETE .../clinic/admin/tokens/<id>` revokes one at once.

A comment token may only `PUT inbox/<its commenter>/<id>.json` with `If-None-Match: *` and `GET status/<its commenter>.json`; everything else is `403`. When the token has a name, the store writes it as `from` in the comment, whatever the device sent.

## Cloudflare Access (an option)

If your team already signs in through Cloudflare Access, put the Worker behind an Access application and set three variables (in `wrangler.toml` or the dashboard):

- `ACCESS_TEAM`: `<your team>.cloudflareaccess.com`
- `ACCESS_AUD`: the application's audience tag
- `ACCESS_ROLES`: per project, emails (or `*@domain`) and their role, as JSON: `{"clinic": {"vet@clinic.example": "write", "*@clinic.example": "read"}}`

A request without a token is then let in by the JWT Access signs (`Cf-Access-Jwt-Assertion`), checked against your team's keys and audience. The store never believes the `Cf-Access-Authenticated-User-Email` header on its own: a Worker is often reachable on workers.dev too, where anyone can send it. A `comment` role through Access names the commenter after a hash of the email and shows the email as its name. grndwrk on a Mac still needs a token, since it cannot sign in to Access itself.

## Check it

```
grndwrk store check https://grndwrk-store.<you>.workers.dev/clinic/ --token <a write token>
```

Run it against a project with nothing in it that matters yet. The same check runs in grndwrk's tests against this code, without Cloudflare (`test/store-cloudflare.test.ts`).

## Code

- `src/store.ts`: everything the store does, over any key-value storage, without Cloudflare imports.
- `src/access.ts`: the Cloudflare Access option.
- `src/worker.ts`: the Worker; each request goes to its project's Durable Object.
- `wrangler.toml`, `package.json`, `package-lock.json`: the Worker's settings and the exact wrangler to deploy with.

Not here, and worth adding for real use: limits per token on how much a commenter may send, CORS for a staging site's Comment button, and pruning deletions from the log after a while (then answer older cursors with `410`).
