# 上下文贡献与内容复用

实际请求入口 `model_tasks.prepare_request` 调用 `task_memory.context`。后者固定装入当前工程、任务焦点、用户指令、最新观察和失败证据，再把可选内容交给统一装配器；不是重新发送完整聊天历史。模型入口的业务 JSON 总预算为 24,000 字符，包括准备进度和最近参数拒绝信息。字符预算不等于供应商 token。

`context_contributions.py` 定义 `Contributor(name, collect)`、`Contribution(section, value, source_ids)` 和 `Omission(section, count, reason)`。四个内置贡献模块分别收集工具/API 证据、工程记忆、召回来源和历史用户消息。新增模块返回候选数据，无须自行实现预算或去重。可通过 `context(..., contributors=...)` 注入固定贡献集合；当前生产入口采用内置集合，没有引入 Cordis 或动态插件加载。

`context_assembly.py` 统一检查来源是否可用、按现有阶段分配层预算，再允许未用额度借给延后候选；保留近期工具组数量限制。只将已准入的内容登记为引用目标，避免预算淘汰造成悬空引用。完成后按稳定身份排序并展开所有引用校验，超过总预算或引用不可解析就停止发送。

`context_content.py` 使用请求内的来源、turn、版本、几何 artifact 和 API runtime/version/symbol 作为复用作用域。相同来源的重复正文、完全相同的结构化证据、可精确还原的文本片段可以改为 `content_ref`。引用以 section、稳定身份、path 和必要的 slice 定位；较晚准入的完整原文可成为先前摘录的正文所有者。短内容仅在净节省为正时替换。

引用周围的来源身份、角色、确认状态、时间轮次、版本与错误状态仍独立保留。不同来源说了相同的话、不同版本产生相同数值、已确认记忆与原始用户陈述，不会因此成为同一个事实。这里没有进行语义相似度合并。持久化来源和原始工具回执不变，完整内容仍可由既有读取工具取得。

系统提示解释引用读取规则；模型不需要额外工具调用即可读取同一请求中的所有者。元数据记录各贡献的候选/准入/不可用数量、各层预算占用，以及复用引用数和净节省字符数。`resolve_content` 为离线审计提供确定性展开；生产发送的是带引用的紧凑 JSON。

定向回归覆盖来源隔离、跨版本不合并、失败状态、批次子回执、完整原文与首尾摘录、预算不足时的引用完整性、已遗忘来源及自定义贡献。真实验证入口：

```powershell
.python313/python.exe scripts/validate_context_modeling.py --live
```

该命令会使用已配置的 DeepSeek，产生真实 token 用量，在新建的 `.vision-workspace/context-validation-*` 工程中执行建板、开孔和参数重放。原生独立校验体积、包围盒、单实体和孔边界，并核对参数重放没有重写脚本。每步冻结状态用 `212f288` 的旧编译器离线配对，保持相同提示和工具集合，只比较业务上下文差异；旧版未额外调用远程模型，字符/字节差异不能当作真实 token 的 A/B 结果。结构化证据保存到 `context-modeling-validation.json`。
