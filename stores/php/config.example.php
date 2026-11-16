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
];
