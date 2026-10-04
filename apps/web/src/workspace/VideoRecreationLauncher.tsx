import { useState } from 'react';
import { Clapperboard, Upload, X } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@multimodal-canvas/ui';
import type { AssetFlowNode } from '../canvas-utils';
import { isActiveRunStatus } from './empty-node-rules';
import { VideoRecreationGuide } from './VideoRecreationGuide';
import './VideoRecreationLauncher.css';

/** 底部复刻入口的界面回调；来源版本冻结、错误提示与保存仍由现有创建流程负责。 */
type VideoRecreationLauncherProps = {
  /** 当前画布节点；仅接受已有视频回显且不在运行的来源。 */
  nodes: readonly AssetFlowNode[];
  /** 正在本地上传或提交的节点，不可作为新复刻来源。 */
  busyNodeIds?: ReadonlySet<string>;
  /** 关闭窗口，不更改画布。 */
  onClose: () => void;
  /** 使用选定来源创建草稿，不调用分析或生成。 */
  onCreate: (sourceNodeId: string) => void;
  /** 打开既有画布上传入口；上传完成后由用户重新选择视频。 */
  onRequestUpload: () => void;
};

/**
 * 展示复刻流程并选择真实视频节点；挂载和选择均无网络副作用。
 * @param props 当前节点及画布已有操作。来源删除或进入运行状态后禁止创建，不自动换用其它视频。
 * @returns 可关闭的来源选择窗口；创建失败沿用 App 的错误提示。
 */
export function VideoRecreationLauncher({
  nodes,
  busyNodeIds,
  onClose,
  onCreate,
  onRequestUpload,
}: VideoRecreationLauncherProps) {
  const sources = nodes.filter(
    ({ id, data }) =>
      data.mediaType === 'video' &&
      !busyNodeIds?.has(id) &&
      !isActiveRunStatus(data.runStatus) &&
      ((!data.manualOutput && data.resultAsset?.assetId) || (data.assetId && data.contentUrl)),
  );
  const [sourceId, setSourceId] = useState(
    () => sources.find((node) => node.selected)?.id ?? (sources.length === 1 ? sources[0]!.id : ''),
  );
  const source = sources.find((node) => node.id === sourceId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="video-recreation-launcher">
        <header className="video-recreation-launcher-header">
          <DialogTitle>
            <Clapperboard size={20} aria-hidden="true" />
            短视频复刻 · 使用流程
          </DialogTitle>
          <DialogClose type="button" className="icon-button" aria-label="关闭短视频复刻流程">
            <X size={18} aria-hidden="true" />
          </DialogClose>
        </header>
        <DialogDescription className="video-recreation-launcher-description">
          参考原视频的动作与镜头，更换人物；需要做广告时，再选择要替换的商品。
        </DialogDescription>
        <div className="video-recreation-launcher-body">
          <VideoRecreationGuide />
          <label className="video-recreation-source-picker">
            <span>参考视频节点</span>
            <select
              aria-label="参考视频节点"
              value={source?.id ?? ''}
              disabled={!sources.length}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">{sources.length ? '请选择原视频' : '画布中暂无可用视频'}</option>
              {sources.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
          </label>
          <p className="video-recreation-launcher-hint">
            {sources.length
              ? '将使用所选节点当前回显的完整视频，原节点保持不变。'
              : '请先上传短视频到画布，或等待视频生成完成，再从这里选择。'}
          </p>
        </div>
        <footer className="video-recreation-launcher-actions">
          <Button
            type="button"
            className="button button-secondary"
            onClick={() => {
              onClose();
              onRequestUpload();
            }}
          >
            <Upload size={16} aria-hidden="true" />
            上传原视频
          </Button>
          <Button
            type="button"
            className="button button-primary"
            disabled={!source}
            onClick={() => {
              if (!source) return;
              onCreate(source.id);
              onClose();
            }}
          >
            创建复刻节点
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
