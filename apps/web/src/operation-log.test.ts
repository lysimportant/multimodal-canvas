import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearOperationLogs,
  OPERATION_LOG_LIMIT,
  OPERATION_LOG_STORAGE_PREFIX,
  readOperationLogs,
  recordOperationLog,
} from './operation-log';

describe('browser-local operation log', () => {
  beforeEach(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(OPERATION_LOG_STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  });

  it('scopes entries to an account and only stores allowlisted metadata', () => {
    recordOperationLog('user-a', {
      category: 'request',
      action: '请求已发出',
      method: 'POST',
      path: '/v1/nodes/node-1/runs?token=private',
      outcome: 'pending',
      // Runtime callers cannot smuggle arbitrary payload data into local storage.
      prompt: 'private prompt',
      body: 'private request body',
    } as never);

    expect(readOperationLogs('user-b')).toEqual([]);
    const [entry] = readOperationLogs('user-a');
    expect(entry).toMatchObject({
      category: 'request',
      method: 'POST',
      path: '/v1/nodes/node-1/runs',
      outcome: 'pending',
    });
    expect(entry).not.toHaveProperty('prompt');
    expect(entry).not.toHaveProperty('body');
    clearOperationLogs('user-a');
    expect(readOperationLogs('user-a')).toEqual([]);
  });

  it('keeps at most the newest one thousand entries', () => {
    for (let index = 0; index < OPERATION_LOG_LIMIT + 2; index += 1) {
      recordOperationLog('user-a', {
        category: 'canvas',
        action: '添加节点',
        projectId: String(index),
      });
    }
    const entries = readOperationLogs('user-a');
    expect(entries).toHaveLength(OPERATION_LOG_LIMIT);
    expect(entries[0]?.projectId).toBe('1001');
  });

  it('keeps anonymous authentication failures visible before login', () => {
    recordOperationLog(null, {
      category: 'request',
      action: '请求返回错误',
      method: 'GET',
      path: '/v1/auth/me',
      statusCode: 401,
      errorCode: 'authentication_required',
      errorMessage: 'authentication required',
      outcome: 'error',
    });

    expect(readOperationLogs(null)[0]).toMatchObject({
      path: '/v1/auth/me',
      statusCode: 401,
      errorCode: 'authentication_required',
      errorMessage: 'authentication required',
    });
  });
});
