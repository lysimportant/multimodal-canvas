# 输入节点资源选择与名称删除

更新时间：2026-09-23。P1 局部前端交互任务。

## 基线与边界

- 起点 `codex/generate-to-new-node @ ef775ab`，上游 `origin/codex/generate-to-new-node`。
- Node `v24.12.0`、pnpm `11.19.0`，沿用已有项目依赖和锁文件。
- 用户已有 `docs/resource-input-compatibility.md` 修改，本次不覆盖、不提交。
- 定向基线：`pnpm --filter @multimodal-canvas/web test -- src/ResourceMentionEditor.test.tsx src/TextPromptEditor.test.tsx src/workspace/NodeQuickEditor.test.tsx`，3 文件、141 项通过。
- 不改服务端、资源数据格式、资源库文件、节点尺寸或画布显式连线；不调用收费供应商。

## 验收与进度

- [x] 选择器脱离编辑器文档流、贴近 @，视口边缘自动避让。
- [x] 独立搜索框、左侧竖排类型筛选、右侧滚动结果；兼容键盘及中文输入。
- [x] 正文资源名可删除；同资源其它名称保留，最后一处删除时清除提及和缩略条；支持撤销。
- [x] 单测、PC 浏览器交互和截图检查；lint/typecheck/test/build 与最终 diff 检查。
- [x] 同步验证结果，检查最终差异和敏感信息；交付目标为当前分支上游，实际提交与远程核验以 Git 记录为准。

## 恢复点

资源选择器通过 portal 与原生 popover 保持在光标旁，左侧竖排类型、右侧独立滚动；在模态编辑器中保留焦点范围。Escape 先关闭选择器，不关闭放大编辑器。名称删除按完整引用处理，不遗留半个名称；最后一处删除时从结构化文档和缩略条移除，同资源其它引用以及显式连线不受影响。

- 资源编辑器专项 37 项通过；加上文本入口、节点编辑器共 154 项通过。
- 最终 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过。Web 953 项通过；其它包沿用通过结果，其中部分依赖基础设施或外部条件的既有测试仍跳过，不算真实集成验收。日志 `.data/resource-picker-{lint,typecheck,test,build}-final.log`。
- `pnpm --filter @multimodal-canvas/web exec playwright test resource-mention-picker.spec.ts` 两项通过：1440×900 节点及 1024×768 Dialog，覆盖定位、防溢出、独立搜索、类型筛选、滚动、删除、撤销、Enter/Escape、节点尺寸不变和 console 错误。仅使用浏览器 Mock API。日志 `.data/resource-picker-e2e-final.log`。
- 截图已检查：`test-results/resource-mention-picker-all-resources.png`、`test-results/resource-mention-picker-dialog.png`。
- 额外既有 `smoke.spec.ts` 结果 35 通过、25 失败，均停在模型选项、登录及设置入口等旧预期。隔离基线 `ef775ab` 先通过画布启动预检，再精确复跑这 25 项，全部以相同等待目标和堆栈失败，无新增差异。基线为缩短等待使用 10 秒超时/2 workers，主运行使用 30 秒/1 worker；不是宣称全量 smoke 通过。对照证据 `.data/resource-picker-smoke-baseline-comparison.txt`，运行日志 `.data/resource-picker-smoke.log`、`.data/resource-picker-smoke-baseline-matched25.log`。首次隔离环境缺少 domain 构建产物的失败另存 `.data/resource-picker-smoke-baseline-env-failure.log`，不计入有效基线。
- 本地前端：`http://127.0.0.1:5173/`，启动命令 `pnpm --filter @multimodal-canvas/web dev --host 127.0.0.1 --port 5173`；仅确认 Vite HTTP 200，真实后端/供应商不在本轮验收内。
- 保留既有 Vite 大体积 chunk 提示，打包优化不在本任务范围。

无需数据迁移。回滚仅回退本任务前端提交，现有结构化提示词保持兼容。

## 后续独立事项

- [ ] P2：更新旧 `smoke.spec.ts` 的模型、登录与设置夹具及断言，然后恢复全量浏览器基线。本轮不修改与资源引用无关的生产行为或放宽既有测试。
