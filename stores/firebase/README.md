# A grndwrk store on Firebase

An example to copy and change, not a product. It keeps a grndwrk map in your own Firebase project, two ways over the same data:

- **A Cloud Function** (`index.mjs`, 2nd gen HTTPS) that answers every call of [the store protocol](../../docs/store-protocol.md). Teammates, phones and a staging site's Comment button reach it with a token.
- **An adapter** (`adapter.mjs`) that grndwrk loads to talk to Firestore and Storage directly, with your Google credentials. No function needed.

Both can be used at once: the adapter on the machines of people with access to the Firebase project, the function for everyone else.

## The files

| File | What it is |
| --- | --- |
| `adapter.mjs` | The protocol's rules, the store over Firestore and Storage, and the adapter grndwrk loads. One file on purpose: grndwrk allows an adapter by the hash of that file, so code it imported from another file could change unseen. |
| `functions.mjs` | The HTTP side: tokens, members and roles, the comment role, CORS for a staging site. Plain web `Request` and `Response`. |
| `index.mjs` | The Cloud Function around `functions.mjs`. |
| `members.mjs` | Adds and removes members, hands out store keys, sets the staging site. |
| `firestore.rules`, `storage.rules` | Deny every direct read and write. Only the function and the adapter (firebase-admin) touch the data. |

## How the map is kept

```
projects/{map}                  { name, counter, site?, floor? }
projects/{map}/files/{key}      { path, version, type, size, at, data | blob }
projects/{map}/changes/{key}    { path, at, version, deleted }
projects/{map}/members/{uid}    { role, commenter?, name? }
projects/{map}/keys/{sha256}    { uid, created }
Storage: projects/{map}/blobs/{random}
```

- `{map}` is the map's id, like `clinic`. `{key}` is the file's path with `encodeURIComponent`, so `nodes/n_k2m4ab.md` is one document, `nodes%2Fn_k2m4ab.md`.
- Every write and delete is one Firestore transaction: it reads the map's `counter` and the file, refuses when the version there is not the one sent (`If-Match`) or the file exists (`If-None-Match: *`), and otherwise raises the counter, writes the file and its line in `changes`. Two people writing from the same version: one wins, the other gets `412` and the version that won. A version is `v<counter>`, a cursor `c_<counter>`.
- `changes` holds one document per path, its latest change, so a cursor is a number and `changes?since=` is a query on `at`. A deleted file stays there as `deleted: true`. If you ever prune those, set `floor` on the map to the counter you pruned up to: older cursors then get `410` and grndwrk reads everything again.
- A file up to 900 KB is kept in its document (`data`). A larger one, a big picture or a comment with its picture, goes to Storage under a new name for each version, written before the transaction, so a refused write never touches what is there; the old object is removed after.

## Who may do what

The Bearer token is one of two things:

- **A Firebase Auth ID token**, for an app of yours that signs people in with Firebase. It lasts an hour, so it suits a page or app that refreshes it.
- **A store key** (`gk_...`), for grndwrk on a Mac and for phones and test devices, which keep one token for good. Only its SHA-256 is kept, in `keys/`. `node members.mjs clinic key vet@example.com` prints one, once.

Either names a user. What that user may do on a map is `projects/{map}/members/{uid}`:

```
{ role: 'write' }                                       reads and changes the map
{ role: 'read' }                                        reads it
{ role: 'comment', name: 'Front desk iPad' }            leaves comments, reads their status
{ role: 'comment', commenter: 'dev_staging1' }          the same, under that commenter id
```

A commenter writes only `inbox/<commenter>/<id>.json` (with `If-None-Match: *`) and reads only `status/<commenter>.json`; `<commenter>` is its `commenter`, or its uid. Everything else is `403`. When the member has a `name`, the function writes it as `from` in the comment, whatever the device sent. A token of no member is `401`.

```
node members.mjs clinic add vet@example.com write
node members.mjs clinic add nurse@example.com read
node members.mjs clinic add dev_frontdesk1 comment --name "Front desk iPad"
node members.mjs clinic key dev_frontdesk1
node members.mjs clinic remove nurse@example.com
node members.mjs clinic list
```

A member need not have a Firebase account: `dev_frontdesk1` above is an id you chose for a device, which then reaches the store with its key only.

**Your own login instead.** Replace `verify` in `index.mjs` (a function from a token to `{ uid }`, or null) with whatever checks your tokens: a session cookie, another identity provider, a signed link. Keep the members documents, or replace `userOf` and the members lookup in `functions.mjs` with your own table of who may do what.

**A staging site's Comment button** calls the store from the browser. Name the one site that may:

```
node members.mjs clinic site https://staging.vetclinic.example
node members.mjs clinic site off
```

The function then answers CORS for that origin, and only for what a comment token does (`hello`, `PUT inbox/...`, `GET status/...`, and their preflight), a `401` or `403` on those calls included, so the page can ask the person to log in again. Never `*`, never for what read or write tokens do.

## Deploy

In your own Firebase project, with Firestore and Storage set up and the [Firebase CLI](https://firebase.google.com/docs/cli):

```
cp -R stores/firebase tools/grndwrk-firebase    # in your repository; make it yours
cd tools/grndwrk-firebase
npm ci
firebase use --add                              # your project
firebase deploy --only functions,firestore:rules,storage
```

Pick the region your Firestore is in (`region` in `index.mjs`). The store's address for a map is the function's address plus the map's id:

```
https://europe-west1-<your project>.cloudfunctions.net/store/clinic/
```

Then add yourself (`members.mjs` needs credentials, see below), make a key, and point grndwrk at it:

```
node members.mjs clinic add you@vetclinic.example write
node members.mjs clinic key you@vetclinic.example
grndwrk store check https://europe-west1-<your project>.cloudfunctions.net/store/clinic/ --token gk_...
```

`grndwrk store check` writes and deletes a few files under `nodes/` whose ids start `n_check`. Run it before the map holds anything that matters.

## The adapter

For people who have access to the Firebase project itself. grndwrk loads `adapter.mjs` and reaches Firestore and Storage with firebase-admin, as the function does.

1. `npm ci` in the folder, so `firebase-admin` is next to the adapter.
2. Credentials from the environment, never from `.grndwrk/`: `gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS` naming a service account's key file kept outside the repository. `GOOGLE_CLOUD_PROJECT` (or `GRNDWRK_FIREBASE_PROJECT_ID`) names the Firebase project, `GRNDWRK_FIREBASE_BUCKET` the Storage bucket (like `<your project>.firebasestorage.app`), and `GRNDWRK_FIREBASE_MAP` the map's id when it is not the project's name in lower case with dashes.
3. In `.grndwrk/store.json`:

   ```json
   { "adapter": "tools/grndwrk-firebase/adapter.mjs" }
   ```

4. Read the file, then allow it on your machine: `grndwrk store allow`. After a pull that changes it, grndwrk stops and asks again.
5. `grndwrk store check tools/grndwrk-firebase/adapter.mjs`

The adapter reaches every map in the project with your credentials; the members and keys apply only to the function.

## Tests

`test/store-firebase.test.ts` in grndwrk's repository runs the logic (`adapter.mjs`, `functions.mjs`) on Node over an in-memory Firestore and Storage: grndwrk's own `checkStore`, against the adapter and over HTTP against the function, the roles, the comment role, CORS, and two writes from the same version. `index.mjs` and `members.mjs` need a Firebase project or the emulator: try them there before you rely on them.

## Not here

Limits on how much one commenter may send, rotating keys (remove the member and add it again), pruning deleted files from `changes`, and holding `changes?wait=` open (the function answers at once, which the protocol allows).
