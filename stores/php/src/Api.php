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
            $this->send(200, ['protocol' => Protocol::VERSION, 'project' => $this->db->project($project)['name'] ?? $project, 'writable' => $role === 'write', 'role' => $role]
                // A comment token learns its commenter here: the folder its comments go in, and its status file.
                + ($role === 'comment' ? ['commenter' => $who['commenter']] : []));
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
            $this->put($project, $file, $create, $match, $role === 'comment' ? $who['name'] : null, $role === 'comment');
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

    private function put(string $project, string $path, bool $create, ?string $match, ?string $name, bool $comment): void
    {
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
            // From a comment token, the name the store knows wins over the device's.
            if ($comment && $name !== null && $name !== '') {
                $data->from = $name;
                $bytes = (string) json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
            }
        }
        $problem = Protocol::bytesProblem($path, $bytes);
        if ($problem !== '') {
            $this->send(str_contains($problem, 'at most') ? 413 : 415, ['error' => $problem]);
            return;
        }
        $w = $this->db->write($project, $path, $bytes, $type, $create, $match);
        $this->send($w['ok'] ? ($create ? 201 : 200) : 412, ['version' => $w['version']]);
    }

    /**
     * The page at the project's address, from the folder `grndwrk store assets` wrote
     * (config 'assets', page/ next to src/ by default): the map in a browser, which
     * signs in with a token and calls v1/... on this same address. Only the names
     * PAGE_FILE allows, as in src/shared-store/page.ts. False when there is no such
     * file or project, so the request is answered as any other.
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
        if (!preg_match(self::PAGE_FILE, $name) || !is_file("$dir/$name")) return false;
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        http_response_code(200);
        header('Content-Type: ' . (self::PAGE_TYPES[$ext] ?? 'application/octet-stream'));
        header('X-Content-Type-Options: nosniff');
        header('Content-Security-Policy: ' . self::PAGE_CSP);
        header('Referrer-Policy: no-referrer');
        // Scripts and styles carry a hash in their names; the page itself is checked each time.
        header('Cache-Control: ' . (str_starts_with($name, 'assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'));
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') readfile("$dir/$name");
        return true;
    }

    // The page's rules, as in src/shared-store/page.ts. Keep them the same.
    private const PAGE_FILE = '#^(?:index\.html|feedback\.js|store\.js|screenshot\.js|assets/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:js|css|woff2|svg|png))$#D';
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
