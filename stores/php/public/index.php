<?php

declare(strict_types=1);

// The store's one entry point. On Apache, .htaccess sends every request here;
// on nginx, try_files does (see README.md). Locally: php -S 127.0.0.1:8080 public/index.php
require dirname(__DIR__) . '/src/bootstrap.php';

$config = GrndwrkStore\config();
(new GrndwrkStore\Api(GrndwrkStore\Database::connect($config), $config))->run();
