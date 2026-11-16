<?php

declare(strict_types=1);

namespace GrndwrkStore;

/**
 * The rules of docs/store-protocol.md: which paths a store keeps, their types
 * and sizes. A port of src/shared-store/protocol.ts; keep the two the same.
 * Every pattern ends in `$/D`, so a trailing newline never slips through.
 */
final class Protocol
{
    public const VERSION = 1;
    public const SYNCED_FILES = ['project.md'];
    public const SYNCED_FOLDERS = ['nodes', 'threads', 'stories', 'screens', 'personas', 'segments', 'waiting', 'files', 'readiness', 'outputs'];
    public const MAX_PATH = 300;
    public const MAX_TEXT = 1_000_000;
    public const MAX_PICTURE = 10_000_000;
    /** A comment in the inbox carries its picture, as grndwrk's /api/feedback does. */
    public const MAX_INBOX = 14_000_000;
    public const TYPES = ['md' => 'text/markdown', 'json' => 'application/json', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg'];
    /** inbox/<commenter>/<id>.json: one comment, left by a comment token. */
    public const INBOX = '/^inbox\/([A-Za-z0-9_-]{8,64})\/[A-Za-z0-9_-]{8,64}\.json$/D';
    /** status/<commenter>.json: what became of that commenter's comments, written by grndwrk. */
    public const STATUS = '/^status\/[A-Za-z0-9_-]{8,64}\.json$/D';
    public const COMMENTER = '/^[A-Za-z0-9_-]{8,64}$/D';
    private const PART = '/^[A-Za-z0-9][A-Za-z0-9._-]*$/D';

    /** Why a path may not be in a store, or '' when it may. */
    public static function pathProblem(string $path): string
    {
        if ($path === '') return 'A path is required';
        if (preg_match(self::INBOX, $path) || preg_match(self::STATUS, $path)) return '';
        if (strlen($path) > self::MAX_PATH) return 'A path is at most ' . self::MAX_PATH . ' characters';
        $parts = explode('/', $path);
        if (count($parts) > 8) return 'A path has at most eight parts';
        foreach ($parts as $part) {
            if (!preg_match(self::PART, $part) || $part === '.' || $part === '..') {
                return 'Each part of a path starts with a letter or digit and holds only letters, digits, ".", "_" and "-"';
            }
        }
        $synced = count($parts) === 1 ? in_array($parts[0], self::SYNCED_FILES, true) : in_array($parts[0], self::SYNCED_FOLDERS, true);
        if (!$synced) return "$path is not something a store keeps";
        if (self::typeOf($path) === '') return 'Only .md, .json, .png and .jpg files are kept';
        return '';
    }

    /** The type a path's extension stands for, or '' for any other. */
    public static function typeOf(string $path): string
    {
        if (!preg_match('/\.([A-Za-z0-9]+)$/D', $path, $m)) return '';
        return self::TYPES[strtolower($m[1])] ?? '';
    }

    /** Why these bytes may not be kept at this path, or ''. Pictures must really be PNG or JPEG. */
    public static function bytesProblem(string $path, string $bytes): string
    {
        $type = self::typeOf($path);
        $size = strlen($bytes);
        if ($type === 'image/png' || $type === 'image/jpeg') {
            if ($size > self::MAX_PICTURE) return 'A picture is at most ' . (self::MAX_PICTURE / 1_000_000) . ' MB';
            $png = $size > 8 && str_starts_with($bytes, "\x89PNG");
            $jpeg = $size > 3 && str_starts_with($bytes, "\xFF\xD8\xFF");
            if ($type === 'image/png' ? !$png : !$jpeg) return "$path is not a " . ($type === 'image/png' ? 'PNG' : 'JPEG');
            return '';
        }
        if (preg_match(self::INBOX, $path)) return $size > self::MAX_INBOX ? 'A comment is at most ' . (self::MAX_INBOX / 1_000_000) . ' MB' : '';
        if ($size > self::MAX_TEXT) return 'A text file is at most ' . (self::MAX_TEXT / 1_000_000) . ' MB';
        return '';
    }

    /** The commenter an inbox path names, or null when it is not an inbox path. */
    public static function inboxCommenter(string $path): ?string
    {
        return preg_match(self::INBOX, $path, $m) ? $m[1] : null;
    }
}
