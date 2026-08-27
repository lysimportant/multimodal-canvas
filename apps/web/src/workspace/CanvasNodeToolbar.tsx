import { Sparkles, Wand2 } from 'lucide-react';

import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import { mediaLabels } from './contracts';

export function CanvasNodeToolbar({
  onAddGenerateNode,
  onAddTransformNode,
}: {
  onAddGenerateNode: (mediaType: MediaType) => void;
  onAddTransformNode: (mediaType: MediaType) => void;
}) {
  return (
    <div className="canvas-node-tools" aria-label="添加节点">
      {mediaTypes.map((mediaType) => (
        <div className="canvas-node-tool-group" key={mediaType}>
          <button
            type="button"
            className={`canvas-node-tool media-icon-${mediaType}`}
            aria-label={`新建${mediaLabels[mediaType]}生成节点`}
            title={`新建${mediaLabels[mediaType]}生成节点`}
            onClick={() => onAddGenerateNode(mediaType)}
          >
            <Sparkles size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`canvas-node-tool canvas-node-tool-transform media-icon-${mediaType}`}
            aria-label={`新建${mediaLabels[mediaType]}转换节点`}
            title={`新建${mediaLabels[mediaType]}转换节点`}
            onClick={() => onAddTransformNode(mediaType)}
          >
            <Wand2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
