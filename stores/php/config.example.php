<?php

// Copy to config.php (next to this file, outside the web root) and change what you need.
return [
    // SQLite: one file, outside the web root. The folder must be writable by PHP.
    'dsn' => 'sqlite:' . __DIR__ . '/data/store.sqlite',

    // MySQL or MariaDB instead:
    // 'dsn' => 'mysql:host=localhost;dbname=grndwrk;charset=utf8mb4',
    // 'user' => 'grndwrk',
    // 'password' => 'change me',

    // The path the store is served under, when it cannot be told from the script's
    // address (a rewrite from elsewhere). '' for the root, null to work it out.
    'base' => null,

    // The store's own address, as people and staging sites reach it: each project is
    // <base_url><project>/. store.js and GET /v1/projects name addresses from this,
    // never from the request's Host header, which whoever sends a request chooses.
    // Without it, store.js answers 503 and /v1/projects 404.
    'base_url' => 'https://maps.example.com/',

    // What one comment token may leave in the inbox. A comment token may sit in a
    // staging page, where any script on it can read it, so it must never fill the
    // store. Beyond these, 429. Teammates' tokens are never held to them.
    'inbox' => [
        'files_per_hour' => 60,   // comments one commenter may leave in an hour
        'mb_per_hour' => 100,     // megabytes one commenter may leave in an hour
        'waiting' => 500,         // one commenter's comments not filed yet, at most
        'total' => 5000,          // the project's comments not filed yet, at most
    ],

    // How many changes one answer holds at most.
    'page' => 500,

    // How long a request for changes may wait for something to change, in seconds.
    // 0 answers at once. A waiting request keeps a PHP worker busy, so keep it low
    // on shared hosting.
    'wait' => 0,

    // Staging sites whose Comment button may leave comments from the browser, as
    // exact origins: ['https://staging.clinic.example']. CORS is answered for these
    // only, and only on hello, PUT inbox/... and GET status/... with a comment
    // token; never for read or write tokens. grndwrk itself never needs this.
    'origins' => [],

    // The folder `grndwrk store assets` wrote: the page at each project's address, and
    // the Comment button for the sites above. null: page/ next to src/. Outside the web root.
    'assets' => null,
];
