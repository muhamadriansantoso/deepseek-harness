# Agent Note: 待回答等待在连接世代消亡时清除，而非在 resync 时清除

Status: implemented

[English](2026-08-18-web-pending-waits-drop-at-generation-death.md) | 中文

## 问题

Web GUI 的问题输入卡片（以及审批面板）渲染自会话的 pending-wait 映射，该映射由宿主在每个连接世代重新填充：mux 流从流打开起就重放仍待处理的 `question/requested` 与 `approval/requested` 帧（使用其稳定 rpcId）——早于 `onConnected` 就绪握手完成。客户端在错误的时机清除了该映射：`Session.resync()`（由 `onConnected` 驱动）在重放帧已被消费并重新铸造之后才执行 `pending.clear()`，而重放不会再发生。当问题待答期间连接断开——长时间不回答问题的自然结果——composer takeover 卸载、问题文本消失，工具行永远停留在「等待回答」，因为宿主仍持有待处理问题，而客户端已没有任何可回答的载体。无断线场景下的 resync（子智能体地址变更）同样会丢失待处理等待，且没有任何重放可恢复。

## 决策

Pending waits 属于连接世代作用域，因此在世代消亡时清除——而不是在窗口重建时。`Session.handleDisconnected()`（由 manager 现有的断线清扫调用，运行在 'reconnecting' 状态变更时、任何下一代帧到达之前）清空 pending 映射；`Session.resync()` 不再触碰它。重放仍待处理 requested 帧的 mux-open 因此落在空映射上，其重新铸造的等待在握手之后的 `resync()` 中存活。过期引用仍是「被取代而非被结算」：其 `respond()` 仍可到达宿主（rpcId 不变）。manager 列表层的 `pendingInteractions` 状态本就遵循这一生命周期；实例级映射现在与之保持一致。

## 验证

单元测试在两个层面覆盖该生命周期：resync 保留仍待处理的等待（同一快照引用）；`handleDisconnected` 将其清除；重放的 requested 帧以相同 key 重新铸造新等待，其过期引用仍可 respond；握手之后的 resync 保留重新铸造的等待；manager 的断线清扫覆盖常驻会话的 pending 映射。浏览器 e2e 问题 composer 场景保持其 replay 模式流程，并在手机视口下断言每个 footer 动作按钮都位于卡片的裁剪范围内（单问题 fixture 无法展示校验文案——未作答时 Submit 保持禁用）。同一组断言——普通 footer 与校验文案 footer——已在部署后的 GUI 上以真实浏览器验证（375px 视口、真实问答往返），包括真实的断线重连：问题待答期间断开并恢复浏览器连接后，问题被重新铸造且答案完成了该轮。

## 备选方案

**保留 resync 中的清除，并将帧投递延迟到握手之后。** 否决：投递顺序由连接 pump 所有，为交互帧增加就绪屏障会给连接层与会话层引入针对单一帧类型的耦合。

**在 resync 时对 pending 映射做对账而非清除（仅丢弃重放未重新发送的等待）。** 否决：resync 无法在帧流到达之前得知重放内容；断线时清除是唯一无需顺序知识即可确定世代边界的位置。

## 影响

待处理问题现在能在重连后存活：composer takeover 保持（或重新出现）可回答，工具行不会再在无载体的情况下卡在「等待」。断线期间已解决的问题仍会正确消失（其重放帧不会到达）。审批等待遵循相同生命周期。同一变更中的移动端 footer 修复（窄视口下让问题卡片 footer 换行，确保 Submit 按钮不被裁剪出卡片）是纯展示修复，与生命周期无交互。
