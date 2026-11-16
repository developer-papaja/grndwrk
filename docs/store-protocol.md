# The grndwrk store protocol

A grndwrk map is a folder of small files, `.grndwrk/`. A **store** keeps the same files somewhere a team shares: a server, a database, a cloud project. grndwrk keeps `.grndwrk/` as a working copy for the coding agent and syncs it with the store; a page on the store lets people without the repository read the map and answer questions.

The store is yours. Host it anywhere, in any language, on any database, behind any login. This document is the only thing grndwrk needs from it: a handful of calls over the same files. `grndwrk store check` tells you whether your store speaks it.

There are two ways to be a store:

- **Over HTTP:** a server that answers the calls below. grndwrk only knows its address and a token.
- **An adapter:** a JavaScript module in your repository that grndwrk loads to reach your database directly, with the same calls as functions. grndwrk loads it only after you allowed that exact file (`grndwrk store allow`); when the file changes, it stops and asks again.

## Files

A store holds files by **path**, relative to `.grndwrk/`, like `nodes/n_k2m4ab.md` or `files/n_k2m4ab/plan.png`.

- A path is one to eight parts joined by `/`. Each part starts with a letter or digit and holds only letters, digits, `.`, `_` and `-`. At most 300 characters in all. No `..`, no leading `/`, no backslash.
- Two folders hold comments on their way in and their status on the way out, `inbox/` and `status/` (see Comments straight to the store); they are never copied into `.grndwrk/`.
- Only these are synced: `project.md`, and anything under `nodes/`, `threads/`, `stories/`, `screens/`, `personas/`, `segments/`, `waiting/`, `files/`, `readiness/` and `outputs/`. Everything else in `.grndwrk/` belongs to one machine or one repository (`local.json`, `lan-code`, `lan-devices.json`, `shots/`, `store.json`, the agent rules and command lists) and never goes to a store. A store refuses any other path with `400`.
- The path decides a file's type; a `Content-Type` sent with a write is only a hint and never overrides it.
- Types, by the path's extension: `.md` is `text/markdown`, `.json` is `application/json`, `.png` is `image/png`, `.jpg` and `.jpeg` are `image/jpeg`. A store refuses anything else with `415`, and refuses a picture whose bytes are not a PNG or a JPEG.
- Sizes: text up to 1 MB, pictures up to 10 MB. Larger is `413`.

Each file has a **version**: an opaque string of at most 100 characters that the store changes on every write. grndwrk never reads meaning into it; it only sends it back.

## Over HTTP

Your store has an address for each project, like `https://maps.example.com/clinic/`. grndwrk adds `v1/...` to it.

Every request carries `Authorization: Bearer <token>`. How a person gets a token is up to you (a page after your login, an invite, a key you hand out); grndwrk keeps it on that person's machine, never in the project. Without a valid token, answer `401`. A token that may read but not write gets `403` on writes.

Errors are JSON, `{ "error": "Plain words" }`.

### `GET v1/hello`

```json
{ "protocol": 1, "project": "Clinic", "writable": true }
```

`protocol` is `1` for this document. `writable` says whether this token may write.

### `GET v1/changes?since=<cursor>&wait=<seconds>`

What changed since the cursor, each path once, with its latest state:

```json
{
  "cursor": "c_000213",
  "changes": [
    { "path": "nodes/n_k2m4ab.md", "version": "v17" },
    { "path": "threads/n_k2m4ab/1794850638334-xl.md", "version": "v18" },
    { "path": "nodes/n_old111.md", "deleted": true }
  ],
  "more": false
}
```

- Without `since`, every file that exists, and no deleted ones.
- The cursor is opaque, at most 200 characters. Send the last one back to get what changed after it.
- `more: true` means there is more: ask again at once with the new cursor. A store may cap a page at any size.
- `wait` (0 to 25): when nothing changed, the store may hold the request for up to that many seconds and answer as soon as something does (a long poll). Answering at once with no changes is always allowed, so a store that cannot hold requests just ignores it.
- A cursor the store no longer knows gets `410`: grndwrk then asks without `since` and compares everything.

### `GET v1/files/<path>`

The file's bytes, with `Content-Type` and `ETag: "<version>"`. `404` when there is none.

### `PUT v1/files/<path>`

The new bytes, with `Content-Type`, and exactly one of:

- `If-None-Match: *` to create it: `201 { "version": "..." }`, or `412 { "version": "<the one there>" }` when it exists.
- `If-Match: "<version>"` to replace that version: `200 { "version": "..." }`, or `412 { "version": "<the one there>" }` when someone changed it meanwhile (or `null` when it is gone).

A write without either is `428`. A write never silently overwrites someone else's change: that is what keeps two people's maps from losing words.

### `DELETE v1/files/<path>`

With `If-Match: "<version>"`: `200 {}`, `412 { "version": ... }` when it changed meanwhile, `404` when it is gone already.

## Comments straight to the store

With a store, the Comment button on a staging site and the iOS package can leave comments in the store themselves, instead of through grndwrk on someone's Mac or the relay. They log in the way your store does (your login, an invite, whatever the team uses) and get a **comment** token.

A comment token may do exactly two things:

- **Leave a comment:** `PUT v1/files/inbox/<commenter>/<id>.json` with `If-None-Match: *`. `<commenter>` is the id your store gave this person or device when it handed out the token, and the store refuses any other; `<id>` is new for each comment. Both are 8 to 64 letters, digits, `_` or `-`. The body is the same JSON the button sends to grndwrk's `/api/feedback` (words, the page or screen, the element, a picture as base64), at most 14 MB. If your store knows the person's name, set `from` in the JSON to it, replacing whatever the device sent; grndwrk believes the commenter in the path, never one in the body.
- **Read what became of its own comments:** `GET v1/files/status/<commenter>.json`, its own and no other.

Everything else, `changes` included, is `403`. `hello` says `"role": "comment"`. An inbox file's body is a JSON object; anything else is `400`.

For teammates, `inbox/` and `status/` are files like the others: `changes` lists them, a read token reads them, a write token writes and deletes them (that is how grndwrk files a comment and writes the status).

**From a staging site's page.** The Comment button on a staging site calls the store from the browser, so a store that takes comments from one answers CORS for that site's origin, and only on `hello`, `PUT inbox/...` and `GET status/...` with a comment token: `Access-Control-Allow-Origin: <the site>`, the methods `GET, PUT`, the headers `Authorization, Content-Type, If-None-Match`, and the preflight (`OPTIONS`). Never `*`, and never CORS on anything a read or write token does.

grndwrk, on any teammate's machine that syncs, reads new files in `inbox/`, files each one exactly as a comment that came over the Wi-Fi or the relay (marked when it reads like orders to an agent, its words quoted, `from:` the commenter), deletes it from the inbox, and keeps `status/<commenter>.json` up to date. Neither folder is copied into `.grndwrk/`.

A store also answers `hello` with `"role"`: `"read"`, `"write"` or `"comment"`.

### What a store must not do

- Follow paths outside the rules above, or anything like a link.
- Run, render or interpret the files. They are text and pictures written by people and agents, and comments in them come from whoever used the product.
- Hand a token to the page's scripts in a way another site could read.

## As an adapter

A module, `.mjs`, anywhere in your repository. Point `.grndwrk/store.json` at it:

```json
{ "adapter": "tools/grndwrk-store.mjs" }
```

and allow it once on each machine: `grndwrk store allow`. grndwrk keeps a hash of the file in your user folder (never in the project), and loads it only while the file is exactly that. After a pull that changes it, grndwrk stops syncing, says the adapter changed, and waits for `grndwrk store allow` again, so a pull request cannot run code on your machine unseen.

The module's default export is a function that gets `{ project, root }` (the project's name and folder) and returns an object with these calls, the same as over HTTP:

```js
export default async function store({ project, root }) {
  return {
    async hello() { return { protocol: 1, project, writable: true } },
    // since: a cursor or undefined; wait: seconds, may be ignored.
    async changes({ since, wait }) { return { cursor, changes: [{ path, version, deleted }], more: false } },
    // null when there is none.
    async read(path) { return { bytes /* Uint8Array */, version, type } },
    // create: true for If-None-Match: *, else ifVersion for If-Match.
    // { ok: true, version } or { ok: false, version /* the one there, or null */ }.
    async write(path, bytes, { type, create, ifVersion }) {},
    async remove(path, ifVersion) { /* { ok: true } or { ok: false, version } */ },
  }
}
```

Credentials for your database are the adapter's own business: read them from the environment or your usual config, never from `.grndwrk/`.

## Checking a store

```
grndwrk store check https://maps.example.com/clinic/ --token <a token that may write>
grndwrk store check tools/grndwrk-store.mjs
```

It creates, reads, replaces and deletes a few files under `nodes/` with ids that start `n_check`, tries a stale write and a path that is not allowed, follows the changes, and cleans up after itself. Each failure says which rule above it breaks. Run it against a store with nothing in it that matters yet.

## Examples

`stores/` in grndwrk's repository has stores to copy and change: on Cloudflare (Workers and a Durable Object), on Firebase (Cloud Functions over Firestore and Storage, and an adapter that talks to Firestore directly), and in PHP (one small app over SQLite or MySQL). They are starting points, not products: make them yours.
