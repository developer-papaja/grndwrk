<?php

declare(strict_types=1);

namespace GrndwrkStore;

use PDO;
use RuntimeException;
use Throwable;

/**
 * Projects, tokens and files in one database, SQLite or MySQL/MariaDB.
 *
 * Each project has a counter, `seq`. Every write or delete takes the
 * project's lock, bumps the counter and stamps the file with it, so a file's
 * version is "v<seq>" and a cursor is "c_<seq>": the changes after a cursor
 * are the files stamped later. A deleted file stays as a row with
 * `deleted = 1`, so a deletion shows in the changes and every cursor keeps
 * working.
 */
final class Database
{
    private bool $mysql;

    public function __construct(public readonly PDO $pdo)
    {
        $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
        if ($driver !== 'sqlite' && $driver !== 'mysql') throw new RuntimeException("This store runs on SQLite or MySQL/MariaDB, not $driver");
        $this->mysql = $driver === 'mysql';
    }

    public static function connect(array $config): self
    {
        $pdo = new PDO($config['dsn'], $config['user'] ?? null, $config['password'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 10,
        ]);
        if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') {
            $pdo->exec('PRAGMA journal_mode = WAL');
            $pdo->exec('PRAGMA busy_timeout = 10000');
        }
        return new self($pdo);
    }

    /** Create the tables when they are not there yet. Run by admin.php, never by a request. */
    public function install(): void
    {
        if ($this->mysql) {
            $ascii = 'CHARACTER SET ascii COLLATE ascii_bin';
            $this->pdo->exec("CREATE TABLE IF NOT EXISTS projects (slug VARCHAR(64) $ascii PRIMARY KEY, name VARCHAR(200) NOT NULL, seq BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
            $this->pdo->exec("CREATE TABLE IF NOT EXISTS tokens (id INT AUTO_INCREMENT PRIMARY KEY, project VARCHAR(64) $ascii NOT NULL, hash CHAR(64) $ascii NOT NULL UNIQUE, role VARCHAR(10) NOT NULL, commenter VARCHAR(64) $ascii NULL, name VARCHAR(200) NULL, label VARCHAR(200) NULL, created VARCHAR(30) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
            $this->pdo->exec("CREATE TABLE IF NOT EXISTS files (project VARCHAR(64) $ascii NOT NULL, path VARCHAR(300) $ascii NOT NULL, version VARCHAR(100) $ascii NULL, type VARCHAR(40) NULL, bytes LONGBLOB NULL, seq BIGINT NOT NULL, deleted TINYINT NOT NULL DEFAULT 0, PRIMARY KEY (project, path), KEY files_seq (project, seq)) ENGINE=InnoDB");
            return;
        }
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0)');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, commenter TEXT, name TEXT, label TEXT, created TEXT NOT NULL)');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS files (project TEXT NOT NULL, path TEXT NOT NULL, version TEXT, type TEXT, bytes BLOB, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, path))');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS files_seq ON files (project, seq)');
    }

    private function one(string $sql, array $args = []): ?array
    {
        $q = $this->pdo->prepare($sql);
        $q->execute($args);
        $row = $q->fetch();
        return $row === false ? null : $row;
    }

    private function all(string $sql, array $args = []): array
    {
        $q = $this->pdo->prepare($sql);
        $q->execute($args);
        return $q->fetchAll();
    }

    // Projects

    public function project(string $slug): ?array
    {
        return $this->one('SELECT slug, name, seq FROM projects WHERE slug = ?', [$slug]);
    }

    public function addProject(string $slug, string $name): void
    {
        $this->pdo->prepare('INSERT INTO projects (slug, name, seq) VALUES (?, ?, 0)')->execute([$slug, $name]);
    }

    public function projects(): array
    {
        return $this->all('SELECT slug, name FROM projects ORDER BY slug');
    }

    // Tokens: only a hash of each is kept.

    /** @return array{id: int, token: string} */
    public function addToken(string $project, string $role, ?string $commenter, ?string $name, string $label): array
    {
        $token = 'gwt_' . bin2hex(random_bytes(24));
        $this->pdo->prepare('INSERT INTO tokens (project, hash, role, commenter, name, label, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
            ->execute([$project, hash('sha256', $token), $role, $commenter, $name, $label, gmdate('Y-m-d H:i:s')]);
        return ['id' => (int) $this->pdo->lastInsertId(), 'token' => $token];
    }

    public function tokens(string $project): array
    {
        return $this->all('SELECT id, role, commenter, name, label, created FROM tokens WHERE project = ? ORDER BY id', [$project]);
    }

    public function revoke(int $id): bool
    {
        $q = $this->pdo->prepare('DELETE FROM tokens WHERE id = ?');
        $q->execute([$id]);
        return $q->rowCount() > 0;
    }

    /** The token's role in this project, with the commenter and name for a comment token, or null. */
    public function tokenFor(string $project, string $bearer): ?array
    {
        return $this->one('SELECT role, commenter, name FROM tokens WHERE project = ? AND hash = ?', [$project, hash('sha256', $bearer)]);
    }

    // Files

    /** @return array{bytes: string, version: string, type: string}|null */
    public function read(string $project, string $path): ?array
    {
        $row = $this->one('SELECT bytes, version, type FROM files WHERE project = ? AND path = ? AND deleted = 0', [$project, $path]);
        if (!$row) return null;
        $bytes = is_resource($row['bytes']) ? stream_get_contents($row['bytes']) : (string) $row['bytes'];
        return ['bytes' => $bytes, 'version' => $row['version'], 'type' => $row['type']];
    }

    /**
     * Create ($create) or replace $ifVersion, never anything else.
     * @return array{ok: bool, version: ?string} the new version, or the one there (null: none)
     */
    public function write(string $project, string $path, string $bytes, string $type, bool $create, ?string $ifVersion): array
    {
        return $this->locked($project, function (int $seq) use ($project, $path, $bytes, $type, $create, $ifVersion) {
            $there = $this->one('SELECT version, deleted FROM files WHERE project = ? AND path = ?', [$project, $path]);
            $current = $there && !(int) $there['deleted'] ? $there['version'] : null;
            if ($create ? $current !== null : $current === null || $current !== $ifVersion) return [['ok' => false, 'version' => $current], false];
            $version = "v$seq";
            $sql = $there
                ? 'UPDATE files SET version = :v, type = :t, bytes = :b, seq = :s, deleted = 0 WHERE project = :p AND path = :path'
                : 'INSERT INTO files (project, path, version, type, bytes, seq, deleted) VALUES (:p, :path, :v, :t, :b, :s, 0)';
            $q = $this->pdo->prepare($sql);
            foreach ([':p' => $project, ':path' => $path, ':v' => $version, ':t' => $type, ':s' => $seq] as $k => $v) $q->bindValue($k, $v);
            $q->bindValue(':b', $bytes, PDO::PARAM_LOB);
            $q->execute();
            return [['ok' => true, 'version' => $version], true];
        });
    }

    /** @return array{ok: bool, version: ?string, gone?: bool} */
    public function remove(string $project, string $path, string $ifVersion): array
    {
        return $this->locked($project, function (int $seq) use ($project, $path, $ifVersion) {
            $there = $this->one('SELECT version FROM files WHERE project = ? AND path = ? AND deleted = 0', [$project, $path]);
            if (!$there) return [['ok' => false, 'version' => null, 'gone' => true], false];
            if ($there['version'] !== $ifVersion) return [['ok' => false, 'version' => $there['version']], false];
            $this->pdo->prepare('UPDATE files SET version = NULL, type = NULL, bytes = NULL, seq = ?, deleted = 1 WHERE project = ? AND path = ?')->execute([$seq, $project, $path]);
            return [['ok' => true, 'version' => null], true];
        });
    }

    /**
     * Run $work with the project locked: one write at a time per project, the
     * version check and the write in one transaction, so a stale write can
     * never overwrite, and changes commit in the order of their seq.
     * $work gets the next seq and returns [result, whether it used the seq].
     */
    private function locked(string $project, callable $work): array
    {
        // SQLite: IMMEDIATE takes the write lock before the first read. MySQL: the project's row, FOR UPDATE.
        if ($this->mysql) $this->pdo->beginTransaction();
        else $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $row = $this->one('SELECT seq FROM projects WHERE slug = ?' . ($this->mysql ? ' FOR UPDATE' : ''), [$project]);
            if (!$row) throw new RuntimeException('No such project');
            $seq = (int) $row['seq'] + 1;
            [$result, $used] = $work($seq);
            if ($used) $this->pdo->prepare('UPDATE projects SET seq = ? WHERE slug = ?')->execute([$seq, $project]);
            if ($this->mysql) $this->pdo->commit();
            else $this->pdo->exec('COMMIT');
            return $result;
        } catch (Throwable $e) {
            if ($this->mysql) $this->pdo->rollBack();
            else $this->pdo->exec('ROLLBACK');
            throw $e;
        }
    }

    /** The latest seq of a project: changes up to it have committed. */
    public function top(string $project): int
    {
        return (int) ($this->project($project)['seq'] ?? 0);
    }

    /**
     * What changed after the cursor, each path once at its latest state; or
     * every file that exists without one. Null when the cursor is not one this
     * store gave.
     */
    public function changes(string $project, ?string $since, int $page): ?array
    {
        $top = $this->top($project);
        $page = max(1, $page);
        if ($since === null || $since === '') {
            $from = 0;
            $live = ' AND deleted = 0';
        } else {
            if (!preg_match('/^c_(\d{1,18})$/D', $since, $m) || (int) $m[1] > $top) return null;
            $from = (int) $m[1];
            $live = '';
        }
        $limit = $page + 1;
        $rows = $this->all("SELECT path, version, deleted, seq FROM files WHERE project = ? AND seq > ? AND seq <= ?$live ORDER BY seq LIMIT $limit", [$project, $from, $top]);
        $more = count($rows) > $page;
        if ($more) array_pop($rows);
        $changes = array_map(fn (array $r) => (int) $r['deleted'] ? ['path' => $r['path'], 'deleted' => true] : ['path' => $r['path'], 'version' => $r['version']], $rows);
        $cursor = $more ? (int) end($rows)['seq'] : $top;
        return ['cursor' => "c_$cursor", 'changes' => $changes, 'more' => $more];
    }
}
