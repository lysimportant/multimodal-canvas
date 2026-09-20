# New API 广场代码来源

`types.ts`、`lib/` 来自本地 `D:/newapi/web/src/features/pricing`，对应 `lysimportant/forknewapi` 提交 `8b6534ba9`，保留 QuantumNous 版权和 AGPL-3.0 许可（见 LICENSE）。

复制原表达式解析、阶梯提取、任务规格矩阵、插件价格与摘要算法；不使用 eval，不在前端执行实际扣费。`dynamic-price.ts` 的货币导入接入本目录适配器，USD 原价及 New API 的汇率由 Canvas 页面显示。基础常量只保留算法使用项。

后续更新先核对这些文件与来源差异，保留明确零价、请求附加倍率、阶梯顺序和未知表达式回退。Canvas 管理授权、服务端写回与钱包不属于这份复制代码。
