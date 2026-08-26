import { zipSync, type ZipOptions } from 'fflate';

/** A file to include in an exported archive. Paths are always relative. */
export type ArchiveEntry = {
  path: string;
  content: Uint8Array | string;
};

export type ArchiveErrorCode =
  | 'invalid_entry'
  | 'invalid_path'
  | 'duplicate_path'
  | 'invalid_limit'
  | 'too_many_entries'
  | 'entry_too_large'
  | 'archive_too_large';

/** Error raised for invalid archive input or configured safety limits. */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  readonly path?: string;
  readonly limit?: number;
  readonly actual?: number;

  constructor(
    code: ArchiveErrorCode,
    message: string,
    details: { path?: string; limit?: number; actual?: number } = {},
  ) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.path = details.path;
    this.limit = details.limit;
    this.actual = details.actual;
  }
}

/** Conservative defaults for HTTP exports. Callers can lower these per request. */
export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 1_000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
});

const MAX_PATH_BYTES = 240;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_FORBIDDEN_CHARACTER_PATTERN = /[<>:"|?*]/g;

export type BuildZipArchiveOptions = {
  /** Maximum number of files in the archive (directories are not emitted). */
  maxEntries?: number;
  /** Maximum uncompressed size of one file. */
  maxEntryBytes?: number;
  /** Maximum sum of uncompressed file sizes. */
  maxTotalBytes?: number;
  /** fflate compression level, from 0 (store) through 9 (maximum). */
  compressionLevel?: number;
  /** ZIP timestamps. Defaults to the Unix epoch for reproducible exports. */
  mtime?: ZipOptions['mtime'];
};

/**
 * Normalize a user-facing file name into a safe, relative ZIP path.
 *
 * Windows separators are converted to `/`, harmless `.` segments are removed,
 * and characters that are invalid on common extraction targets are replaced.
 * Parent segments, absolute paths, NUL/control characters, and overlong names
 * are rejected instead of being silently changed into a different path.
 */
export function normalizeArchivePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ArchiveError('invalid_path', 'archive entry path is required');
  }

  const source = input.normalize('NFC').replace(/\\/g, '/');
  if (
    source.startsWith('/') ||
    source.startsWith('\\') ||
    /^[A-Za-z]:/.test(source) ||
    CONTROL_CHARACTER_PATTERN.test(source)
  ) {
    throw new ArchiveError('invalid_path', 'archive entry path must be relative and printable', {
      path: input,
    });
  }

  const segments: string[] = [];
  for (const rawSegment of source.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;
    if (rawSegment === '..') {
      throw new ArchiveError('invalid_path', 'archive entry path cannot contain parent segments', {
        path: input,
      });
    }

    // Keep the path useful across Windows, macOS, and Linux extraction tools.
    // Trailing spaces/dots are stripped because Windows otherwise aliases names.
    const segment = rawSegment
      .replace(WINDOWS_FORBIDDEN_CHARACTER_PATTERN, '_')
      .replace(/[. ]+$/g, '')
      .trim();
    // A segment such as `.. .` can become `..` after Windows cleanup. Check
    // again after sanitizing so an alias of the parent directory is never
    // emitted into the archive.
    if (segment === '..') {
      throw new ArchiveError('invalid_path', 'archive entry path cannot contain parent segments', {
        path: input,
      });
    }
    segments.push(segment || '_');
  }

  const normalized = segments.join('/');
  if (!normalized) {
    throw new ArchiveError('invalid_path', 'archive entry path cannot be empty', { path: input });
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_PATH_BYTES) {
    throw new ArchiveError(
      'invalid_path',
      `archive entry path exceeds the ${MAX_PATH_BYTES}-byte limit`,
      { path: input, limit: MAX_PATH_BYTES, actual: Buffer.byteLength(normalized, 'utf8') },
    );
  }
  return normalized;
}

/**
 * Build a deterministic ZIP archive from in-memory entries.
 *
 * The limits apply to uncompressed bytes, which prevents a highly compressible
 * input from bypassing the export policy. Duplicate normalized paths are
 * rejected so extraction cannot overwrite an earlier file ambiguously.
 */
export function buildZipArchive(
  entries: readonly ArchiveEntry[],
  options: BuildZipArchiveOptions = {},
): Buffer {
  if (!Array.isArray(entries)) {
    throw new ArchiveError('invalid_entry', 'archive entries must be an array');
  }

  const limits = resolveLimits(options);
  if (entries.length > limits.maxEntries) {
    throw new ArchiveError(
      'too_many_entries',
      `archive contains more than the ${limits.maxEntries}-entry limit`,
      { limit: limits.maxEntries, actual: entries.length },
    );
  }

  const files: Record<string, Uint8Array> = {};
  const paths = new Set<string>();
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new ArchiveError('invalid_entry', 'archive entries require a string path');
    }
    const path = normalizeArchivePath(entry.path);
    if (paths.has(path)) {
      throw new ArchiveError('duplicate_path', `archive contains duplicate path: ${path}`, {
        path,
      });
    }
    paths.add(path);

    const content = toBytes(entry.content, path);
    const size = content.byteLength;
    if (size > limits.maxEntryBytes) {
      throw new ArchiveError(
        'entry_too_large',
        `archive entry exceeds the ${limits.maxEntryBytes}-byte limit`,
        { path, limit: limits.maxEntryBytes, actual: size },
      );
    }
    if (totalBytes > limits.maxTotalBytes - size) {
      const attemptedTotal = totalBytes + size;
      throw new ArchiveError(
        'archive_too_large',
        `archive entries exceed the ${limits.maxTotalBytes}-byte limit`,
        { limit: limits.maxTotalBytes, actual: attemptedTotal },
      );
    }
    totalBytes += size;
    files[path] = content;
  }

  const archive = zipSync(files, {
    level: limits.compressionLevel,
    // A fixed timestamp makes exports byte-for-byte reproducible, which is
    // useful for downloads, cache keys, and integrity tests.
    mtime: options.mtime ?? new Date('1980-01-01T00:00:00.000Z'),
  });
  return Buffer.from(archive);
}

function resolveLimits(options: BuildZipArchiveOptions): {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  compressionLevel: ZipOptions['level'];
} {
  const maxEntries = nonNegativeInteger(
    options.maxEntries ?? DEFAULT_ARCHIVE_LIMITS.maxEntries,
    'maxEntries',
  );
  const maxEntryBytes = nonNegativeInteger(
    options.maxEntryBytes ?? DEFAULT_ARCHIVE_LIMITS.maxEntryBytes,
    'maxEntryBytes',
  );
  const maxTotalBytes = nonNegativeInteger(
    options.maxTotalBytes ?? DEFAULT_ARCHIVE_LIMITS.maxTotalBytes,
    'maxTotalBytes',
  );
  const compressionLevel = options.compressionLevel ?? 6;
  if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
    throw new ArchiveError('invalid_limit', 'compressionLevel must be an integer from 0 to 9');
  }
  return {
    maxEntries,
    maxEntryBytes,
    maxTotalBytes,
    compressionLevel: compressionLevel as ZipOptions['level'],
  };
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArchiveError('invalid_limit', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function toBytes(content: ArchiveEntry['content'], path: string): Uint8Array {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new ArchiveError('invalid_entry', `archive entry content is invalid: ${path}`, { path });
}
