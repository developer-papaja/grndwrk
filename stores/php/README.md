# A grndwrk store in PHP

A small PHP app that keeps a team's grndwrk maps in a database and answers the calls in [docs/store-protocol.md](../../docs/store-protocol.md). It is an example to copy and change, not a product: read it, make it yours, and host it where your team already hosts things.

- PHP 8.1 or later, with PDO. No framework, no Composer.
- SQLite by default (one file, outside the web root), or MySQL/MariaDB.
- One install serves several projects: `https://maps.example.com/<project>/v1/...`.
- Tokens that may read, write, or only leave comments. Only a hash of each is kept.

```
public/index.php     the one entry point (the web root is public/)
public/.htaccess     Apache: every request to index.php, Authorization passed on
src/Protocol.php     which paths, types and sizes a store keeps (a port of src/shared-store/protocol.ts)
src/Api.php          the HTTP calls: hello, changes, files, and what a comment token may do
src/Auth.php         who is asking: the one place to plug in your own login
src/Database.php     projects, tokens and files, over PDO
admin.php            projects and tokens, from a terminal
config.example.php   copy to config.php
```

## Install

1. Copy `stores/php/` to the server, for example to `/srv/grndwrk-store/`.
2. Point the site's web root at `public/`. Everything else (the code, `config.php`, the database in `data/`) must stay out of reach of the web. If your host cannot move the web root, the `.htaccess` in this folder refuses every request outside `public/`, so the store answers under `/public/` instead; check that `https://<your site>/data/` and `https://<your site>/config.php` give 403 or 404.
3. Copy `config.example.php` to `config.php` and change what you need. Without a `config.php`, the store uses SQLite in `data/store.sqlite`. The folder must be writable by PHP, and by you when you run `admin.php`.
4. Make a project for the map, named the way its address will read:

   ```
   php admin.php project add clinic "Clinic"
   ```

   The project's address is then `https://maps.example.com/clinic/`. `admin.php` also creates the tables the first time it runs, in SQLite or in MySQL.

### MySQL or MariaDB

Make a database and a user, then in `config.php`:

```php
'dsn' => 'mysql:host=localhost;dbname=grndwrk;charset=utf8mb4',
'user' => 'grndwrk',
'password' => '...',
```

and run `php admin.php projects` once to create the tables.

### Apache

`public/.htaccess` sends every request to `index.php` and passes the `Authorization` header on to PHP (PHP behind CGI or FastCGI does not get it otherwise). It needs `mod_rewrite` and `AllowOverride All` (or at least `FileInfo` and `AuthConfig`) for the folder.

### nginx

```nginx
server {
    server_name maps.example.com;
    root /srv/grndwrk-store/public;
    client_max_body_size 15m;   # a comment can carry a picture, up to 14 MB

    location / {
        try_files $uri /index.php$is_args$args;
    }
    location = /index.php {
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root/index.php;
        fastcgi_pass unix:/run/php/php-fpm.sock;
    }
}
```

nginx passes `Authorization` to PHP by itself. Nothing outside `public/` is served.

### Trying it on your machine

```
php admin.php project add clinic "Clinic"
php -S 127.0.0.1:8080 public/index.php
```

## Tokens

```
php admin.php token add clinic write --label "Reception laptop"
php admin.php token add clinic read --label "Waiting room screen"
php admin.php token add clinic comment --name "Front desk iPad" --label "Staging"
php admin.php tokens clinic
php admin.php token revoke 3
```

The token is printed once; the database keeps only its SHA-256 hash. A person keeps theirs on their own machine with `grndwrk store login --token <token>`, never in the project.

- **write** reads and changes the map. Every teammate who syncs needs one.
- **read** reads the map; writes get 403.
- **comment** may only leave comments in `inbox/<commenter>/` and read `status/<commenter>.json`, for the Comment button on a staging site or the iOS package. Everything else is 403. Each comment token has a commenter id (`--commenter`, or one is made up), and the store puts its `--name` in each comment's `from`, whatever the device sent.

To let the Comment button on a staging site reach the store from the browser, list the site's origin in `config.php`, `'origins' => ['https://staging.clinic.example']`. The store then answers CORS for that origin only (never `*`), and only on `hello`, `PUT inbox/...` and `GET status/...` with a comment token, with the preflight; read and write tokens never get CORS.

For teammates, `inbox/` and `status/` are files like the others: `changes` lists them, read tokens read them, write tokens write and delete them. That is how grndwrk files each comment and writes the status. An inbox file must be a JSON object (400 otherwise), whoever writes it.

## Check it

From a project with grndwrk, with a write token:

```
grndwrk store check https://maps.example.com/clinic/ --token <token>
```

It writes a few files under `nodes/n_check...`, tries what the protocol says a store must refuse, follows the changes and removes what it wrote. Every rule should say ok. grndwrk's own tests run the same check against this store (`test/store-php.test.ts`).

## How it keeps the rules

- **Versions and the changes.** Each project has a counter. A write or a delete takes the project's lock in a transaction (`BEGIN IMMEDIATE` in SQLite, `SELECT ... FOR UPDATE` on the project's row in MySQL), checks the version inside it, bumps the counter and stamps the file with it. A version is `v<counter>`, a cursor `c_<counter>`, and the changes after a cursor are the files stamped later. So a stale write never overwrites, and no change is missed between two pages.
- **Deleted files** stay as a row marked deleted, so a deletion shows in the changes and every cursor keeps working. They are never pruned; a store that prunes them would answer old cursors with 410.
- **Paths** follow the protocol exactly (`src/Protocol.php`): anything else is 400, an extension other than `.md`, `.json`, `.png`, `.jpg` and `.jpeg` too. The path decides a file's type; a `Content-Type` sent with a write is only a hint. A picture must be a PNG or JPEG by its bytes (415).
- **Nothing is rendered.** Files go out with their type, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and a sandboxing Content-Security-Policy. Errors never show the server's own messages; they go to PHP's error log.
- **Long polling** is off: `changes` answers at once, which the protocol allows. Set `wait` in `config.php` to let a request wait a few seconds for a change, if your server has PHP workers to spare.

## Your own login

Who may do what is your team's choice, and the whole decision sits in `src/Auth.php`: `Auth::who()` gets the database, the project and the `Authorization` header, and returns a role (`read`, `write` or `comment`, with a commenter id and a name for comments), or null for 401. Replace it with your own, for example:

- **Your users' API tokens.** Look the bearer token up in the table your product already keeps, and map a user's rights to a role:

  ```php
  public static function who(Database $db, string $project, string $authorization): ?array
  {
      if (!preg_match('/^Bearer (\S+)$/D', $authorization, $m)) return null;
      $q = $db->pdo->prepare('SELECT id, name, is_staff FROM users WHERE api_token_hash = ?');
      $q->execute([hash('sha256', $m[1])]);
      $user = $q->fetch();
      if (!$user) return null;
      return $user['is_staff']
          ? ['role' => 'write', 'commenter' => null, 'name' => null]
          : ['role' => 'comment', 'commenter' => 'user_' . str_pad((string) $user['id'], 8, '0', STR_PAD_LEFT), 'name' => $user['name']];
  }
  ```

- **A page behind your login that hands out tokens.** Keep `Auth.php` as it is, and add a page to your own app that, for the person who is logged in, calls `Database::addToken()` and shows the token once, the way `admin.php` does. This suits a phone or a staging page: the person logs in where they always do and gets a comment token for this map.

grndwrk only ever sends `Authorization: Bearer <token>`. Do not answer with a session cookie instead: another site could make a logged-in browser use it.
