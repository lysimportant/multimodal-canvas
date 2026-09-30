import { assetSchema, type Asset } from '@multimodal-canvas/domain';

import {
  apiFetch,
  AuthSessionChangedError,
  getAuthSessionGeneration,
  readStoredAuthSession,
  verifyUnauthorized,
} from '../auth-client';
import {
  buildUploadCompletePayload,
  buildUploadInitPayload,
  resolveCompleteUrl,
  resolveUploadUrl,
  sha256Hex,
} from '../upload-utils';
import { API_BASE_URL } from './contracts';

type UploadResponse = {
  uploadId?: string;
  uploadUrl?: string;
  completeUrl?: string;
  error?: string;
};

type CompleteResponse = {
  asset?: unknown;
  error?: string;
};

/** 兼容现代 File 与旧版测试/浏览器实现，读取文件原始字节。 */
async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Uint8Array(
    await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('无法读取文件'));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) resolve(reader.result);
        else reject(new Error('无法读取文件'));
      };
      reader.readAsArrayBuffer(file);
    }),
  );
}

/**
 * 将文件上传为项目资源，供 Skill 工作台的临时优化上下文引用。
 *
 * @param file 浏览器选择的本地文件；服务端会按文件名和 MIME 类型判断媒体类型。
 * @returns 已完成校验、可插入 PromptDocument 提及的资源摘要。
 * @throws Error 上传初始化、内容传输、会话切换或完成确认失败时抛出，不重发写请求。
 */
export async function uploadSkillWorkbenchAsset(file: File): Promise<Asset> {
  const content = await readFileBytes(file);
  if (content.byteLength === 0) throw new Error(`${file.name} 不能为空`);

  const metadata = {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: content.byteLength,
    sha256: await sha256Hex(content),
  };
  const expectedAuthGeneration = getAuthSessionGeneration();
  const initResponse = await apiFetch(
    `${API_BASE_URL}/v1/assets/uploads/init`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildUploadInitPayload(metadata)),
    },
    { expectedAuthGeneration },
  );
  const initResult = (await initResponse.json().catch(() => ({}))) as UploadResponse;
  if (
    !initResponse.ok ||
    !initResult.uploadId ||
    !initResult.uploadUrl ||
    !initResult.completeUrl
  ) {
    throw new Error(initResult.error ?? `${file.name} 上传初始化失败`);
  }

  const uploadExpiresAt = readStoredAuthSession()?.expiresAt;
  await putUploadContent(
    resolveUploadUrl(initResult.uploadUrl, API_BASE_URL),
    content,
    expectedAuthGeneration,
    uploadExpiresAt,
  );

  const completeResponse = await apiFetch(
    resolveCompleteUrl(initResult.completeUrl, API_BASE_URL),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildUploadCompletePayload(initResult.uploadId, metadata)),
    },
    { expectedAuthGeneration },
  );
  const completeResult = (await completeResponse.json().catch(() => ({}))) as CompleteResponse;
  if (!completeResponse.ok || !completeResult.asset) {
    throw new Error(completeResult.error ?? `${file.name} 上传完成确认失败`);
  }
  if (expectedAuthGeneration !== getAuthSessionGeneration()) throw new AuthSessionChangedError();

  return assetSchema.parse(completeResult.asset);
}

/**
 * 传输已初始化的对象内容；使用 XHR 保留现有上传端点对外部预签名 URL 的兼容性。
 * @param url 服务端返回的对象上传地址。
 * @param content 文件二进制内容。
 * @param expectedAuthGeneration 发起上传时的会话代次。
 * @param expectedExpiresAt 发起上传时的会话过期时间。
 * @throws AuthSessionChangedError 账户在传输期间发生切换。
 */
async function putUploadContent(
  url: string,
  content: Uint8Array,
  expectedAuthGeneration: number,
  expectedExpiresAt?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.withCredentials = true;
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.onerror = () => reject(new Error('资源上传请求失败'));
    request.onload = () => {
      if (expectedAuthGeneration !== getAuthSessionGeneration()) {
        reject(new AuthSessionChangedError());
        return;
      }
      if (request.status === 401) {
        void verifyUnauthorized(API_BASE_URL, expectedAuthGeneration, expectedExpiresAt);
        reject(new Error('资源上传失败（401）'));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`资源上传失败（${request.status}）`));
        return;
      }
      resolve();
    };
    request.send(content.slice().buffer as ArrayBuffer);
  });
}
