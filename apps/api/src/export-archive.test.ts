import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ArchiveError, buildZipArchive, normalizeArchivePath } from './export-archive';

describe('normalizeArchivePath', () => {
  it('normalizes separators and harmless dot segments', () => {
    expect(normalizeArchivePath('./results\\nested//image.png')).toBe('results/nested/image.png');
    expect(normalizeArchivePath('a')).toBe('a');
    expect(normalizeArchivePath('report?.txt')).toBe('report_.txt');
  });

  it.each(['/absolute.txt', 'C:\\absolute.txt', '../escape.txt', 'results/../../escape.txt'])(
    'rejects unsafe path %s',
    (path) => {
      expect(() => normalizeArchivePath(path)).toThrowError(ArchiveError);
      expect(() => normalizeArchivePath(path)).toThrowError(
        expect.objectContaining({ code: 'invalid_path' }),
      );
    },
  );

  it('rejects control characters and overlong paths', () => {
    expect(() => normalizeArchivePath('bad\u0000name.txt')).toThrowError(
      expect.objectContaining({ code: 'invalid_path' }),
    );
    expect(() => normalizeArchivePath('x'.repeat(241))).toThrowError(
      expect.objectContaining({ code: 'invalid_path' }),
    );
  });
});

describe('buildZipArchive', () => {
  it('creates a valid deterministic archive for text and binary entries', () => {
    const entries = [
      { path: 'workflow.json', content: '{"version":1}' },
      { path: 'results/image.bin', content: new Uint8Array([0, 1, 2, 255]) },
    ] as const;

    const first = buildZipArchive(entries);
    const second = buildZipArchive(entries);
    expect(first).toEqual(second);

    const unzipped = unzipSync(first);
    expect(Buffer.from(unzipped['workflow.json'] ?? []).toString('utf8')).toBe('{"version":1}');
    expect(Buffer.from(unzipped['results/image.bin'] ?? [])).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('rejects duplicate normalized paths', () => {
    expect(() =>
      buildZipArchive([
        { path: 'result.txt', content: 'one' },
        { path: './result.txt', content: 'two' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'duplicate_path', path: 'result.txt' }));
  });

  it('enforces entry count, entry size, and total size limits', () => {
    expect(() =>
      buildZipArchive(
        [
          { path: 'one.txt', content: '1' },
          { path: 'two.txt', content: '2' },
        ],
        { maxEntries: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'too_many_entries' }));

    expect(() =>
      buildZipArchive([{ path: 'large.txt', content: '12345' }], { maxEntryBytes: 4 }),
    ).toThrowError(expect.objectContaining({ code: 'entry_too_large', path: 'large.txt' }));

    expect(() =>
      buildZipArchive(
        [
          { path: 'one.txt', content: '123' },
          { path: 'two.txt', content: '456' },
        ],
        { maxTotalBytes: 5 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'archive_too_large' }));
  });

  it('validates compression and accepts an empty archive', () => {
    expect(buildZipArchive([], { maxEntries: 0 })).toBeInstanceOf(Buffer);
    expect(() => buildZipArchive([], { compressionLevel: 10 })).toThrowError(
      expect.objectContaining({ code: 'invalid_limit' }),
    );
  });
});
