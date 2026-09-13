import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelEntry } from '../workspace/contracts';
import { readNodeModelPreference, writeNodeModelPreference } from './node-model-preferences';

/** 同名但来源和媒体能力不同的目录，用于验证偏好隔离。 */
const models: ModelEntry[] = [
  { id: 'model-a', name: '模型 A', mediaTypes: ['image'], credentialId: 'provider-a' },
  { id: 'model-a', name: '模型 A', mediaTypes: ['text'], credentialId: 'provider-b' },
];

describe('节点模型记忆', () => {
  beforeEach(() => window.localStorage.clear());

  it('保存精确来源并隔离账号与媒体类型', () => {
    const selection = { modelAlias: 'model-a', credentialId: 'provider-a' };
    writeNodeModelPreference('user-a', 'image', 'generate', selection);
    expect(readNodeModelPreference('user-a', 'image', 'generate', models)).toEqual(selection);
    expect(readNodeModelPreference('user-b', 'image', 'generate', models)).toBeUndefined();
    expect(readNodeModelPreference('user-a', 'text', 'generate', models)).toBeUndefined();
  });

  it('模型被移除、来源被禁用或不再支持当前媒体时不自动选中', () => {
    writeNodeModelPreference('user-a', 'image', 'generate', {
      modelAlias: 'model-a',
      credentialId: 'provider-a',
    });
    expect(readNodeModelPreference('user-a', 'image', 'generate', [])).toBeUndefined();
    expect(readNodeModelPreference('user-a', 'image', 'generate', models.slice(1))).toBeUndefined();
    expect(
      readNodeModelPreference('user-a', 'image', 'generate', [
        { ...models[0], mediaTypes: ['video'] },
      ]),
    ).toBeUndefined();
  });

  it('后一次选择覆盖前一次，清空后不再恢复模型', () => {
    writeNodeModelPreference('user-a', 'text', 'generate', {
      modelAlias: 'model-a',
      credentialId: 'provider-b',
    });
    writeNodeModelPreference('user-a', 'text', 'generate', { modelAlias: '' });
    expect(readNodeModelPreference('user-a', 'text', 'generate', models)).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it('存储失败显式交给界面处理，不把持久化失败报告为成功', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is disabled', 'SecurityError');
    });
    expect(() =>
      writeNodeModelPreference('user-a', 'image', 'generate', {
        modelAlias: 'model-a',
        credentialId: 'provider-a',
      }),
    ).toThrow('Storage is disabled');
    write.mockRestore();
  });
});
