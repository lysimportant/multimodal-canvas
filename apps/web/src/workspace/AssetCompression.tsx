import { useEffect, useRef, useState } from 'react';
import type { Asset } from '@multimodal-canvas/domain';
import { Button } from '@multimodal-canvas/ui';
import { downloadProjectExport } from '../export-utils';
import { getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import { formatAssetFileSize } from './asset-file-size';
import { compressPngLosslessly } from './lossless-png';
import { compressJpegLosslessly } from './lossless-jpeg';
import { fetchNodeAssetDownload } from './node-asset-download';

/** 压缩只下载独立副本，不修改当前资产、版本或画布。 */
export function AssetCompression({ asset }: { asset: Asset }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const identity = `${asset.id}:${asset.contentUrl}:${asset.latestVersion ?? ''}`;
  useEffect(() => {
    setBusy(false);
    setMessage('');
    setFailed(false);
    const unsubscribe = subscribeAuthSession(() => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      setMessage('');
    });
    return () => {
      unsubscribe();
      pending.current?.abort();
      pending.current = null;
    };
  }, [identity]);
  const mimeType = asset.mimeType.split(';')[0].trim().toLowerCase();
  const isPng = mimeType === 'image/png';
  const isJpeg = mimeType === 'image/jpeg' || mimeType === 'image/jpg';
  if (!isPng && !isJpeg)
    return asset.mediaType === 'image' ? <span>暂支持 PNG、JPG 无损压缩</span> : null;

  const compress = async () => {
    if (pending.current) return;
    const abort = new AbortController();
    const generation = getAuthSessionGeneration();
    pending.current = abort;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      const download = await fetchNodeAssetDownload(asset, abort.signal, 32 * 1024 * 1024);
      const result = await (isPng ? compressPngLosslessly : compressJpegLosslessly)(
        download.blob,
        abort.signal,
      );
      if (abort.signal.aborted || generation !== getAuthSessionGeneration()) return;
      if (!result.improved) {
        setMessage('该文件已较紧凑，无损压缩未减小体积，保留原文件。');
        return;
      }
      downloadProjectExport({
        blob: result.blob,
        filename: `${download.filename.replace(/\.[^.]+$/, '')}-无损压缩.${isPng ? 'png' : /\.jpeg$/i.test(download.filename) ? 'jpeg' : 'jpg'}`,
      });
      setMessage(
        `已下载副本：${formatAssetFileSize(result.originalBytes)} → ${formatAssetFileSize(result.compressedBytes)}，节省 ${((1 - result.compressedBytes / result.originalBytes) * 100).toFixed(1)}%`,
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        setFailed(true);
        setMessage(error instanceof Error ? error.message : '压缩失败，请重试');
      }
    } finally {
      if (pending.current === abort) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div className="artifact-compression">
      <Button
        type="button"
        className="artifact-preview-viewer-download"
        disabled={busy || !asset.contentUrl}
        onClick={() => void compress()}
        title={
          isPng
            ? '保留像素、尺寸和元数据，下载 PNG 副本；不保证一定变小'
            : '精简 JPG 冗余数据，保留画质、尺寸和元数据；不保证一定变小'
        }
      >
        {busy ? '压缩中…' : '无损压缩副本'}
      </Button>
      {busy && (
        <Button
          type="button"
          className="artifact-preview-viewer-download"
          onClick={() => {
            pending.current?.abort();
            pending.current = null;
            setBusy(false);
            setMessage('已取消压缩');
          }}
        >
          取消压缩
        </Button>
      )}
      {message && (
        <span className={failed ? 'is-error' : ''} role={failed ? 'alert' : 'status'}>
          {message}
        </span>
      )}
    </div>
  );
}
