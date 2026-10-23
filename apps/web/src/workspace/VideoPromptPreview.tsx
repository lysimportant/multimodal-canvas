import { useMemo, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import type { NodeResourceRef, PromptDocument } from '@multimodal-canvas/domain';
import type { ConnectedPromptAsset } from './connected-prompt-assets';
import type { VideoPromptReferenceContext } from './video-prompt-reference-labels';
import { previewVideoPrompt } from './video-prompt-preview';
import './video-prompt-preview.css';

/** 视频输入框中的只读提交正文预览，始终读取当前本地草稿。 */
export function VideoPromptPreview({
  document,
  context,
  connectedAssets,
  resourceRefs,
  projectionError,
}: {
  document: PromptDocument;
  context: VideoPromptReferenceContext;
  connectedAssets?: readonly ConnectedPromptAsset[];
  resourceRefs?: readonly NodeResourceRef[];
  projectionError?: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => {
    if (!open) return {};
    try {
      if (projectionError) throw new Error(projectionError);
      return { text: previewVideoPrompt(document, context, connectedAssets, resourceRefs) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : '提示词转换失败，请检查引用资源。' };
    }
  }, [open, document, context, connectedAssets, resourceRefs, projectionError]);
  return (
    <>
      <Button
        type="button"
        className="video-prompt-preview-trigger"
        onClick={() => setOpen(true)}
        aria-label="查看真实提示词"
        title="查看真实提示词"
      >
        <Eye size={14} aria-hidden="true" />
        <span>查看真实提示词</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="video-prompt-preview-dialog nodrag nopan nowheel"
          aria-describedby={undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="video-prompt-preview-header">
            <DialogTitle>真实提示词</DialogTitle>
            <DialogClose asChild>
              <Button type="button" aria-label="关闭真实提示词">
                <X size={16} aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>
          <p className="video-prompt-preview-description">
            按当前模型和资源顺序，将输入框中的 @引用转换为提交正文。
          </p>
          {preview.error ? (
            <p role="alert">{preview.error}</p>
          ) : preview.text ? (
            <pre className="video-prompt-preview-text" tabIndex={0} aria-label="真实提示词正文">
              {preview.text}
            </pre>
          ) : (
            <p role="status">输入框中暂无提示词。</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
