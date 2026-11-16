<?php

declare(strict_types=1);

namespace GrndwrkStore;

/**
 * Who is asking: the one place a request becomes a role. Change this to use
 * your own login (see README.md, "Your own login"); the rest of the store
 * only needs what this returns.
 */
final class Auth
{
    /**
     * @return array{role: 'read'|'write'|'comment', commenter: ?string, name: ?string}|null
     *   commenter and name only for a comment token: the id its comments must
     *   be filed under, and the name the store puts in their `from`.
     */
    public static function who(Database $db, string $project, string $authorization): ?array
    {
        if (!preg_match('/^Bearer ([A-Za-z0-9_\-.~+\/]{16,200}=*)$/D', $authorization, $m)) return null;
        $row = $db->tokenFor($project, $m[1]);
        if (!$row || !in_array($row['role'], ['read', 'write', 'comment'], true)) return null;
        if ($row['role'] === 'comment' && !preg_match(Protocol::COMMENTER, (string) $row['commenter'])) return null;
        return ['role' => $row['role'], 'commenter' => $row['commenter'], 'name' => $row['name']];
    }

    /**
     * The projects a token may read, for GET /v1/projects at the store's root. A token
     * here belongs to one project, so that one; a comment token reads no map, so none.
     * With your own login, list every project the person may read.
     *
     * @return list<array{slug: string, name: string}>|null null when the token is not one
     */
    public static function projects(Database $db, string $authorization): ?array
    {
        if (!preg_match('/^Bearer ([A-Za-z0-9_\-.~+\/]{16,200}=*)$/D', $authorization, $m)) return null;
        $row = $db->tokenProject($m[1]);
        if (!$row) return null;
        return $row['role'] === 'read' || $row['role'] === 'write' ? [['slug' => $row['project'], 'name' => $row['name']]] : [];
    }
}
