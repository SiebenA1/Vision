# 分层工程记忆与本地混合检索

实现日期：2026-10-24。权威数据仍是 SQLite 中的工程版本、用户来源与原始工具回执；记忆和向量均不产生数值认证。

## 一、上下文分区

当前需求及工程文档固定保留，无法容纳时明确报错。实际模型入口将业务上下文与准备进度限制在 24,000 字符内。扣除固定内容后，建模阶段按近期工具证据 30%、长期记忆 15%、阶段摘要 6%、历史召回 10%、近期用户消息 14%、API 文档 16%、API 签名 9% 分配；分析阶段分别为 40%、20%、5%、13%、17%、3%、2%。闲余额度可借给延后候选，近期工具组最多 8 项。超过容量的条目留在存储中，并通过 metadata.layers 报告省略数量。

工具、记忆、召回和对话已拆成通用贡献模块，统一经过来源准入、内容级复用和预算装配。相同来源/版本作用域内的重复正文使用同请求 content_ref 引用，来源身份、角色和确认状态仍保留；装配结束会检查引用完整性。当前用户输入不再重复作为历史消息发送。具体契约和真实建模验证入口见 [上下文贡献与内容复用](context-contributions.md)。

这是单次上下文容量，不是累计任务预算。累计请求、token、运行时间和原生作业仍不设置预算限制。UTF-8 字节数仅作为保守文本 token 上界报告，不能当成 DeepSeek 的准确分词结果；单次输出和进程超时沿用现有协议。

## 二、有来源的长期与阶段记忆

`remember` 工具及 `POST /api/v2/projects/{project}/memory` 记录 requirement、decision、open_question、stage 四类摘要。每项必须有本工程内可用 source_ids，记录创建时的 revision_id、作者和作用范围。geometry 范围绑定当时的几何；几何改变后，不再作为有效约束进入上下文。摘要只表示来源陈述，不能代替求解回执。

修改使用 supersedes 显式替代旧记忆；并发修改旧记录会冲突，不静默覆盖。原始用户消息仍可追溯，模型按最新用户要求处理。任意自然语言纠正并没有确定性语义解析器：智能体须通过 remember 明确替代，用户也可以在“工程记忆与上下文”窗口纠正。

ask_user 和 finish 成功时自动保存摘录式阶段摘要，链接原始步骤与所有依赖来源。它们不是再次调用模型生成的额外摘要，也不把助手总结升级为工程事实。长期需求提取由智能体 remember 工具完成，并非每条消息额外调用一次模型。

来源遗忘递归处理 derived_from 谱系；使用过来源的任务会停止、回执被清除。索引中的片段和持久向量在同一 SQLite 事务中删除，并清理 Qdrant 派生缓存。已提交工程版本及已导出的备份沿用现有保留规则。工程包包含记忆来源与摘要，不包含可重建索引；导入时检查记忆谱系，重新建立索引。

## 三、本地模型与增量索引

- 嵌入：`BAAI/bge-small-zh-v1.5`，512 维，MIT；面向以中文为主的工程对话。
- 重排：`BAAI/bge-reranker-v2-m3-int8`，FastEmbed 提供的 BGE 多语言 INT8 ONNX 版本，Apache-2.0。
- 推理：FastEmbed / ONNX Runtime，默认 CPU、每个模型两线程，不执行模型仓库的 Python 代码。
- 向量数据库：本进程 Qdrant local；向量持久化在 SQLite 的 retrieval_vectors 中，Qdrant 索引可以重建，无需启动外部服务。

安装：

```powershell
.python313/python.exe -m pip install -r backend/requirements-memory.txt
.python313/python.exe scripts/setup_memory.py
```

模型缓存位于仓库 `.memory-models/`，不进入 Git 或工程包。只有 setup 脚本下载公共权重；工程请求路径使用 local_files_only，不会向模型网站发送工程文本。编译后的工程上下文仍按既有授权交给 DeepSeek。准备标记和真实模型状态可从 `/api/v2/memory/status` 查看；未安装或推理失败会报告降级原因并使用关键词检索，不伪装为语义召回。

SQLite 触发器为 sources 插入、修改、删除登记 dirty queue，修改/删除立即使旧片段失效。查询仅增量处理变化项；片段 320 字符、重叠 48 字符，身份包含工程、来源、偏移和内容哈希。持久向量按嵌入模型身份分开存储。首次处理已有工程或大量导入记录时，仍需首次分块和推理时间。

## 四、召回、重排与检查

检索用最新需求和显式对象 ID 构造查询，先限制工程和有效几何，再并行使用 FTS/BM25 与稠密向量的结果进行 RRF 融合，并补充对象/数值字串精确匹配。最多对 24 个融合片段进行 cross-encoder 重排，按来源去重后展开少量相邻原文。当前代码依次执行本地关键词与向量计算，未另建并发工作池。

最终结果再次核对来源是否被删除、修改或替代。返回原始来源、偏移、版本、几何有效性与评分；每次上下文审计包括检索模式、降级原因、候选数、耗时、各层占用和来源依赖。数值字串匹配仅辅助召回，100N 与 1000N 的实际生效值始终以当前工程结构化工况为准，语义相似度不能证明数值正确。

界面：持续对话标题下打开“工程记忆与上下文”，可查看模型状态、整理需求、纠正/忘记记录、打开来源，或按需检查本次编译上下文。不因打开窗口调用 DeepSeek。

验证：

```powershell
.python313/python.exe -m unittest discover -s tests -p 'test_context_memory_v2.py'
.python313/python.exe scripts/validate_memory.py
# 可选：两轮真实 DeepSeek 请求，仅发送临时合成工程的测试消息，需要已配置密钥。
.python313/python.exe scripts/validate_memory.py --live-conversation
```

第二条只使用临时工程和合成语料，实际运行开源嵌入与重排，输出 `screenshots/memory-retrieval-evaluation.json`。这是一组可重复的小型回归，不代表复杂工程语料上的完整质量评测。

本机实际评测的6个目标来源全部排第一，Recall@3=1.0；两轮真实 DeepSeek 回放分别使用 remember → finish，共4次请求，成功将5mm要求显式替代为8mm。记录为 `screenshots/memory-live-replay.json`。现有用户工程仅用于浏览器只读上下文检查，确认 hybrid_reranked，无外部传输或模型修改。

已知边界：未实现专门的几何语义映射、单位语义归一化、跨工程记忆共享或大规模分布式向量服务。原始对话读取仍为完整历史，尚未分页。旧对话没有自动追溯生成全部长期需求；可从既有来源通过工具或界面整理。

模型和依赖依据：[BGE small 模型卡](https://huggingface.co/BAAI/bge-small-zh-v1.5)、[BGE reranker 模型卡](https://huggingface.co/BAAI/bge-reranker-v2-m3)、[FastEmbed 重排实现](https://github.com/qdrant/fastembed/blob/main/fastembed/rerank/cross_encoder/onnx_text_cross_encoder.py)、[Qdrant 混合检索](https://qdrant.tech/documentation/search/hybrid-queries/)。
