import { expect, test } from '@playwright/test';
import { deflateSync, inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function crc(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
const pixels = Buffer.alloc((320 * 3 + 1) * 240, 120);
for (let row = 0; row < 240; row++) pixels[row * (320 * 3 + 1)] = 0;
const header = Buffer.alloc(13);
header.writeUInt32BE(320);
header.writeUInt32BE(240, 4);
header[8] = 8;
header[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('tEXt', Buffer.from('Note\0synthetic fixture')),
  chunk('IDAT', deflateSync(pixels, { level: 0 })),
  chunk('IEND', Buffer.alloc(0)),
]);

for (const { width, jpeg } of [
  { width: 1440, jpeg: false },
  { width: 390, jpeg: false },
  { width: 1440, jpeg: true },
]) {
  test(`${jpeg ? 'JPG' : 'PNG'} 压缩副本与预览底部 ${width}px`, async ({ page, baseURL }, info) => {
    test.setTimeout(60_000);
    if (!baseURL || new URL(baseURL).hostname !== '127.0.0.1')
      throw new Error('仅使用本机隔离测试');
    await page.setViewportSize({ width, height: 900 });
    let source = png;
    if (jpeg) {
      const base64 = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createLinearGradient(0, 0, 320, 240);
        gradient.addColorStop(0, '#102050');
        gradient.addColorStop(1, '#ffcc40');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 320, 240);
        return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
      });
      source = Buffer.from(base64, 'base64');
      // 插入合法的重复量化表和标记填充，验证精简不改变解码像素。
      for (let offset = 2; offset < source.length;) {
        const marker = source[offset + 1];
        const end = offset + 2 + source.readUInt16BE(offset + 2);
        if (marker === 0xdb) {
          source = Buffer.concat([
            source.subarray(0, end),
            Buffer.from([255, 255]),
            source.subarray(offset, end),
            source.subarray(end),
          ]);
          break;
        }
        offset = end;
      }
    }
    const filename = jpeg ? '合成.jpg' : '合成.png';
    const mimeType = jpeg ? 'image/jpeg' : 'image/png';
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const origin = new URL(baseURL).origin;
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.route('**/synthetic-image', (route) =>
      route.fulfill({ contentType: mimeType, body: source }),
    );
    const uiPath = resolve('../../packages/ui/src').replaceAll('\\', '/');
    // 只替换测试页入口，挂载真实组件；不加载账号、项目或生产 API。
    await page.route('**/src/main.tsx', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      const { createElement: h, useState } = React;
      const { createRoot } = ReactDOM;
      import { UiProvider } from '/@fs/${uiPath}/index.ts';
      import '/@fs/${uiPath}/styles.css';
      import '/src/index.css';
      import { AssetViewerDialog } from '/src/workspace/AssetPreview.tsx';
      function Fixture() {
        const [open, setOpen] = useState(false);
        return h(UiProvider, null,
          h('button', { onClick: () => setOpen(true) }, '打开测试预览'),
          h(AssetViewerDialog, { asset: { id: 'synthetic-image', name: '${filename}', mediaType: 'image', mimeType: '${mimeType}', sizeBytes: ${source.length}, status: 'ready', contentUrl: location.origin + '/synthetic-image', tags: [] }, open, onOpenChange: setOpen }));
      }
      createRoot(document.getElementById('root')).render(h(Fixture));
    `,
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: '打开测试预览' }).click();
    const dialog = page.getByRole('dialog', { name: filename });
    await expect(dialog.locator('.artifact-preview-file-size')).toContainText('KB');
    await expect
      .poll(() => dialog.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(320);
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '无损压缩副本' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(jpeg ? '合成-无损压缩.jpg' : '合成-无损压缩.png');
    const output = await readFile((await download.path())!);
    expect(output.length).toBeLessThan(source.length);
    if (jpeg) {
      const identical = await page.evaluate(
        async ({ before, after }) => {
          const decode = async (base64: string) => {
            const image = await createImageBitmap(
              new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
                type: 'image/jpeg',
              }),
            );
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0);
            image.close();
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          };
          const a = await decode(before);
          const b = await decode(after);
          return a.length === b.length && a.every((value, index) => value === b[index]);
        },
        { before: source.toString('base64'), after: output.toString('base64') },
      );
      expect(identical).toBe(true);
    } else {
      const idat: Buffer[] = [];
      for (let offset = 8; offset < output.length;) {
        const length = output.readUInt32BE(offset);
        if (output.toString('ascii', offset + 4, offset + 8) === 'IDAT')
          idat.push(output.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      expect(inflateSync(Buffer.concat(idat))).toEqual(pixels);
      expect(output.includes(Buffer.from('Note\0synthetic fixture'))).toBe(true);
    }
    await expect(dialog.locator('.artifact-compression').getByRole('status')).toContainText(
      '已下载副本',
    );
    const bounds = await dialog.locator('.artifact-preview-viewer-footer').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const stage = await dialog.locator('.artifact-preview-image-stage').boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(stage!.y + stage!.height);
    await page.screenshot({ path: info.outputPath('compression-preview.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: '打开测试预览' })).toBeFocused();
    expect(errors).toEqual([]);
  });
}
