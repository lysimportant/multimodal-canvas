import { useRef, useState } from 'react';
import { Select, Typography } from 'antd';
import { Film, Upload } from 'lucide-react';
import {
  videoRecreationConfigSchema,
  type Asset,
  type VideoRecreationConfig,
} from '@multimodal-canvas/domain';
import { Button } from '@multimodal-canvas/ui';

/** 空复刻节点的冻结视频来源选择器；选择或上传均不会自动分析。 */
export type VideoRecreationSourcePickerProps = {
  /** 当前项目可访问的资源，仅展示有明确版本的完整视频。 */
  assets?: readonly Asset[];
  /** 本地文件沿用项目上传流程。 */
  onUploadResource?: (file: File) => Promise<Asset>;
  /** 将已确认版本的来源原子保存到复刻节点。 */
  onBind: (config: VideoRecreationConfig) => void | Promise<void>;
};

/**
 * 选择或上传视频后才生成完整复刻配置。
 * @param props 项目资源和保存回调。
 * @returns 不执行分析与生成的来源设置区域。
 */
export function VideoRecreationSourcePicker({
  assets = [],
  onUploadResource,
  onBind,
}: VideoRecreationSourcePickerProps) {
  const [selectedId, setSelectedId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const videos = assets.filter((asset) => asset.mediaType === 'video' && asset.status === 'ready');

  const bind = async (asset: Asset) => {
    if (asset.mediaType !== 'video' || !asset.latestVersion)
      throw new Error('无法确认视频版本，请刷新资源后重试');
    const duration = asset.metadata?.durationSeconds;
    const config = videoRecreationConfigSchema.parse({
      version: 1,
      source: {
        assetId: asset.id,
        assetVersion: asset.latestVersion,
        name: asset.name.slice(0, 160),
        ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0
          ? { durationSeconds: duration }
          : {}),
      },
      bindings: [],
    });
    await onBind(config);
  };

  const submit = async (asset: Asset) => {
    if (working) return;
    setWorking(true);
    setError(undefined);
    try {
      await bind(asset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存参考视频失败');
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="video-recreation-draft-source" aria-label="分析视频">
      <div className="video-recreation-draft-preview" aria-hidden="true">
        <Film size={38} strokeWidth={1.5} />
      </div>
      <label className="node-quick-editor-field">
        <span>参考视频</span>
        <Select
          aria-label="参考视频"
          value={selectedId}
          disabled={working}
          onChange={setSelectedId}
          virtual={false}
          getPopupContainer={(trigger: HTMLElement) =>
            trigger.closest<HTMLElement>('.node-quick-editor-dialog') ?? document.body
          }
          styles={{ popup: { root: { pointerEvents: 'auto' } } }}
          options={[
            { value: '', label: '选择项目视频' },
            ...videos.map((asset) => ({
              value: asset.id,
              disabled: !asset.latestVersion,
              label: `${asset.name}${asset.latestVersion ? ` · v${asset.latestVersion}` : '（版本未知）'}`,
            })),
          ]}
        />
      </label>
      <div className="video-recreation-draft-actions">
        <Button
          type="button"
          className="button button-secondary"
          disabled={
            working || !videos.some((asset) => asset.id === selectedId && asset.latestVersion)
          }
          onClick={() => {
            const selected = videos.find((asset) => asset.id === selectedId);
            if (selected) void submit(selected);
          }}
        >
          使用此视频
        </Button>
        {onUploadResource ? (
          <div className="video-recreation-draft-upload">
            <Button type="button" disabled={working} onClick={() => fileInput.current?.click()}>
              <Upload size={16} aria-hidden="true" />
              上传视频
            </Button>
            <input
              hidden
              ref={fileInput}
              type="file"
              accept="video/*"
              aria-label="上传参考视频"
              disabled={working}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file || working) return;
                setWorking(true);
                setError(undefined);
                try {
                  const uploaded = await onUploadResource(file);
                  await bind(uploaded);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : '上传参考视频失败');
                } finally {
                  setWorking(false);
                }
              }}
            />
          </div>
        ) : null}
      </div>
      {working ? (
        <Typography.Text role="status" type="secondary">
          正在保存参考视频…
        </Typography.Text>
      ) : null}
      {error ? (
        <Typography.Text role="alert" type="danger">
          {error}
        </Typography.Text>
      ) : null}
    </section>
  );
}
