import { describe, expect, it } from 'vitest';
import { formatAssetFileSize, resolveAssetFileSize } from './asset-file-size';

describe('文件大小', () => {
  it.each([
    [undefined, '未知'],
    [0, '未知'],
    [-1, '未知'],
    [NaN, '未知'],
    [Infinity, '未知'],
    [1.5, '未知'],
    [123, '123 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [1024 ** 2, '1 MB'],
    [1024 ** 3, '1 GB'],
  ])('格式化 %s 为 %s', (size, expected) => {
    expect(formatAssetFileSize(size)).toBe(expected);
  });

  const latest = {
    id: 'file',
    contentUrl: '/api/assets/file/content',
    latestVersion: 2,
    sizeBytes: 4096,
  };

  it('生成结果的明确大小优先于索引，缺失时只补全同一版本', () => {
    const result = {
      id: 'file',
      contentUrl: '/api/assets/file/versions/1/content',
      latestVersion: 1,
    };
    expect(resolveAssetFileSize({ ...result, sizeBytes: 123 }, latest)).toBe(123);
    expect(resolveAssetFileSize(result, latest)).toBeUndefined();
    expect(resolveAssetFileSize(result, { ...latest, latestVersion: 1 })).toBe(4096);
  });

  it('来源节点冻结地址匹配索引版本，旧版本不能借用最新大小', () => {
    expect(
      resolveAssetFileSize(
        { id: 'file', contentUrl: '/api/assets/file/versions/2/content' },
        latest,
      ),
    ).toBe(4096);
    expect(
      resolveAssetFileSize(
        { id: 'file', contentUrl: '/api/assets/file/versions/1/content' },
        latest,
      ),
    ).toBeUndefined();
  });

  it('只有同一资源的相同未冻结内容地址可以补全旧数据', () => {
    expect(resolveAssetFileSize({ id: 'file', contentUrl: latest.contentUrl }, latest)).toBe(4096);
    expect(
      resolveAssetFileSize({ id: 'other', contentUrl: latest.contentUrl }, latest),
    ).toBeUndefined();
    expect(resolveAssetFileSize({ id: 'file', contentUrl: 'blob:old' }, latest)).toBeUndefined();
  });

  it('索引最新大小不能冒充冻结的旧版本大小', () => {
    expect(
      resolveAssetFileSize({ ...latest, contentUrl: '/api/assets/file/versions/1/content' }),
    ).toBeUndefined();
  });
});
