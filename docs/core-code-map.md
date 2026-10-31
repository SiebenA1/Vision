# 当前核心代码与清理边界

## 应用入口

`index.html` → `src/main.tsx` → `src/features/workspace/CoreWorkspace.tsx`。
主入口只有持久化工程工作区，旧的 workspace 查询参数和原型 URL 仍会归一到此入口。

| 模块 | 当前职责 |
|---|---|
| `src/features/workspace/api.ts` | 工作区 `/api/v2` 请求与数据契约 |
| `CoreWorkspace.tsx`、`ProjectManager.tsx`、`ProjectImport.tsx` | 工程生命周期、版本、导入和页面编排 |
| `CoreViewport.tsx`、`fields.ts`、`viewHelpers.ts` | Three.js 视口、原生拓扑选择、计算场显示 |
| `StudyForm.tsx`、`VerificationPanel.tsx`、`ComparisonPanel.tsx` | 工况编辑、数值校核与比较 |
| `ConversationPanel.tsx`、`MemoryPanel.tsx` | 对话任务与工程上下文 |
| `drafts.ts` | 浏览器草稿恢复 |
| `backend/vision/api.py` | 持久化工程 HTTP 接口 |
| `storage.py`、`changes.py`、`project_management.py`、`bundles.py` | SQLite、不可变版本、工程管理与归档 |
| `jobs.py`、`processes.py`、`native.py` | 作业调度、进程生命周期与原生计算适配 |
| `conversation.py`、`tasks.py`、`model_tasks.py`、`task_tools.py` | 对话和任务执行 |
| `model_io.py`、`tool_admission.py` | 有界异步模型请求、取消排空、每步不可变工具准入 |
| `prompts.py`、`read_batch.py` | 阶段提示贡献和逐项持久化的有界只读批次 |
| `engineering_memory.py`、`task_memory.py`、`retrieval.py` | 工程记忆和检索 |
| `studies.py`、`assessment.py`、`verification.py`、`benchmarks.py` | 工况、评估与求解校核 |

## 本次删除

沿入口以及 TypeScript 测试、脚本的静态导入链检查后，删除不再可达的
`src/App.tsx`、`src/components/` 下的旧界面组件及辅助场景文件、
`src/features/analysis/AnalysisWorkspace.tsx`，共 18 个文件。
旧版页面不再作为当前产品的实现参考。

## 仍需保留的代码

- `server/`：新版 `native.py`、`query_worker.py`、`runtime.py`、
  `benchmarks.py` 仍调用原生 CAD worker、FEA 求解器和契约；
  `retrieval.py` 还复用 `server.agent_memory.search_tokens`。
- `src/core/` 中的类型、材料、STL 和场投影等模块仍被新版工作区直接使用。
- 旧版前端状态、Agent、服务及仅覆盖旧界面的脚本和测试已退役；
  导入旧工程仍由 `ProjectImport.tsx` 和后端显式迁移接口负责。
- 全局 CSS 仍含共享基础控件和层叠规则，本次保持不变。
- 当前浏览器验收使用 `scripts/core-ui-test.mjs`，覆盖当前工程管理、
  脚本对话框与 CAE 页面；任务状态机由 Python 回归覆盖。

## 检查入口

架构优化各批次的实际变更与定向检查见 [实施进度](optimization-progress.md)。生产模型请求由独立 I/O 服务等待，协调器继续推进其他项目；手动离线单步入口共用请求准备与结算逻辑。

前端运行 `npm test`、`npm run build`；持久化工程后端运行
`.python313/python.exe -m unittest discover -s tests -p "test_*v2.py"`。
真实 CAD/FEA 回归需要项目本地 Python 3.12/3.13 及其原生依赖。
