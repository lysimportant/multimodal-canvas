import './VideoRecreationGuide.css';

/**
 * 展示整条短视频复刻的四步说明，供来源弹窗与节点面板复用。
 * @returns 无需参数的只读流程；不发起请求、不修改配置或节点尺寸。
 */
export function VideoRecreationGuide() {
  return (
    <div className="video-recreation-guide">
      <h4>使用流程</h4>
      <ol aria-label="短视频复刻使用流程">
        <li>
          <strong>准备原视频</strong>
          <p>选择或上传短视频，创建复刻节点后保留原视频。整条分析，无需选片段。</p>
        </li>
        <li>
          <strong>分析整条视频</strong>
          <p>
            先选择视频识别模型，再点击「分析整条视频」，提取人物、广告商品、出现时间与镜头动作。
          </p>
        </li>
        <li>
          <strong>选择保留或替换</strong>
          <p>
            查看原视频对象卡，逐个人物、商品选择保留，或上传及选择替换图片；商品用途与卖点由你确认。
          </p>
        </li>
        <li>
          <strong>检查并生成</strong>
          <p>
            独立选择视频生成模型，检查系统整理的提示词后点击「生成」。动作与镜头仅作参考，效果取决于模型。
          </p>
        </li>
      </ol>
      <p className="video-recreation-guide-notice">
        分析和生成均需你点击按钮才提交模型任务，不会自动付费。换素材无需重新分析。
      </p>
    </div>
  );
}
