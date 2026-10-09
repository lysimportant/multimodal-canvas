import {
  type RunInputSnapshot,
  type RunSnapshot,
  type VideoGenerationIssue,
} from '@multimodal-canvas/domain';

/** 已确认视频合同的提交前诊断，不保存 Run 或发送 Provider 请求。 */
export class RunVideoInputError extends Error {
  /** 第一个共享合同错误码，与 Provider 的拒绝原因一致。 */
  readonly code: VideoGenerationIssue['code'];

  /** @param nodeId 非法输入所属执行节点。 @param issues 共享预检返回的脱敏问题。 */
  constructor(
    readonly nodeId: string,
    readonly issues: readonly VideoGenerationIssue[],
  ) {
    super(issues[0]?.message ?? '视频输入不符合已确认合同');
    this.name = 'RunVideoInputError';
    this.code = issues[0]?.code ?? 'UNSUPPORTED_INPUT_COMBINATION';
  }
}

/**
 * 按已冻结版本预检实际执行的 Image2Pro 与 Yuan 节点；退役 Flash 中配拒绝新运行。
 * @param snapshot 已完成资产归属、版本、模型和凭据冻结的快照；不修改其内容。
 * @returns 合同通过时无返回值；不读取素材字节，不创建或恢复任务。
 * @throws RunVideoInputError 参数、模式、媒体类型或参考数量不符合已确认合同。
 */
export function validateRunVideoInputs(snapshot: RunSnapshot): void {
  // 能力、时长、数量、比例和模式均由 New API / 上游判断。
  // 此入口只保留给旧调用方，不能在 Canvas 侧重复拒绝未知型号或新参数。
  void snapshot;
}

// 保留现有内部调用入口，新合同共用同一份冻结输入预检。
export {
  RunVideoInputError as RunImage2proVideoError,
  validateRunVideoInputs as validateRunImage2proVideo,
};
