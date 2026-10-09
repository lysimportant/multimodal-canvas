import { describe, expect, it } from 'vitest';
import { newApiRequestIdSchema } from './index';
describe('New API 请求关联身份', () => {
  it.each(['request-1', 'request:with-safe.ID_1', 'A_b.c:d-9'])(
    '接受可持久化的请求 ID %s',
    (requestId) => {
      expect(newApiRequestIdSchema.safeParse(requestId).success).toBe(true);
    },
  );
  it.each(['.', '..', 'request/segment', 'request with space', 'r'.repeat(65), '中文'])(
    '拒绝不能作为单一路径段的请求 ID %s',
    (requestId) => {
      expect(newApiRequestIdSchema.safeParse(requestId).success).toBe(false);
    },
  );
});
