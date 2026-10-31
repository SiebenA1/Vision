# DeepSeek Harness 架构评估与 VISION 改进方案

日期：2026-10-31。状态：方案，尚未实施运行时代码改造。

后续整合版本见 [VISION 综合架构与性能优化设计方案](architecture-optimization-plan.md)，加入内置能力模块、服务所有权、异步请求状态、批量持久化及分批迁移设计。本文保留上游分析和前序验证依据。

## 1. 结论与决策

建议借鉴 Harness 的请求、工具和生命周期边界，渐进改进 VISION 自己的执行核心。暂不把 VISION 迁入 Cordis，也不替换 SQLite 工程版本与原生 CAD/CAE 作业体系。

优先顺序：

1. 补齐可复现性能基线，把模型等待、排队、上下文编译、工具执行分别计时。
2. 消除模型等待对其他任务的队首阻塞，同时建立可取消、可排空的请求生命周期。
3. 统一每步工具准入、参数 schema、执行策略与回执投影，减少规则分散。
4. 在完整工程证据不变的前提下，减少重复提示词、上下文和只读工具往返。
5. 经数据证明后，再做检索增量投影、连接复用和前端增量事件推送。

上述优先级区分两类收益：调度改造改善并发任务的等待与响应；减少模型轮次和输入才可能显著改善单任务完成时间。两者不能混为一个“提速倍数”。

## 2. 分析范围、版本与证据强度

### 2.1 固定分析对象

- 上游：[deepseek-harness 固定提交 ce7073d51254c26cd63b22a60835b8f948deb447](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447)。通过 GitHub recursive tree 获取对象清单，`truncated=false`。
- 下载并核对了 132 个相关源码、说明及测试文件的 Git blob SHA-1，全部与该 tree 一致。目录包括工具注册/执行、Agent loop、系统提示词、压缩、会话投影、DeepSeek 适配和工作流；这是定向架构阅读，不是全仓逐行审计。
- 本项目：HEAD `3477957e47a502e159678c588f2e9bba6d764104` 加本次开始前已有的工作区修改。评估以实际工作区代码为准，不以 HEAD 或旧文档替代当前实现。
- 未安装或执行上游完整运行时、未跑其测试、未调用远程模型；阅读上游测试只确认其设计意图，不能等同测试通过。
- 本次只新增方案、证据和离线验证脚本，没有实施生产改造。

### 2.2 验证结果

| 证据 | 结果 | 可以支持什么 |
|---|---|---|
| VISION 12 个相关测试模块 | 105 项：102 通过、3 跳过、0 失败、0 错误；普通本机环境约 80.124 秒 | 当前相关行为基线通过；不代表拟议实现通过 |
| 真实 `Tasks.loop` 隔离探针 | 第一项由事件控制等待，150 ms 观察窗内第二项不推进；释放后推进 | 现有单线程调度确实存在队首阻塞；不是实测模型网络延迟 |
| schema 本地微基准 | 25 个完整注册 schema 共 29,944 字符；40 次生成 p50 约 18.054 ms | schema 有重复构建成本，但仅缓存 schema 不足以解释秒级提速 |
| 固定基础 SYSTEM | 12,738 字符，尚未包括按阶段追加内容 | 存在可分段评估的固定提示成本；字符数不等于 token 数 |
| 历史延迟记录 | 三项样本见下表 | 帮助提出调查方向，不证明当前版本或改造收益 |

首轮沙箱测试出现 `_ssl`、`_ctypes` DLL 加载错误及关联测试失败；在普通本机环境重跑同一组测试全部通过。以后一轮作为项目基线，同时保留环境差异说明，不据此修改依赖或业务代码。

复现探针：

```powershell
.python313/python.exe scripts/validate_harness_proposal.py
# 附带同一组相关回归；使用隔离测试工作区，无远程模型调用：
.python313/python.exe scripts/validate_harness_proposal.py --tests
```

探针只观测现状，不实现线程池，不模拟改造后的性能。测试摘要与探针输出见 `deepseek-harness-evidence.json`。

## 3. Harness 的核心架构及工程实现

### 3.1 Cordis：组合、依赖与生命周期是一套机制

Harness 把 Agent loop、工具注册、模型适配、会话和界面作为插件，通过共享 context 提供服务与事件。插件注册的是可撤销 effect；卸载时撤销注册并处理拥有的资源。profile 组合有序 bundle，再叠加配置 patch；不同运行形态共享底层能力，不复制 Agent 实现。

价值是明确“谁提供能力、谁消费、谁拥有资源”，而非“插件数量越多越快”。依赖注入、作用域、卸载顺序、热重载和配置层次也引入了复杂度。VISION 当前为固定本地工程应用，更适合先用普通 Python 模块和静态定义表建立同样的边界。

来源：[architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/architecture.md)、[capability-seams.md](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/capability-seams.md)。

### 3.2 Agent loop：先准入，再冻结，再请求，最后结算

一个 turn 包含多个 step；每个 step 执行模型请求及其工具。loop 捕获本步模型选择，组装提示和工具集合，准备适配器调用，记录请求所需事实，冻结模型历史，再开始流式请求。重试保留该步已选能力；工具结果结算后才能驱动下一步。

它把“实时活动”和“持久事实”分开：流式 chunk 是瞬态；完整 assistant message 或失败 attempt 才持久结算。取消不会把未获准的输入误提交；关闭需要等待活动资源清理。

VISION 可迁移的是请求所有权和状态边界；不必同时迁入它的消息协议与所有事件类型。

来源：[agent-loop README](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/README.md)、[agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/agent.ts)。

### 3.3 工具系统：声明、准入、执行、展示互相分离

工具定义包含参数、规范输出、执行函数与并发安全分类。注册表导出模型 schema；执行器接收调用批次。条件工具每个 step 解析一次为 `ResolvedToolSet`，同一集合同时服务提示词和执行。卸载、限制变化等仍会阻止尚未开始的调用，避免旧快照成为永久权限。

共享管线拆为 prepare / dispatch / complete，依次负责准入与校验、执行、结果结算。前后扩展钩子之外还有不可被后续监听器翻转的 guard。规范返回值、模型可见 content 和 UI 元数据分离，防止为了展示或省 token 损坏程序调用结果。

来源：[tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/index.ts)、[pipeline.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/pipeline.ts)、[contracts.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/contracts.ts)。

### 3.4 并发调度：默认独占，显式放行，结果保序

`executionMode()` 仅在 `isConcurrencySafe(args) === true` 时允许并行；缺声明、异常和非布尔真值均按独占处理。`executeToolBatch()` 使用有界滚动池，独占调用形成屏障；并行的是工具 body，策略检查和最终结果按模型顺序推进。取消停止启动新调用、排空已启动调用，为未执行项补取消结果。

这一机制的价值不只是 `Promise.all`，而是并发下仍有确定的调用顺序、结果身份和取消结算。代价是保序可能产生结果结算等待，且“只读”不自动等于线程安全。

来源：[batch.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/batch.ts)、[execution-mode.spec.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/tests/execution-mode.spec.ts)。

### 3.5 Session：日志是事实，投影是视图

模型可见信息要求有日志依据，`deriveMessages()` 从持久事件构建历史；请求头和 context 在必要时记录，支持重建请求。会话投影缓存是日志的派生数据：允许落后、不允许领先；版本或生命周期不匹配时丢弃并重算。持久格式迁移采用受验证的相邻版本链和新代发布。

VISION 已有 SQLite 事务、不可变 revision、turn 回执和压缩请求快照。应补版本化投影和重建检查，不应因此再造第二份 JSONL 工程真相。

来源：[session README](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/session/README.md)、[session-projection-cache README](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/session/session-projection-cache/README.md)。

### 3.6 上下文：静态前缀、动态快照、分层压缩

提示词由有序 `PromptSection` 和动态 `PromptContext` 组装。动态事实以可持久重放的快照进入历史，变化或被压缩后再补入。工具 schema 也来自本步准入集合。

压缩先尝试无模型的工具输出裁剪，再决定是否摘要；原始回执仍保留。压缩要维护工具调用与结果的完整配对，并证明缩小后再恢复请求。它不是无成本操作：摘要额外消耗模型请求和 token，改动历史也可能影响缓存。

需要特别警惕：上游 token meter 的回退估算采用每 4 字符一个 token 的启发式；对中文与 JSON schema 不够可靠。不能把这一数值直接作为 VISION 的预算准入依据。

来源：[system-prompt/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/system-prompt/src/index.ts)、[compaction-basic](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/compaction/compaction-basic/README.md)、[tool-result-pruner](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/compaction/compaction-tool-result-pruner/README.md)、[estimate.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/token-meter/src/estimate.ts)。

### 3.7 PTC 与 workflow：减少模型介入不等于自动持久化

PTC 暴露 `run_code` 和生成 SDK，让一段程序消费多个工具的规范结果，仅把提炼结果送回模型。嵌套工具仍经过共享管线与并发屏障。它可能减少往返，但 SDK 本身有固定提示成本；中间值可能占用大量内存，也不能仅靠会话重放恢复。

上游 workflow 提供子 Agent 编排，但明确没有 journaling/resume。不能把它直接替换 VISION 的持久 CAD/CAE 任务。对本项目，更稳妥的第一步是后端限定的只读批量查询，而不是开放任意 Agent 编排程序。

来源：[tool-executor-ptc](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-ptc/README.md)、[workflow README](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/workflow/workflow/README.md)。

### 3.8 模型适配、流式与观测

上游把模型能力、序列化、流解析和错误分类放在适配层。当前所读 DeepSeek 适配源码使用 Messages 风格结构与原生 replay 元数据；VISION 使用 Chat Completions 和独立请求快照。接口名称相近不意味着协议可以直接替换。

流式改善首个可见反馈时间；只有完整调用通过校验和围栏后才能执行。重试策略必须区分明确失败与结果未知，不能把通用自动重试套到 CAD 写入或已发送模型请求上。遥测可订阅生命周期，但性能数据应避免复制用户脚本、项目正文或凭据。

来源：[serialize.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm-deepseek/src/serialize.ts)、[transport.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm-deepseek/src/transport.ts)。

### 3.9 工程组织与可测试性

仓库采用 pnpm monorepo，区分 Host 与 Client 构建，并分别提供契约、快照、E2E、Web 压力和性能测试入口。当前固定版本根包为 `0.2.2-alpha.2`，要求 Node ≥24.9.0；这与 VISION 的 Node 要求不同，也说明直接接入运行时会扩大部署范围。值得迁移的是测试分层和 schema/目录由定义生成的做法，避免工具说明、执行契约与文档各维护一份。没有执行这些上游检查，不能将其入口存在等同工程质量已经得到本轮验证。

平台 fs/subprocess/sandbox 的服务边界适合未来远程计算适配；VISION 现有原生 worker 是资源与故障隔离，不是不可信代码沙箱。若以后引入外部插件或任意 PTC，必须单独定义执行权限和资源边界，不能因名称相似就复用“沙箱”结论。

来源：[根 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/package.json)、[capability-seams.md](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/capability-seams.md)。

## 4. VISION 现状与实际差距

### 4.1 当前主链

```text
ConversationPanel → /api/v2 → conversation / Tasks
  → model_tasks.next_step
      → task_memory.context → retrieval
      → provider.payload → 压缩请求快照 → provider.complete
      → parse → 本步工具名称检查 → prepare
  → task_tools.execute → Workspace 命令 / Queries / 持久作业
  → jobs.Controller → 受控 Python 原生进程 → 制品与数值结果
  → 回执 / revision / modeling_check → 下一模型请求
```

### 4.2 已有机制，应保留并复用

- `storage.py` / `tasks.py`：revision CAS、幂等命令、epoch 围栏、持久 turn/checkpoint、未知模型请求中断后暂停。
- `model_tasks.py:129`：网络请求前保存压缩后的完整请求、摘要和来源；不是“完全没有请求重放能力”。
- `provider.py:91`：分析/建模阶段裁剪、依赖证据约束、预检后收窄工具、按阶段 reasoning；不是“所有工具每轮全发”。
- `provider.py:270`：已合并最多四个同类 `native_api` 或非点选 `inspect_geometry` 调用；不是“完全不支持批量”。
- `task_memory.py`：历史脚本改为引用、保留关键观察和失败、上下文省略说明、`read_tool_result` 按需展开。
- `queries.py`：按 runtime 缓存 API 文档，实体指标可直接读 artifact；原生查询独立受限通道。
- `retrieval.py`：脏队列更新索引、SQLite 持久向量、检索结果缓存、来源失效过滤；不能再建议从零增加这些机制。
- CAD 回执含建模检查和几何摘要；模块化建模已有代码模块、assembly 引用与增量复用。
- `jobs.py` / `processes.py`：原生进程隔离、内存限制、超时取消、原子制品发布、迟到结果不覆盖新 head。

### 4.3 已确认的改进空间

| 现状证据 | 工程影响 | 判断 |
|---|---|---|
| `Tasks.loop` 顺序调用 `step`，后者同步调用 `provider.complete` | 一项模型等待阻塞其他任务推进，包括已完成作业的回执结算 | 已由隔离探针复现，P1 |
| `complete()` 内 `asyncio.run`；每次 `_send` 新建 AsyncClient | 请求没有共享生命周期；连接难复用 | 代码确认；实际连接耗时待测 |
| 外部取消信号未传入 `complete`；关闭只 join 25 秒，模型总超时为 180 秒 | 状态围栏能防止迟到写入，但未立即中止网络等待；存在关闭排空时间不匹配的路径 | 代码确认；未制造真实挂起网络来测时 |
| 工具模型映射、schema 描述、provider 阶段筛选、prepare 和 execute 分散 | 新工具容易漏配策略；批量支持继续扩展时会增加分支 | 维护性差距，不宣称已出现所有越权问题 |
| 25 schema 每次生成后再筛选；SYSTEM 含多类长规则 | 有本地重复工作和上下文冗余候选 | 生成耗时已测；模型收益待 A/B |
| `context()` 读取项目全部 sources；`retrieve()` 缓存命中前仍读取和散列来源集合 | 项目历史增长后，缓存命中不等于恒定成本 | 代码确认复杂度；真实大工程 p95 待测 |
| 前端约每秒轮询对话与工作区状态 | 有反复传输与显示延迟 | 次优先；SSE 不会降低模型生成时间 |

历史样本来自 `docs/modeling-latency-audit.json`：

| 历史任务前缀 | 已记录模型累计秒 | CAD 排队与执行累计秒 |
|---|---:|---:|
| c2a9df50 | 959.155 | 29.428 |
| c638e484 | 967.778 | 11.604 |
| cb0de12b | 32.231 | 0.845 |

只统计已记录字段，遗漏不是零；这些区间不是互斥的完整总耗时分解，不能计算为精确时间占比。它们支持优先测量模型往返，不能证明当前代码还同样慢。

## 5. 拟议目标架构与实施内容

### P0：先建立基线与请求分解

复用 turn、job、context snapshot ID，增加结构化计时与计数：`context_ms`、`retrieval_ms`、`schema_ms`、`model_queue_ms`、`model_elapsed_ms`、`tool_ms`、`job_queue_ms`、`worker_ms`、请求/工具数量、协议拒绝、无效重复查询、缓存命中、取消至排空时间。

token 使用优先保留 provider 实际 usage；缓存命中/未命中 token、reasoning token 只有接口返回且校验成功才记录，缺失为 null。不要以字符数替代 token，也不要把费用、TTFT 和完整任务时间混为一个指标。

验收：同一个请求可从 user/task/epoch/turn 追到完整工具回执；计时使用 monotonic clock；指标不落项目明文。计时必须覆盖错误与取消路径。

### P1：异步模型通道 + 有界准入 + 同项目串行

保留任务协调器负责状态推进和 SQLite 提交；把模型等待移到有生命周期的异步 I/O 通道。提交请求后协调器即可推进其他任务，完成后由协调器消费结果。每个 task 最多一个在途请求，同一 project 的任务变更保留串行语义；不同项目可并发。

首版上限建议从 2 个模型请求起测，并作为实验参数，不沿用上游默认 10。保持现有原生作业单通道和查询单槽，先不增加 CAD/FEA 并行度。队列采用公平准入，防止长任务独占。

每个请求持有 `(task_id, epoch, request_id, base_revision, context_digest)` 与取消句柄。取消、纠正、来源遗忘、项目删除和服务关闭都通知同一请求所有者；完成响应先核对所有围栏，再准入工具。无法终止供应商计费不意味着允许本地执行迟到结果。

AsyncClient 只在所属事件循环创建、复用和关闭，不能把一个异步 client 任意跨线程共享。关闭先停止准入、取消在途、排空响应结算、关闭 client，再释放控制器所有权。取消后保留已知 usage 与请求身份，未知结果明确标记。

验收：慢模型 A 期间其他项目的本地任务/作业结算能推进；同任务不出现重复请求；取消/纠正后零迟到写入；重启不自动重发未知结果；关闭不遗留请求或 worker。该阶段主要改善并发等待，不能据此承诺单任务快一倍。

### P2：把本步工具准入变成单一执行契约

在现有 `TOOL_MODELS` 基础上增加一个静态工具定义表，收敛 `schema`、handler、适用阶段、只读/写入、资源通道、批量合并规则、预算和模型回执投影。首版不引入插件安装、热重载或通用事件总线。

每步计算一次不可变 `ToolAdmission`，记录工具/schema 版本和摘要。模型发送、返回校验和执行使用同一准入结果；执行前再检查 project head、epoch、来源有效性及动态撤销条件。隐藏工具不能仅靠提示词禁止。

注意双层 schema：模型输入遵守本步投影 schema；服务器注入命令身份、展开保存的 preview 后，再使用完整命令 schema 验证。`build_geometry({})` 是已保存预检的执行引用，不能因强行统一 schema 而破坏这一契约。

对不确定的并发安全默认独占。`configure_study`、需求登记、remember、模块注册、构建、求解、ask_user、finish 都不能当作普通只读工具并行。`preview_build` 本身不执行几何，但其回执影响下一步，首版仍独占。

验收：未准入工具、额外字段、失效 preview、重复 call_id 均无法执行；同一准入输入产生稳定 schema；缓存 schema 的调用方获得独立副本，不能污染其他阶段。先迁移少量工具做契约对照，再迁移全部。

### P3：减少上下文重复，同时保持证据可追溯

将 SYSTEM 拆为稳定公共规则与建模、分析、模块编排等阶段规则；按阶段选择，先用快照测试确认不会丢失单位、BRep 消耗语义、来源权威与结论门槛。

规范工具结果完整保存；模型只读取版本化投影。投影保留 outcome、revision/artifact、source、失败、关键数值与展开引用。历史脚本、拓扑和重复摘要继续引用化；最新用户约束、原始需求、当前失败、物理输入来源不得按普通旧历史裁掉。当前已经引用化的内容不再二次“优化”。

完整保存不等于把无限大结果写入 SQLite 或上下文：普通回执沿用现有上限，大结果以有大小限制、摘要校验和来源关系的文件引用保存，并随遗忘/导出策略处理；引用同样不可绕过来源有效性检查。

构建后已有 modeling_check 不再额外重复请求；solve 后的 assessment 若完全确定且无新决策，可考虑由后端自动生成并保留独立回执，再交模型解释。`preview → build` 的自动合并暂缓：必须保持用户可中断、预检摘要一致及版本检查。

固定 schema 的稳定排序和不可变前缀可能改善供应商缓存，但真实收益依赖实际序列化及接口能力。先优化现有独立请求；不立即改成全量 assistant/tool 历史。后者涉及 reasoning/replay 和上下文失效，需单独契约验证。

先采用确定性投影与预算；只在长历史测试证明必要时引入模型摘要，保留源引用、成组工具记录和无法摘要时的回退。不可让摘要把 unknown/manual 改为 verified。

### P4：受限只读批量，而不是直接开放任意 PTC

从现有同类合并扩展为最多 4 项的只读批次；首版可只支持已知 schema 的文档、拓扑、脚本范围和回执读取。每项绑定同一版本快照，单独有 call_id、参数校验、结果和状态；总输出有硬上限，截断必须给展开入口。

必须区分“批量减少模型往返”和“并行减少工具运行时间”。同一原生查询通道仍串行/合并；`search_sources` 会维护派生索引，不能仅因其业务只读就宣称实现线程安全。可合并实体测量沿用现有路径；跨资源调用只有证明安全才并行。

混合读写批次首版整体拒绝且零执行；纯读批次准入通过后，各项运行失败保留各自结果，不重复已成功项。依赖前一调用输出才能生成参数的调用必须跨阶段串行，不能把猜测参数塞进批次。

若以后需要写入屏障，采用上游的“独占默认、显式安全、结果保序、取消补结果”语义，并单独设计持久子调用表及崩溃恢复。不能只把 parse 改成接受数组就上线。

### P5：按测量结果做增量投影和 UI 优化

检索/上下文：为项目来源增加事务内递增 generation，删除、supersede、forget 也要递增；派生快照记录 generation、revision、epoch、runtime 和模型版本。缓存命中前不再全量序列化来源正文。来源删除与任务围栏仍实时检查；旧缓存永不恢复被遗忘内容。

首版可用内存缓存且失配重建；仅当冷启动确实慢再持久 checkpoint。若持久化，遵守“权威事务先提交、缓存只能落后”的规则；版本不匹配丢弃重算。不要为读取速度放松工程事实与来源失效检查。

UI：先减少终态轮询、使用游标增量与自适应间隔，再按需要引入 SSE。流式文本只改善反馈；完整参数校验前不得启动 CAD。SSE 断线后依靠持久游标恢复，瞬态 token 不当作工程证据。

原生 worker：只有测得进程启动/反序列化占比显著后，才比较隔离进程池。当前 BRep 句柄可能被消耗，崩溃与内存泄漏必须隔离；不把常驻内核作为默认重构目标。

## 6. 不采纳或暂缓的方向

| 方向 | 评估 |
|---|---|
| 整体迁移 Cordis / TypeScript Agent 核心 | 会引入双运行时、迁移协议与恢复语义；尚无证据证明优于改进现有 Python 核心 |
| 用上游 Session JSONL 替换工程 SQLite | 工程 CAS、来源删除和制品提交已经依赖事务；双份真相增大一致性负担 |
| 直接复制上游模型适配与默认大预算 | API 协议、能力声明、输出上限与成本假设不同，不能照搬 |
| 一律每轮摘要或全面 RAG 重构 | 摘要有调用成本；本项目已有多层记忆、检索缓存与脏队列 |
| 任意 `run_code` 控制工程写入 | 需要额外执行世界、资源限制、子调用日志与恢复设计；受限批量先验证收益 |
| 多 Agent 分摊同一工程写入 | 会放大 head 冲突、来源与版本治理成本；目前无收益证据 |
| 网络超时、未知响应自动重发 | 无法证明第一次未受理，可能增加费用；本地写入必须幂等、未知状态继续暂停 |
| 为减少轮数取消核验或改 unknown 为 pass | 损坏 CAD/CAE 正确性，不能接受 |

上游为 MIT，但若后续复制代码，应保留许可证和对应版权信息，并检查所复制依赖的许可；本方案主要迁移设计边界。

## 7. 验证矩阵、实验设计与发布门槛

### 7.1 必须保持的正确性

1. **并发与状态**：同项目两任务、不同项目慢/快任务、重复完成回调、纠正时响应已返回但未提交、关闭时仍在请求。
2. **工具契约**：schema 投影不漂移；未准入/无效/重复调用零执行；只读批次顺序和身份完整；混合写入拒绝；取消补回执。
3. **工程一致性**：预检输入摘要一致、head CAS、epoch、拓扑失效、迟到结果不采纳、制品原子发布、数值证据绑定原 revision。
4. **上下文完整性**：短回复仍承接原需求；用户纠正与授权保留；失败能恢复；manual/unknown 不升级；摘要/缓存不恢复遗忘来源。
5. **恢复**：未知模型结果不自动重发；checkpoint 只能落后；中断子调用不自动重放写入；导入工程仍暂停活动计划。

相关现有入口包括 `test_tasks_v2`、`test_model_tasks_v2`、`test_context_efficiency_v2`、`test_provider_response_v2`、`test_post_build_verification_v2`、`test_context_memory_v2`、`test_retrieval_focus_v2`。原生生命周期、真实求解与 UI 回归在实施阶段按触及范围补跑；本轮未重做完整原生验收。

### 7.2 性能实验

- 固定 12 类代表性任务：首次建模、参数修改、复杂模块装配、消耗性布尔失败恢复、预检后输入变化、几何定向复核、已有工况分析、缺物理输入、长历史、来源遗忘、跨项目慢/快任务、取消关闭。
- 第一层：保存相同状态与响应的离线回放，比较确定性上下文、schema 大小、工具轮次与调用结果。它不能证明真实模型延迟或成功率。
- 第二层：真实 CAD/CAE 固定输入比较制品、几何/数值容差和资源开销，所有结果绑定输入与 runtime。
- 第三层：需要远程模型时单独开展 A/B；同模型版本、预算、温度策略、初始状态，A/B 交错、冷暖缓存分层。建议每类至少 5 对起测，报告分布和失败，样本不足只作探索，不声称显著改善。
- 大历史本地编译测量使用 100 / 1,000 / 10,000 条来源并区分命中、失效和删除；稳定热路径至少 100 次记录，p95 与冷启动分别报告。

### 7.3 拟议门槛（验收目标，不是本轮实测收益）

| 项目 | 门槛 |
|---|---|
| 正确性 | 上述围栏/删除/取消/证据契约回归零退化；相同固定输入的数值验证满足现有容差 |
| 调度 | 注入长模型等待时，其他项目就绪本地任务的推进等待 p95 < 500 ms；同项目顺序保持 |
| 取消关闭 | 模拟可控网络下取消至本地排空 p95 < 1 s；真实网络单独报告；不宣称取消供应商计费 |
| 上下文 | 适用样本的实际输入 token 或请求字节减少目标 20%；关键事实完整性全部通过；两项指标分开报告 |
| 批量 | 适用场景至少省一次模型往返；工具失败可诊断且无额外写入；非适用场景不强行批量 |
| 整体 | 实测成功率不下降，完整任务延迟改善；初期样本不足时不得宣称统计等价 |

达不到门槛则保留正确性改善、关闭未获益优化；不把缓存命中率、代码行数或首 token 时间替代完整任务收益。

## 8. 分批落地与回滚

| 批次 | 范围 | 前置条件 | 回滚方式 |
|---|---|---|---|
| A | 指标、固定回放、阶段 schema/上下文基线 | 无运行时行为改动 | 关闭指标采集；保留验证工具 |
| B | 模型异步通道、取消、关闭排空、有限连接复用 | A + 状态竞态测试 | 停止准入并排空后切回串行；不重放未知请求 |
| C | 工具静态契约表、同一步准入、缓存 schema 副本 | A；可独立推进 | 保留旧分发路径作对照，完成等价验证后删除 |
| D | 阶段提示、回执投影、受限只读批量 | C + 上下文金样；并发执行还依赖 B | 新任务切回旧策略；在途任务按既定版本结算 |
| E | generation 投影缓存、增量 UI | A 证明收益，前述契约稳定 | 丢弃派生缓存并重建；UI 恢复轮询 |

每批保存策略版本、请求摘要和实测对照。需要数据库迁移时沿用现有备份与 bundle 兼容测试，不为了回滚运行时策略去回退已提交工程 revision。

建议首先落地 A、B：它们针对已验证的调度问题且不改变 CAD/CAE 数学与几何契约。C、D 再以端到端收益决定推进；E 由大历史与 UI 传输数据触发。当前不估算固定提速倍数或承诺未经基准验证的收益。
