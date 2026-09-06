import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalEmailFile } from './local-email';

/** 测试目录只保存合成邮件值，避免触碰真实桌面配置。 */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('本地 email.txt 自动读取', () => {
  it('只读取白名单字段并校验端口与 TLS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'multimodal-email-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'email.txt');
    await writeFile(
      filePath,
      [
        'EMAIL_HOST=smtp.example.test',
        'EMAIL_PORT=465',
        'EMAIL_SECURE=true',
        'EMAIL_USER=sender@example.test',
        'EMAIL_PASS=synthetic-password',
        'EMAIL_FROM=sender@example.test',
        'UNRELATED=ignored',
      ].join('\n'),
    );
    await expect(readLocalEmailFile(filePath)).resolves.toEqual({
      EMAIL_HOST: 'smtp.example.test',
      EMAIL_PORT: '465',
      EMAIL_SECURE: 'true',
      EMAIL_USER: 'sender@example.test',
      EMAIL_PASS: 'synthetic-password',
      EMAIL_FROM: 'sender@example.test',
    });
  });

  it('缺少本地文件时返回空配置，让服务明确显示未配置', async () => {
    await expect(
      readLocalEmailFile(join(tmpdir(), 'multimodal-email-missing.txt')),
    ).resolves.toEqual({});
  });
});
