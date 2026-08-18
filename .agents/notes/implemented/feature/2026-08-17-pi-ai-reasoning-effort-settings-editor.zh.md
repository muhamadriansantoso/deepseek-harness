# Agent Note: 模型页的按模型推理档位编辑器

Status: implemented

[English](2026-08-17-pi-ai-reasoning-effort-settings-editor.md) | 中文

## 问题

后端声明词汇（[[2026-08-08-pi-ai-per-model-reasoning-declarations]]）给 `settings.yaml` 带来了按模型的 `reasoningEfforts`，但模型页——手工声明的 pi-ai 路由编辑模型列表的唯一界面——只暴露 `id`/`name`/`contextWindow`/`maxTokens`。按模型对齐档位仍然意味着手写 `settings.yaml`，于是自定义（pi-ai）提供方除非由运维手工填写，否则永远不会携带推理元数据。用户看到的症状——「reasoning effort 不显示在自定义提供方上」——来自输入框的档位面板：它只在解析出的模型元数据携带 `reasoning` 时渲染，而手工声明的路由只能通过一个没有任何界面能产出的声明拿到这份元数据；用户的预期是内置提供方的行为——选完模型后无需任何配置，档位下拉框就出现。

## 决策

两项改动合起来，让输入框的档位选择器为自定义提供方端到端可用：

- **手工声明的模型默认具备推理能力。** 在 `llm-pi-ai` 的 `resolveModelReasoning` 中，没有已安装 catalog 条目、也没有 `reasoningEfforts` 声明的模型，现在物化为 `reasoning: true` 而非 `false`，于是 pi-ai 提供其标准基础档位组——`off` 加上 `minimal`/`low`/`medium`/`high`——`resolveModelInfo` 通过与 catalog 元数据相同的 seam 报告这些档位。`xhigh`/`max` 按 pi-ai 的不对称默认规则在声明前不提供；catalog 支撑的模型则与以前完全一致地保留其已安装条目的能力（`reasoningEfforts` 仍然服务于方言或档位集合不同的网关）。自定义模型一经选中，输入框就显示带标准档位的档位面板，与内置提供方一致。
- **模型页编辑按模型的声明。** 每条 pi-ai 模型行在其高级折叠区内获得一个按模型的推理档位编辑器：一个三态选择框（未配置 / 非推理模型 / 自定义档位），自定义档位会把全部七个档位渲染为复选框加取值输入框——勾选某个档位会把该档位 id 种入其取值输入框，Off 的取值留空表示「请求不发送推理参数」，取消勾选会删除该键。校验与适配器的 catalog 规则逐条一致：空字典被拒绝、只有 Off 的声明被拒绝、Off 之外的每个档位都需要非空取值字符串、未知档位名被拒绝。编辑器走自己的 `patchEfforts` 路径，而不是行通用的 `patch`，因为通用 patch 会丢弃 `''`/`undefined`，而字典可能合法地持有 `null` 与瞬时的 `''`。

提供方的增删改管理门禁——`fetch('/api/auth/me')` 角色探测与 `store.ts` 中的 `canMutate` 标志——原样不动；推理档位的选择对所有用户开放，因为输入框本就向所有用户提供档位。按模型的标签是 推理档位（`reasoningEfforts`），与输入框路由级的 推理强度 区分开——提供方卡片刻意不携带后者（现有 e2e 仍断言 `getByLabel('推理强度')` 数量为 0）。

## 备选方案

- **在提供方卡片上放一个路由级档位控件。** 已否决：档位是按模型的能力，单个值会弄坏不接受它的模型——这与模型页停写路由级旋钮（#1860）是同一个原因。
- **为 `reasoningEfforts` 提供自由格式的 YAML/JSON 文本框。** 已否决：卡片的精选折叠设计用 schema 通用的字段覆盖面换来了设计稿上的布局；结构化的复选框让校验与其余字段共用同一个按行检查器，也让协议拼写保持可编辑。
- **在输入框侧做兜底、在没有适配器元数据时发明档位。** 已否决：适配器拥有其推理能力；在 pi-ai seam 处做默认能让分派、校验与元数据保持一致，而纯前端兜底可能提供适配器在请求时会拒绝的档位。

## 后果

- 手工声明的 pi-ai 路由，其模型现在默认公开带标准基础档位组的 `reasoning`：声明 → pi-ai `resolveModelReasoning` → `LlmResolvedModelInfo.reasoning` → 输入框档位面板，输入框无需任何改动。`xhigh`/`max` 与改名后的协议拼写仍需要声明，`reasoningEfforts: false` 仍会从 catalog 模型上剥除推理。
- `llm.models` RPC（输入框所读取的）现在为每条手工声明的模型携带 `reasoning`，而不只是已声明的那些——wire 路径是 `api-proxy.ts` 中逐模型的 `resolveModelInfo`。
- 两个组件 spec 现在在模块作用域 stub 角色探测 `fetch('/api/auth/me') → { role: 'admin' }`（既有 `vi.stubGlobal` 模式），修复了一个基线回归：受角色门禁的分节在 jsdom 中渲染为只读——75 个测试失败，自角色门禁提交起就存在，且已通过在干净树上 stash 基线验证。门禁本身不变。
- models-settings e2e 新增一个场景，通过组装后的浏览器声明按模型的推理档位并钉住一个新的 golden；既有 golden 不变，因为收起的界面未被触碰。
- README 双语对（llm-pi-ai 与 ui-settings-models）用标准默认的描述替换了原先「手工声明模型不推理」的段落；已知限制条目现在把 `reasoningEfforts` 列入精选折叠字段。

前驱：[[2026-08-08-pi-ai-per-model-reasoning-declarations]]（后端词汇；本 note 推翻了其中手工声明模型 `reasoning: false` 的默认，但声明面本身仍然成立）。本 note 补充设置页编辑器与标准默认。
