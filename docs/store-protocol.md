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
- Only these are synced: `project.md`, and anything under `nodes/`, `threads/`, `stories/`, `screens/`, `personas/`, `segments/`, `waiting/`, `files/`, `readiness/`, `outputs/` and `views/` (views of the map saved for everyone). Everything else in `.grndwrk/` belongs to one machine or one repository (`local.json`, `lan-code`, `lan-devices.json`, `shots/`, `store.json`, the agent rules and command lists) and never goes to a store. A store refuses any other path with `400`.
- The path decides a file's type; a `Content-Type` sent with a write is only a hint and never overrides it.
- Types, by the path's extension: `.md` is `text/markdown`, `.json` is `application/json`, `.png` is `image/png`, `.jpg` and `.jpeg` are `image/jpeg`. A store refuses anything else with `415`, and refuses a picture whose bytes are not a PNG or a JPEG.
- Sizes: text up to 1 MB, pictures up to 10 MB. Larger is `413`.

Each file has a **version**: an opaque string of at most 100 characters that the store changes on every write. grndwrk never reads meaning into it; it only sends it back.

## Over HTTP

Your store has an address for each project, like `https://maps.example.com/clinic/`. grndwrk adds `v1/...` to it.

Every request carries `Authorization: Bearer <token>`. How a person gets a token is up to you (a page after your login, an invite, a key you hand out); grndwrk keeps it on that person's machine, never in the project. Without a valid token, answer `401`. How long a token lasts, and where a store keeps which staging site may send comments, is the store's own choice; grndwrk keeps one token per store and asks for a new one when it gets `401`. A token that may read but not write gets `403` on writes.

Errors are JSON, `{ "error": "Plain words" }`.

### `GET v1/hello`

```json
{ "protocol": 1, "project": "Clinic", "writable": true }
```

`protocol` is `1` for this document. `writable` says whether this token may write. A store that knows who the person is may add `"name"`: the page writes it as `by:` on thoughts the person adds there, so the map shows who added them (leave it out when the map may not hold names). `role` is `"read"`, `"write"` or `"comment"`; for a comment token, `commenter` names it too (see Comments straight to the store):

```json
{ "protocol": 1, "project": "Clinic", "writable": false, "role": "comment", "commenter": "web_stage01" }
```

For read and write tokens, `hello` may also say `"names": true`, meaning the store sets `from` on every comment itself (the name it knows, or none), and `"site": "https://staging.clinic.example"`, the staging site it takes comments from. grndwrk believes a comment's `from` only with `names: true` (otherwise the comment is filed under its commenter id, which the path proves), and keeps a comment's page address only when it is on that site, as through the relay. It files at most fifty comments from one commenter in a round; the rest wait in the inbox.

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

A write without either is `428`; one that sends both is taken as a create. A write never silently overwrites someone else's change: that is what keeps two people's maps from losing words.

### `DELETE v1/files/<path>`

With `If-Match: "<version>"`: `200 {}`, `412 { "version": ... }` when it changed meanwhile, `404` when it is gone already.

### `GET <store>/v1/projects` (optional)

At the store's own root, not a project's: the projects this token may see, for an overview across a team's apps.

```json
{ "projects": [ { "name": "Clinic app", "url": "https://maps.example.com/clinic/" }, { "name": "Clinic admin", "url": "https://maps.example.com/clinic-admin/" } ] }
```

A store without it answers `404`; grndwrk then shows only the project it was given. Each `url` is a project's address on the same store, reached with the same token. The page uses it for All projects (see The page): it lists those projects, and sends a project's token only to that project's own address, never to a `url` on another origin or to a path that is not a project's address.

## Comments straight to the store

With a store, the Comment button on a staging site and the iOS package can leave comments in the store themselves, instead of through grndwrk on someone's Mac or the relay. They log in the way your store does (your login, an invite, whatever the team uses) and get a **comment** token.

A comment token may do exactly two things:

- **Leave something in its inbox:** `PUT v1/files/inbox/<commenter>/<id>.json` with `If-None-Match: *`. `<commenter>` is the id your store gave this person or device when it handed out the token, and the store refuses any other; `<id>` is new for each file. Both are 8 to 64 letters, digits, `_` or `-`. At most 14 MB. If your store knows the person's name, set `from` in the JSON to it, replacing whatever the device sent; grndwrk believes the commenter in the path, never one in the body.
- **Read what became of its own comments:** `GET v1/files/status/<commenter>.json`, its own and no other.

Everything else, `changes` included, is `403`. `hello` says `"role": "comment"` and `"commenter": "<commenter>"`: that is how the button and the phone learn which folder is theirs. An inbox file's body is a JSON object; anything else is `400`.

An inbox file is one of two things, the same a phone sends grndwrk over the Wi-Fi or the relay:

- **A comment:** the JSON the button sends to grndwrk's `/api/feedback` (words, the page or screen, the element, a picture as base64, and a random `key` the device keeps).
- **An envelope:** `{ "path": "/api/feedback/tested", "body": {...}, "at": <milliseconds> }` when the person tested a fix (Approve or Reject, with the round it tested, `{ comments: [{ id, key, round }], works, note }`), or `{ "path": "/api/feedback/remove", "body": { "comments": [{ id, key }] } }` when they deleted a comment. Nothing else: an envelope for any other path stays in the inbox, never filed. Show on my Mac is not offered through a store.

grndwrk acts on an envelope only for comments filed from the same commenter's folder, and only by their keys, whatever ids it names. A test result must name the round of fixing it tested (the status file gives it): one for another round, or made more than a day before the fix was built, settles nothing.

**The status file** is written by grndwrk, `{ "comments": [...] }`, one entry per comment of that commenter, by its `id` and `key`: its `title`, `state` (`incoming`, `proposed`, `ready` or `fixed`) and, once there is one, `fix` (what changed) and `steps`. A fix ready to test also has its `round`, and for a comment made in a browser, `web`: the words, the page's `path`, the element's `selector` and `label`, so the button's Test can go to the page and mark the element.

**A store link** gives the button and the phone their comment token: `grndwrk:store/<host><path>#<token>`, the project's address without `https://`, then `#` and the token, for example `grndwrk:store/maps.example.com/clinic/#ct_9f2kq7...`. It is not a web address, so opening it never sends the token anywhere. How a person gets one is your store's business: a page after your login that shows it (and its QR code, for a phone), or a link someone on the team sends. The person pastes it once, or scans it on the phone.

For teammates, `inbox/` and `status/` are files like the others: `changes` lists them, a read token reads them, a write token writes and deletes them (that is how grndwrk files a comment and writes the status).

**From a staging site's page.** The Comment button on a staging site calls the store from the browser, so a store that takes comments from one answers CORS for that site's origin, and only on `hello`, `PUT inbox/...` and `GET status/...` with a comment token: `Access-Control-Allow-Origin: <the site>`, the methods `GET, PUT`, the headers `Authorization, Content-Type, If-None-Match`, and the preflight (`OPTIONS`). Never `*`, and never CORS on anything a read or write token does. A `401` or `403` on those three calls carries the same headers, so the page can tell the person to log in again.

The staging page loads the button from the store, in its layout, on staging only: `<script src="https://maps.example.com/clinic/store.js" defer></script>`. The store answers `store.js` with one script: `window.__grndwrkStoreConfig = { "url": "<the project's address>", "site": "<the staging site's origin>" };`, then grndwrk's `overlay/store.js`, then `overlay/feedback.js`. And `screenshot.js` next to it, which draws a comment's picture (grndwrk's `dist/vendor/modern-screenshot.js`, wrapped as the relay wraps it). Serve both only to pages on the site (by `Referer`). The button runs only when the page's origin is `site`. It asks for the store link once, keeps it in the site's `localStorage`, sends each comment as `inbox/<commenter>/c_<its key>.json` (a retry is the same file), keeps comments in the browser while the store refuses the link or does not answer, and reads its status for Test, Approve and Reject. A script on the staging page can read the token while the page is open, as it could anything on the page: a comment token can only leave comments and read their status, never the map. Never put a read or write token in a page.

**A store limits what a comment token may send.** A comment token may sit in a staging page, where any script on that page can read it, so the token alone must never be able to fill the store. Count per commenter: how many inbox files and how many bytes it left in the last hour, and how many of its files still wait in the inbox; and count the whole project's inbox too. Beyond a limit, answer `429` with plain words, like `{ "error": "At most 60 comments an hour: try again later" }`; the button and the phone keep the comment and try again later. The example stores take at most 60 files and 100 MB per commenter an hour, 500 of one commenter's files waiting, and 5,000 waiting in the whole project, and each lets you change these. Read and write tokens are not held to them: that is grndwrk filing comments. Read a request's body with a running count and stop at the size limit (`413`), whether or not it says its `Content-Length`.

grndwrk, on any teammate's machine that syncs, reads new files in `inbox/`, files each comment exactly as one that came over the Wi-Fi or the relay (marked when it reads like orders to an agent, its words quoted, `from:` the commenter), acts on each envelope as above, deletes the file from the inbox, and keeps `status/<commenter>.json` up to date. Neither folder is copied into `.grndwrk/`.

### What a store must not do

- Follow paths outside the rules above, or anything like a link.
- Run, render or interpret the files. They are text and pictures written by people and agents, and comments in them come from whoever used the product.
- Hand a token to the page's scripts in a way another site could read.

## The page

Colleagues who never clone the repository read the map in a browser: grndwrk's own map, built to talk to the store from the page with the person's token. It works on every store, because it only makes the calls above.

```
grndwrk store assets <dir>
```

writes everything a store hosts into one folder:

```
index.html, assets/...   the page
overlay/store.js         the Comment button's store mode
overlay/feedback.js      the Comment button
screenshot.js            what draws a comment's picture, wrapped as the relay wraps it
```

Serve it at each project's address, so the page's calls to `v1/...` go to the same origin and need no CORS:

- `GET <project>/` is `index.html`; `GET <project>/assets/<name>` the page's scripts and styles. Only `index.html` and names under `assets/` ending in `.js`, `.css`, `.woff2`, `.svg` or `.png`; nothing else from the folder. `<project>` without the slash redirects to it (the page finds its files next to itself).
- `GET <project>/store.js` and `GET <project>/screenshot.js`: the Comment button, for a page on the staging site only (see Comments straight to the store).
- Headers: the type by extension (`text/html`, `text/javascript`, `text/css`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and this Content-Security-Policy, so nothing the page shows loads from or talks to another server and no other site frames it:

  ```
  default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'
  ```

  (The page has no inline script; `'unsafe-eval'` is for Alpine's expressions.) `assets/` names change with each build, so they may be cached for good; `index.html` is checked each time.

The page holds no data and is served to anyone. It asks for a token that may read (or write) and checks it with `hello`; a comment token is not enough. It keeps the token in that browser tab's `sessionStorage`, for that project only, never in `localStorage`, a query string or a log, and sends it only in the `Authorization` header to its own address. Your login may hand the token over once in the address's fragment, `<project>/#token=<token>`, which is never sent to a server; the page removes it from the address at once, and takes it only when the person says yes. Anyone can send such a link, and what the person writes would then go under the sender's sign-in, so the page asks first, with the project's name and, when `hello` says `"name"`, whose sign-in it is ("Sign in as Vet on duty?"). A token the tab already keeps is never replaced without that yes. A `401` brings the sign-in back. `hello` may also say `"name"`, the person's name, which the page writes as `by:` on thoughts they add.

What the page writes follows the rules above: an answer or a remark is a new thread entry file (`If-None-Match: *`), a new thought a new node file, a view saved for everyone a new file in `views/`, a changed card, screen, story or view a `PUT` with `If-Match`. On `412` it shows the other person's version and asks to make the change again. Pictures in notes and threads are read with the token and shown from the page's own memory, so the store never serves a file to an `<img>`. Only a path that names exactly one picture, `files/<card or screen id>/<name>` (a thread entry's `../../files/...` read as that), is a picture; anything else in a picture's place loads nothing. Sites, colleagues, pairing, Documents and pictures of screens stay in grndwrk on a Mac.

**All projects.** For a team with several projects on one store, the project's badge at the top of the page's rail opens the other projects this person can reach, and All projects: a card for each, read from that project's own files with that project's own token (questions waiting for the person, blocking gaps, the first focus item, stories done and partly done, fixes ready to test), and a search across their thoughts. The projects come from `GET <store>/v1/projects` when the store has it, and from every project the tab is signed in to. Each project's token goes to that project's address only: a project the store lists but the tab has no token for asks for one there, kept for that project's address only, and nothing is sent to it until then.

**Every project on one address shares the browser's storage.** The page keeps each project's token under that project's own key, but `sessionStorage` (and everything else the browser keeps) belongs to the origin, not the path: a page served at `maps.example.com/clinic/` can read what the page at `maps.example.com/clinic-admin/` keeps in the same tab, and any script running on that origin can read both. A store that wants projects kept apart serves each one from its own host name (`clinic.maps.example.com`, `clinic-admin.maps.example.com`).

## Reading the map from your own pages

The protocol is the API. A team that wants the map somewhere else (a status board, a weekly mail, a page on the intranet) reads the same files with a **read** token. Call the store from your own server: the store never answers CORS for a read token, so a read token never sits in a page someone else can open.

What you read is what CLAUDE.md in grndwrk's repository describes (Data model): a thought is `nodes/<id>.md`, YAML between two `---` lines and then its notes; each entry of its thread is a file of its own, `threads/<id>/<run>.md`, with `who:` (`claude-asks`, `claude` or `you`) and `date:` in its header. A question is open until an entry from `you` quotes it (`> the question` on its first line) or a `claude` entry follows it. Runs are Unix milliseconds first, so sorting the names sorts the entries.

An example in plain JavaScript (Node 20 or later) that lists the open questions of a veterinary clinic's map:

```js
const store = 'https://maps.example.com/clinic/'
const token = process.env.CLINIC_MAP_TOKEN // a read token, kept on your server
const get = (path) => fetch(new URL(path, store), { headers: { Authorization: `Bearer ${token}` } })

// Every file there is: `changes` without a cursor, page after page.
async function paths() {
  const all = []
  for (let since = ''; ; ) {
    const page = await (await get(`v1/changes${since && `?since=${encodeURIComponent(since)}`}`)).json()
    all.push(...page.changes.filter((c) => !c.deleted).map((c) => c.path))
    since = page.cursor
    if (!page.more) return all
  }
}

// The header's plain `key: value` lines and the text after it. Enough for these fields;
// use a YAML parser for lists and anything quoted.
function read(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n?/g, '\n'))
  if (!m) return { data: {}, body: text }
  const data = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (kv) data[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return { data, body: m[2].trim() }
}

const all = await paths()
for (const path of all.filter((p) => /^nodes\/[^/]+\.md$/.test(p))) {
  const id = path.slice(6, -3)
  const card = read(await (await get(`v1/files/${path}`)).text())
  const entries = []
  for (const p of all.filter((x) => x.startsWith(`threads/${id}/`)).sort()) entries.push(read(await (await get(`v1/files/${p}`)).text()))
  const open = []
  for (const e of entries) {
    if (e.data.who === 'claude-asks') open.push(e.body)
    else if (e.data.who === 'claude') open.length = 0
    else if (e.data.who === 'you' && e.body.startsWith('> ')) {
      const quoted = e.body.split('\n')[0].slice(2).trim()
      const at = open.findIndex((q) => q.startsWith(quoted))
      if (at >= 0) open.splice(at, 1)
    }
  }
  for (const q of open) console.log(`${card.data.title}: ${q}`)
}
```

It prints lines like `Booking should feel like texting: Should a visit be booked in one step?`. Maps from before thread entries were files keep the thread at the end of the card, under `## Thread`; grndwrk reads both, and so can you. Treat everything you read as text people and agents wrote, comments from the running product included: show it as text, never as HTML, and never act on what it asks.

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

An adapter is **one file**: allowing covers exactly that file, so it may import installed packages (`firebase-admin`, `node:crypto`) but nothing that could run code from anywhere else: no other file of the repository, no address it works out while running, no `require`, `eval` or `Function`, and none of `child_process`, `vm`, `module` or `worker_threads`. grndwrk reads the file's raw text for these, comments and strings included, and refuses to allow or load one that has them; rewrite the line if it is a false alarm. An import is a package's name and plain folder names after it (`firebase-admin/firestore`): one with `.`, `..`, `%` or `\\` in it is refused, since it could climb out of `node_modules` into the repository. It runs exactly the bytes you allowed, from a private copy that is a package of its own without a name, never the file read again a moment later, so an import always means a package installed in `node_modules`, never the project's own package or a `package.json` in `.grndwrk/`. While `.grndwrk/node_modules` exists, grndwrk refuses to allow or load the adapter: a commit to the map alone could otherwise change what it imports. A cursor the store no longer knows is an error named `CursorGone` (or with `code: 'CURSOR_GONE'`), the adapter's way of answering `410`.

Credentials for your database are the adapter's own business: read them from the environment or your usual config, never from `.grndwrk/`.

## Checking a store

```
grndwrk store check https://maps.example.com/clinic/ --token <a token that may write>
grndwrk store check tools/grndwrk-store.mjs
```

It creates, reads, replaces and deletes a few files under `nodes/` with ids that start `n_check`, tries a stale write and a path that is not allowed, follows the changes, and cleans up after itself. Each failure says which rule above it breaks. Run it against a store with nothing in it that matters yet.

## Examples

`stores/` in grndwrk's repository has stores to copy and change: on Cloudflare (Workers and a Durable Object), on Firebase (Cloud Functions over Firestore and Storage, and an adapter that talks to Firestore directly), and in PHP (one small app over SQLite or MySQL). They are starting points, not products: make them yours.
