# Seedance、Wan3、H3 提示词模板与 Skill 接入约定

整理日期：2026-10-23。依据用户提供的桌面 `prompt` 文件夹中的 `seedance.md`、`Wan3.md`、`H3.md`。这里只整理模板，不安装 Skill，也不改变视频提交接口、模式、时长、比例、素材角色或轮询流程。

原始来源：[Seedance 中文官方指南](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh)、[Wan3 中文官方指南](https://help.aliyun.com/zh/model-studio/wan3-video-generation-prompt-guide)、[MiniMaxAI H3 全参考重写指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)。[H3 中文博客](https://minimax3.com/zh/blog/minimax-h3-prompt-guide) 为第三方整理；H3 的六部分结构以本地 `H3.md` 为依据。

## 一页对照

| 项目         | Seedance 2.5                                   | Wan 3.0                                                | H3 全参考重写                                              |
| ------------ | ---------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| 默认正文语言 | 中文                                           | 中文                                                   | 六个部分用英文，台词、歌词及画面文字保留原语言             |
| 素材编号     | 图 1、视频 1、音频 1                           | 图1、视频1、音频1                                      | `<Picture 1>`、`<Video 1>`、`<Audio 1>`                    |
| 主体绑定     | 逐项说明人物、场景、动作、音色来自哪份素材     | 引用编号并写清只参考什么、保留什么                     | `<Subject N>` 定义可复用内容，来源可以是一份或多份素材     |
| 正文结构     | 素材指代 → 一句话概述 → 镜头/时间轴 → 全局细节 | 总体 → 引用 → 分镜 → 台词 → 音效/BGM → 风格 → 必要负向 | 固定六部分，详见下文                                       |
| 分镜         | 时间戳或“镜头 N”均可                           | 连续起止时间；2–5 秒/镜头是建议，不是提交限制          | 首镜 `[Shot 1]` 无时间戳，后续切镜 `[Shot N] At MM:SS.mmm` |
| 重点         | 素材分工明确，精准参考不必重复复述             | 只写需要控制的部分，避免矛盾或无意义负向堆砌           | 区分素材、主体、说话者与声音引用关系                       |

这些是提示词写作格式，不是新的 API 字段。H3 六部分只用于明确选择的全参考重写任务，不套用到全部 H3 模式。

## 通用素材绑定

为后续 Skill 提供结构化素材清单，至少包含：引用 ID、资产 ID、冻结版本、媒体类型、用户明确命名、用户指定用途，以及当前实际发送顺序。素材内容未提供给 Skill 时，只能依据用户文字和已确认说明，不得声称看到了图片、听到了声音。

- 图片、视频、音频各自从 1 计数，以实际提交顺序为准。资源条的混合顺序号不等于模型类型编号。
- 同资产、同版本、同角色的重复引用复用编号；不要按出现次数生成新的素材。
- 同名文件不能合并，不同版本不能替换为最新版本。
- 别名用于显式绑定，不能仅凭文件名推断人物身份、衣服颜色、动作或音色。
- 当前提交层只将明确设置的名称附在引用旁，例如 `图1（小明）`；不自动生成素材说明、Subject 定义或整篇重写。完整用途绑定由用户或后续 Skill 明确表达。
- 一份素材可提供多个主体，一个主体可由多份素材共同定义。不要默认“一图一人”。
- 普通视频包含声音，不代表需要增加独立音频引用；只有明确独立输入或启用的音轨才能绑定音频。
- 只替换结构化引用，不全局替换用户文字中的“图1”、`Image1`、文件名、`<Subject 1>` 或台词。

## Seedance 2.5

来源：`seedance.md` 的“基础写作”“参考类（多素材映射）”“编辑类”。

```text
素材绑定：
图 1 是【用户指定的人物/物体】，用于【外观/服装/道具】参考。
图 2 用于【场景/构图/光影】参考，仅参考【明确部分】。
视频 1 用于【动作/运镜/节奏】参考。
音频 1 用于【指定角色的音色/音乐/节奏】参考。

整体概述：
【主体】在【地点】完成【事件】，采用【题材/画风】，整体情绪为【情绪】。

镜头 1（0–T1 秒）：
【景别与机位】；【主体在画面中的位置】；【可执行动作及状态变化】；
【镜头运动】；【台词/同步音效，确有需要时填写】。

镜头 2（T1–T2 秒）：
【衔接方式】；【后续动作】；【适用的素材引用】；【镜头与声音变化】。

全局要求：
【跨镜头保持的外观、场景、光线与声音要求】。
【仅在用户要求时填写：不要字幕／不要 BGM 等】。
```

可删去不存在的素材和不需要控制的部分。参考视频足够准确时，可写“严格参考视频 1 的动作与运镜，顺序与视频保持一致”，不要再编造一份可能相冲突的动作清单。

编辑模板：`编辑视频 1，在【时间段/区域】把【A】改为【B】，保留【其他主体、动作、背景或声音】。`

延长模板：`从视频 1 的【结尾/开头】继续【事件】，衔接【已有画面状态、动作、光线与声音】，新增【目标内容】。`

模板里的时间与方向必须来自用户或已确认上下文；提示词模板不替用户修改请求中的 duration、ratio、output_format。

## Wan 3.0

来源：`Wan3.md` 的“提示词要素写作”“参考素材引用”“分镜与时间戳”“台词”“音效/BGM”。

```text
【总体描述：主题、主体、地点、叙事视角、画风和情绪】。

参考绑定：
【角色 A】形象参考图1；【场景】参考图2；动作参考视频1；
【角色 A】音色参考音频1，仅参考音色，不复用原台词。

分镜1（00:00–00:03）：
【主体＋场景＋动作＋构图＋运镜＋光线】。
【角色 A】说：“【原语言台词】”。【有需要时：口型同步】。

分镜2（00:03–00:06）：
【衔接方式和动作变化】，保持【角色、服装、场景的一致性】。

声音：【明确需要的环境音、动作音、BGM 及变化】。
风格/情绪：【补充且不与总体描述冲突的约束】。
负向：【用户确实不希望出现的内容；无要求则省略】。
```

上例的 6 秒仅为模板演示，应按已确认总时长调整，不改接口参数。镜头首尾相接，不跳段、不重叠；单镜头需求直接写“一镜到底”，不为了格式强行拆镜。

常用绑定句：

- 外观：`图1的儿童站在图2的现代公寓玄关内。`
- 动作：`参考视频1的滑板动作和轨迹，人物外观使用图1。`
- 局部参考：`只参考图2的色调，其他内容不参考。`
- 多人对白：逐句注明角色；音色绑定写一次后保持一致。
- 静音控制：用户要求无台词时写“无台词”；要求无音乐时写“无 BGM，只生成环境音和动作音”，两者不等同。

## H3 全参考重写

来源：`H3.md` 的 Full-Reference Mode Rewrite Output Format Guide。此文件比中文博客更具体：要求六个部分为英文，保留台词、歌词和场景可见文字的原语言。以下中文说明是模板注释，真正重写时按要求输出英文。

四类编号有不同语义：

- `<Subject N>`：人物、物体、环境、服装、风格或动作等可复用内容，不是上传文件序号。
- `<Picture N>`：作为首帧、关键帧、尾帧、构图或故事板锚点的图片；若只提供外观，在 Subject 定义中引用它，不机械增加独立 Picture 定义。
- `<Video N>`：编辑源、延长源、运镜/剪辑/时序结构来源；从视频借用的人物或动作仍可属于 Subject。
- `<Audio N>`：复制或参考的音频信号。与视频分别计数，不暗示同号配对。

```text
subject_definitions:
<Subject 1> is the person identified by the user in <Picture 1>; preserve the user-specified appearance.
<Video 1> provides the camera movement and shot rhythm for the target video.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1).

summary:
[reference generation + audio reference] The target video follows <Subject 1> through the user-specified scene, referencing the camera movement of <Video 1> and the voice timbre of <Audio 1>.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - Preserve the defined appearance; the target action follows the user's request.
<Video 1> (camera movement and shot rhythm): weak_reference - Follow only the selected movement and rhythm, not its characters or background.
<Audio 1>: reference - Reference the voice timbre without copying its dialogue or original signal.

detailed_description:
The target video uses the user's specified visual style and lighting.
[Shot 1] Describe the visible composition, subject position, environment, action, state change, camera movement and current sound. <Subject 1> (S1) says, <d>[Chinese]这里保留用户提供的中文台词。</d>
[Shot 2] At 00:03.000, describe the next shot, continuity, action and active reference relationships.

overall_soundscape:
Describe only the intended ambience and physical sounds, with their reference relationship when relevant.

non_diegetic_music:
Describe the intended audience-only background music and its progression, or explicitly state its absence when requested.
```

上例是结构骨架，不是可直接用于任意素材的完成稿。实际 Skill 必须依据用户材料重写，不可默认存在人物、视频、音频、对白或两个镜头。`fully_preserved` 等关系标记也须按用户明确的参考用途选择。

视觉关系可选：`fully_preserved`、`partially_preserved`、`attribute_transfer`、`weak_reference`。音频关系可选：`fully_copy`、`partially_copy`、`reference`、`weak_reference`。仅借音色不等于复制整段声音；复制全部最终音轨才是 `fully_copy`。

说话者 `(S1)`、`(S2)` 按实际发声顺序全局分配，不按 Subject 编号分配。台词放在 `<d>[语言] 原台词</d>`；跨镜头、视频结束截断等特殊情况按原文使用 `<scenetrans>`、`<cutoff>`。不要在 retention_analysis 中写说话者 ID。

`detailed_description` 对生成任务通常建议 350–500 个英文词，但对白时间完整性优先，编辑任务按复杂度调整；不能把这个建议当作提交硬限制。正文应详细描述画面和声音，而不只是引用清单或剧情梗概。

## 后续 Skill 的输入输出约定

建议输入：目标引擎、用户原文、任务类型、已确认时长/画幅、结构化素材清单、用户明确的参考用途、原语言台词、必须保持的内容，以及素材是否实际可读。缺少的创作信息可给出建议，不能把猜测写成已知事实。

建议输出分开保存：

1. 可供用户预览的提示词草稿。
2. 素材用途与引用 ID 的绑定说明。
3. 尚待用户确认的歧义，不夹入最终生成正文。

接入当前优化器时，必须保留其原有资源占位符、顺序、数量及冻结身份。Skill 不自行将占位符改为“图1”或重新编号；提交层在最终媒体顺序确定后替换。为表达重复指代或额外 Subject 定义需要新增引用时，先扩展并验证结构化引用合同，不能绕过现有校验硬拼字符串。

使用上述模板手写纯文本时，则由用户保证编号与素材一致。普通文本中的编号不会随资源条重排自动更新。

## 本轮不做的提交变更

不安装文档内推荐的外部 Skill，不执行下载页面中的命令；不把 H3 六部分翻译或生成过程插入提交路径；不修改现有视频路由、参数、模式限制、媒体字段、上传顺序、计费或轮询。

源文档提到的模型容量、编辑模式参数和首尾帧组合限制可供以后独立评估，不作为本轮绑定替换的隐式功能。
