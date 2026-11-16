<?php

declare(strict_types=1);

// Projects and tokens, from a terminal on the server. Never reachable over the web.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require __DIR__ . '/src/bootstrap.php';

use GrndwrkStore\Database;
use GrndwrkStore\Protocol;

const HELP = <<<'TXT'
Usage:
  php admin.php project add <project> [<name>]
        a project, served at /<project>/v1/ (lowercase letters, digits and -)
  php admin.php projects
  php admin.php token add <project> read|write|comment [--label <words>]
        [--commenter <id>] [--name <name>]
        a token, shown once; only a hash of it is kept. A comment token leaves
        comments under its commenter id (8 to 64 letters, digits, _ or -; made
        up when not given), and the store writes --name as their sender
  php admin.php tokens <project>
  php admin.php token revoke <id>

TXT;

function fail(string $message): never
{
    fwrite(STDERR, $message . "\n");
    exit(1);
}

/** The value after --name in the arguments, or null. */
function option(array $args, string $name): ?string
{
    $i = array_search("--$name", $args, true);
    if ($i === false) return null;
    if (!isset($args[$i + 1])) fail("--$name needs a value");
    return $args[$i + 1];
}

$config = GrndwrkStore\config();
if (str_starts_with($config['dsn'], 'sqlite:')) {
    $dir = dirname(substr($config['dsn'], 7));
    if (!is_dir($dir) && !mkdir($dir, 0700, true)) fail("Could not make $dir");
}
$db = Database::connect($config);
$db->install();

$args = array_slice($argv, 1);
$command = implode(' ', array_slice($args, 0, 2));

if ($command === 'project add') {
    $slug = $args[2] ?? '';
    if (!preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/D', $slug)) fail('A project is lowercase letters, digits and -, at most 64');
    if ($slug === 'v1') fail('v1 is the store\'s own address (v1/projects); pick another name');
    if ($db->project($slug)) fail("$slug is there already");
    $db->addProject($slug, trim(implode(' ', array_slice($args, 3))) ?: $slug);
    echo "Project $slug: /$slug/v1/\n";
} elseif (($args[0] ?? '') === 'projects') {
    foreach ($db->projects() as $p) echo "{$p['slug']}\t{$p['name']}\n";
} elseif ($command === 'token add') {
    $project = $args[2] ?? '';
    $role = $args[3] ?? '';
    if (!$db->project($project)) fail("No project $project: php admin.php project add $project");
    if (!in_array($role, ['read', 'write', 'comment'], true)) fail('A token may read, write or comment');
    $commenter = null;
    $name = null;
    if ($role === 'comment') {
        $commenter = option($args, 'commenter') ?? 'c_' . bin2hex(random_bytes(8));
        if (!preg_match(Protocol::COMMENTER, $commenter)) fail('A commenter id is 8 to 64 letters, digits, _ or -');
        $name = option($args, 'name');
    }
    $t = $db->addToken($project, $role, $commenter, $name, option($args, 'label') ?? '');
    echo "Token {$t['id']} for $project, $role" . ($commenter ? ", commenter $commenter" : '') . ". It is shown only now:\n{$t['token']}\n";
} elseif (($args[0] ?? '') === 'tokens') {
    foreach ($db->tokens($args[1] ?? '') as $t) {
        echo implode("\t", [$t['id'], $t['role'], $t['commenter'] ?? '', $t['name'] ?? '', $t['label'] ?? '', $t['created']]) . "\n";
    }
} elseif ($command === 'token revoke') {
    if (!ctype_digit($args[2] ?? '')) fail('Which token? php admin.php tokens <project> lists them');
    if (!$db->revoke((int) $args[2])) fail("No token {$args[2]}");
    echo "Token {$args[2]} revoked.\n";
} else {
    echo HELP;
}
