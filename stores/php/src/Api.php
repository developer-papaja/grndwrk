<?php

declare(strict_types=1);

namespace GrndwrkStore;

use stdClass;
use Throwable;

/**
 * The HTTP side of docs/store-protocol.md, for one request:
 * /<project>/v1/hello, /changes and /files/<path>. It follows
 * src/shared-store/http.ts (storeHandler), the reference grndwrk's tests use.
 */
final class Api
{
    private string $origin = '';

    public function __construct(private Database $db, private array $config) {}

    public function run(): void
    {
        try {
            $this->handle();
        } catch (Throwable $e) {
            // Never the message: it can hold the database's address or a path on the server.
            error_log('grndwrk store: ' . $e);
            $this->send(500, ['error' => 'The store failed. Its server log says why.']);
        }
    }

    private function handle(): void
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $path = explode('?', $_SERVER['REQUEST_URI'] ?? '/', 2)[0];
        $base = $this->config['base'] ?? (PHP_SAPI === 'cli-server' ? '' : rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/'));
        if ($base !== '' && str_starts_with($path, "$base/")) $path = substr($path, strlen($base));
        // The projects this token may read, at the store's own root: for All projects on the page.
        if ($path === '/v1/projects') {
            $this->projects($method);
            return;
        }
        // The page: the map in a browser, for colleagues without the repository (see page()).
        if (($method === 'GET' || $method === 'HEAD') && preg_match('#^/([a-z0-9][a-z0-9-]{0,63})(/(?!v1/).*)?$#sD', $path, $p) && $this->page($p[1], $p[2] ?? '')) {
            return;
        }
        if (!preg_match('#^/([a-z0-9][a-z0-9-]{0,63})/v1/(.*)$#sD', $path, $m)) {
            $this->send(404, ['error' => 'Not found']);
            return;
        }
        [, $project, $route] = $m;

        $file = str_starts_with($route, 'files/') ? rawurldecode(substr($route, 6)) : null;

        // The staging sites named in the config may call the comment calls from a page (CORS):
        // hello, PUT inbox/... and GET status/..., and only with a comment token. Nothing else, no other site.
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        $site = $origin !== '' && in_array($origin, (array) ($this->config['origins'] ?? []), true)
            && ($route === 'hello' || ($file !== null && (preg_match(Protocol::INBOX, $file) || preg_match(Protocol::STATUS, $file))));
        if ($method === 'OPTIONS') {
            if ($site) $this->origin = $origin;
            $this->send($site ? 204 : 403, $site ? null : ['error' => 'Not allowed from this page']);
            return;
        }

        $who = Auth::who($this->db, $project, ($_SERVER['HTTP_AUTHORIZATION'] ?? '') ?: ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ''));
        if (!$who) {
            // On a comment call from a listed site, the page may read why, so it can ask the person to log in again.
            if ($site) $this->origin = $origin;
            $this->send(401, ['error' => 'A valid token is required']);
            return;
        }
        $role = $who['role'];
        if ($site && $role === 'comment') $this->origin = $origin;

        if ($route === 'hello' && $method === 'GET') {
            // A comment token learns its commenter here: the folder its comments go in, and its status file.
            // Teammates learn that this store vouches for `from` on every comment, and the staging site comments come from.
            $first = array_values(array_filter((array) ($this->config['origins'] ?? []), fn ($o) => is_string($o) && preg_match('#^https://[a-z0-9.-]+(:\d{1,5})?$#D', $o)))[0] ?? null;
            $this->send(200, ['protocol' => Protocol::VERSION, 'project' => $this->db->project($project)['name'] ?? $project, 'writable' => $role === 'write', 'role' => $role]
                + ($role === 'comment' ? ['commenter' => $who['commenter']] : ['names' => true] + ($first !== null ? ['site' => $first] : [])));
            return;
        }

        // A commenter sees nothing of the map: only its own status, and new files in its own inbox.
        if ($role === 'comment') {
            if ($method === 'GET' && $file === "status/{$who['commenter']}.json") {
                $this->serve($project, $file);
                return;
            }
            // Only under its own name: grndwrk knows who left a comment by its path, never by what the device wrote in it.
            if (!($method === 'PUT' && $file !== null && Protocol::inboxCommenter($file) === $who['commenter'] && ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === '*')) {
                $this->send(403, ['error' => 'This token may only leave comments']);
                return;
            }
        }

        if ($route === 'changes' && $method === 'GET') {
            $this->changes($project);
            return;
        }
        if ($file === null) {
            $this->send(404, ['error' => 'Not found']);
            return;
        }
        $bad = Protocol::pathProblem($file);
        if ($bad !== '') {
            $this->send(400, ['error' => $bad]);
            return;
        }
        if ($method === 'GET') {
            $this->serve($project, $file);
            return;
        }
        if ($role === 'read') {
            $this->send(403, ['error' => 'This token may only read']);
            return;
        }
        $match = preg_match('/^"(.*)"$/sD', $_SERVER['HTTP_IF_MATCH'] ?? '', $mm) ? $mm[1] : null;
        $create = ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === '*';
        if ($method === 'PUT') {
            $this->put($project, $file, $create, $match, $role === 'comment' ? $who['name'] : null, $role === 'comment' ? (string) $who['commenter'] : null);
            return;
        }
        if ($method === 'DELETE') {
            if ($match === null) {
                $this->send(428, ['error' => 'Send If-Match']);
                return;
            }
            $r = $this->db->remove($project, $file, $match);
            if ($r['ok']) $this->send(200, new stdClass());
            elseif (!empty($r['gone'])) $this->send(404, ['error' => 'No such file']);
            else $this->send(412, ['version' => $r['version']]);
            return;
        }
        $this->send(405, ['error' => 'Not allowed']);
    }

    /** GET /v1/projects: read only, `{ projects: [{ name, url }] }`, each reached with the same token. */
    private function projects(string $method): void
    {
        if ($method !== 'GET') {
            $this->send(405, ['error' => 'Not allowed']);
            return;
        }
        $list = Auth::projects($this->db, ($_SERVER['HTTP_AUTHORIZATION'] ?? '') ?: ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ''));
        if ($list === null) {
            $this->send(401, ['error' => 'A valid token is required']);
            return;
        }
        // The addresses from the config, never from the request's Host, which whoever sends it chooses.
        $root = $this->baseUrl();
        if ($root === null) {
            $this->send(404, ['error' => 'Not found']);
            return;
        }
        $this->send(200, ['projects' => array_map(fn (array $p) => ['name' => $p['name'], 'url' => "$root{$p['slug']}/"], $list)]);
    }

    private function changes(string $project): void
    {
        $since = isset($_GET['since']) && is_string($_GET['since']) ? $_GET['since'] : null;
        $page = (int) ($this->config['page'] ?? 500);
        $result = $this->db->changes($project, $since, $page);
        // A short poll: hold the request while nothing changed, up to the config's `wait`
        // seconds (0 by default, since a held request keeps a PHP worker busy).
        $wait = min((int) ($_GET['wait'] ?? 0), (int) ($this->config['wait'] ?? 0), 25);
        for ($until = time() + $wait; $result !== null && !$result['changes'] && $since !== null && time() < $until;) {
            sleep(1);
            $result = $this->db->changes($project, $since, $page);
        }
        if ($result === null) $this->send(410, ['error' => 'Unknown cursor: read everything again']);
        else $this->send(200, $result);
    }

    private function serve(string $project, string $path): void
    {
        $f = $this->db->read($project, $path);
        if (!$f) {
            $this->send(404, ['error' => 'No such file']);
            return;
        }
        // Text and pictures people wrote: never rendered, never sniffed into HTML.
        $this->headers(200, $f['type'], ['ETag' => "\"{$f['version']}\"", 'Content-Disposition' => 'attachment', 'Content-Security-Policy' => "default-src 'none'; sandbox"]);
        echo $f['bytes'];
    }

    /**
     * The store's own address from config 'base_url', ending in /, or null when it is not set or not
     * one: https, or http on this machine only. Projects are at <base_url><project>/.
     */
    private function baseUrl(): ?string
    {
        $url = $this->config['base_url'] ?? null;
        if (!is_string($url) || !preg_match('#^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$#D', $url)) return null;
        return str_ends_with($url, '/') ? $url : "$url/";
    }

    /** $commenter: a comment token's write, held to the inbox limits (config 'inbox'). */
    private function put(string $project, string $path, bool $create, ?string $match, ?string $name, ?string $commenter): void
    {
        $comment = $commenter !== null;
        if (!$create && $match === null) {
            $this->send(428, ['error' => 'Send If-Match or If-None-Match: *']);
            return;
        }
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > Protocol::MAX_INBOX) {
            $this->send(413, ['error' => 'Too large']);
            return;
        }
        // The path decides the type; a Content-Type sent with the write is only a hint.
        $type = Protocol::typeOf($path);
        $bytes = (string) file_get_contents('php://input', false, null, 0, Protocol::MAX_INBOX + 1);
        if (strlen($bytes) > Protocol::MAX_INBOX) {
            $this->send(413, ['error' => 'Too large']);
            return;
        }
        if (Protocol::inboxCommenter($path) !== null) {
            // A comment is the JSON object the button sends to grndwrk, whoever writes it.
            $data = json_decode($bytes, false);
            if (!$data instanceof stdClass) {
                $this->send(400, ['error' => 'A comment is a JSON object']);
                return;
            }
            // From a comment token, `from` is always the store's word: the name it knows, or none at all, never the device's own.
            if ($comment) {
                unset($data->from);
                if ($name !== null && $name !== '') $data->from = $name;
                $bytes = (string) json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
            }
        }
        $problem = Protocol::bytesProblem($path, $bytes);
        if ($problem !== '') {
            $this->send(str_contains($problem, 'at most') ? 413 : 415, ['error' => $problem]);
            return;
        }
        $limits = $comment ? ['commenter' => $commenter] + (array) ($this->config['inbox'] ?? []) + self::INBOX_LIMITS : null;
        $w = $this->db->write($project, $path, $bytes, $type, $create, $match, $limits);
        if (isset($w['limited'])) {
            $this->send(429, ['error' => $w['limited']]);
            return;
        }
        $this->send($w['ok'] ? ($create ? 201 : 200) : 412, ['version' => $w['version']]);
    }

    /**
     * The page at the project's address, from the folder `grndwrk store assets` wrote
     * (config 'assets', page/ next to src/ by default): the map in a browser, which
     * signs in with a token and calls v1/... on this same address; and the Comment
     * button for a staging site (store.js, screenshot.js). The rules of
     * src/shared-store/page.ts. False when there is no such file or project, so
     * the request is answered as any other.
     */
    private function page(string $project, string $rest): bool
    {
        $dir = $this->config['assets'] ?? dirname(__DIR__) . '/page';
        if (!is_string($dir) || !is_file("$dir/index.html") || !$this->db->project($project)) return false;
        // Without the slash, the page's own files (./assets/...) would be looked for one folder up.
        if ($rest === '') {
            http_response_code(301);
            header("Location: $project/");
            return true;
        }
        $name = $rest === '/' ? 'index.html' : substr($rest, 1);
        $page = preg_match(self::PAGE_FILE, $name) === 1;
        if (!$page && $name !== 'store.js' && $name !== 'screenshot.js') return false;
        $site = '';
        if (!$page) {
            // The Comment button, only for a page on a staging site named in the config (by Referer).
            $parts = parse_url((string) ($_SERVER['HTTP_REFERER'] ?? ''));
            $origin = isset($parts['scheme'], $parts['host']) ? "{$parts['scheme']}://{$parts['host']}" . (isset($parts['port']) ? ":{$parts['port']}" : '') : '';
            $site = in_array($origin, (array) ($this->config['origins'] ?? []), true) ? $origin : '';
            if ($site === '') {
                http_response_code(403);
                header('Content-Type: text/plain; charset=utf-8');
                header('X-Content-Type-Options: nosniff');
                echo 'Only for the staging site';
                return true;
            }
        }
        $file = $name === 'store.js' ? "$dir/overlay/store.js" : "$dir/$name";
        if (!is_file($file) || ($name === 'store.js' && !is_file("$dir/overlay/feedback.js"))) return false;
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        http_response_code(200);
        header('Content-Type: ' . (self::PAGE_TYPES[$ext] ?? 'application/octet-stream'));
        header('X-Content-Type-Options: nosniff');
        header('Content-Security-Policy: ' . self::PAGE_CSP);
        header('Referrer-Policy: no-referrer');
        // Scripts and styles carry a hash in their names; the rest is checked each time.
        header('Cache-Control: ' . (str_starts_with($name, 'assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'));
        if (!$page) header('Vary: Referer');
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') return true;
        if ($name === 'store.js') {
            // One script: its config (the project's address, from config 'base_url', never the request's Host), the store mode, then the button.
            $root = $this->baseUrl();
            if ($root === null) {
                http_response_code(503);
                header('Content-Type: text/plain; charset=utf-8');
                echo 'Set base_url in config.php first';
                return true;
            }
            $url = "$root$project/";
            echo 'window.__grndwrkStoreConfig = ' . json_encode(['url' => $url, 'site' => $site], JSON_UNESCAPED_SLASHES) . ";\n";
            readfile($file);
            echo "\n";
            readfile("$dir/overlay/feedback.js");
            echo "\n";
            return true;
        }
        readfile($file);
        return true;
    }

    /**
     * What one comment token may leave in the inbox, unless config 'inbox' says otherwise. Such a token
     * may sit in a staging page, where any script on it can read it, so it must never fill the store.
     */
    private const INBOX_LIMITS = ['files_per_hour' => 60, 'mb_per_hour' => 100, 'waiting' => 500, 'total' => 5000];

    // The page's rules, as in src/shared-store/page.ts. Keep them the same.
    private const PAGE_FILE = '#^(?:index\.html|assets/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:js|css|woff2|svg|png))$#D';
    private const PAGE_TYPES = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'woff2' => 'font/woff2', 'svg' => 'image/svg+xml', 'png' => 'image/png'];
    private const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'";

    private function headers(int $status, string $type, array $extra = []): void
    {
        http_response_code($status);
        header("Content-Type: $type");
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        if ($this->origin !== '') {
            header("Access-Control-Allow-Origin: {$this->origin}");
            header('Access-Control-Allow-Methods: GET, PUT');
            header('Access-Control-Allow-Headers: Authorization, Content-Type, If-None-Match');
            header('Access-Control-Expose-Headers: ETag');
            header('Access-Control-Max-Age: 600');
        }
        header('Vary: Origin');
        foreach ($extra as $k => $v) header("$k: $v");
    }

    private function send(int $status, mixed $body): void
    {
        $this->headers($status, 'application/json');
        if ($body !== null) echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
