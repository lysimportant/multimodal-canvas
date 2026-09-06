/** SMTP 配置边界测试，仅使用合成字段。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEmailEnvironment } from './email-config.mjs';

/** 非真实的测试参数，包含引号和特殊字符以验证 dotenv 解析。 */
const example =
  'EMAIL_HOST=smtp.example.test\nEMAIL_PORT=465\nEMAIL_SECURE=true\nEMAIL_USER=sender@example.test\nEMAIL_PASS="synthetic # value"\nEMAIL_FROM="Canvas <sender@example.test>"\nNODE_OPTIONS=not-allowed';

test('解析引号和特殊字符并只保留邮件白名单', () => {
  const environment = parseEmailEnvironment(example);
  assert.equal(environment.EMAIL_PASS, 'synthetic # value');
  assert.equal(environment.EMAIL_FROM, 'Canvas <sender@example.test>');
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(Object.keys(environment).length, 6);
});

test('缺少字段和非法端口、TLS值、换行均拒绝且不回显凭据', () => {
  assert.throws(
    () => parseEmailEnvironment(example.replace('EMAIL_PORT=465', 'EMAIL_PORT=0')),
    /EMAIL_PORT/,
  );
  assert.throws(
    () => parseEmailEnvironment(example.replace('EMAIL_SECURE=true', 'EMAIL_SECURE=maybe')),
    /EMAIL_SECURE/,
  );
  assert.throws(() => parseEmailEnvironment('EMAIL_PASS=synthetic-value'), /EMAIL_HOST/);
  assert.throws(
    () => parseEmailEnvironment(example.replace('synthetic # value', 'synthetic\nvalue')),
    /非法字符/,
  );
});
