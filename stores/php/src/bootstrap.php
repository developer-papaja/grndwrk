<?php

declare(strict_types=1);

namespace GrndwrkStore;

require_once __DIR__ . '/Protocol.php';
require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/Auth.php';
require_once __DIR__ . '/Api.php';

/**
 * The settings: config.php next to this folder (copy config.example.php), or
 * the file GRNDWRK_STORE_CONFIG names. Without one, SQLite in data/.
 */
function config(): array
{
    $file = getenv('GRNDWRK_STORE_CONFIG') ?: dirname(__DIR__) . '/config.php';
    $own = is_file($file) ? require $file : [];
    return array_merge([
        'dsn' => 'sqlite:' . dirname(__DIR__) . '/data/store.sqlite',
        'user' => null,
        'password' => null,
        'base' => null,
        'page' => 500,
        'wait' => 0,
        'origins' => [],
        'base_url' => null,
        'inbox' => [],
    ],is_array($own) ? $own : []);
}
