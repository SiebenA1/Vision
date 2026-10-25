# 建模代码通道实施与验收

实施日期：2026-10-25。对应 modeling-code-channel-design.md。所有新增验收使用隔离临时工程，不更改用户工程、不重发历史建模任务，不调用远程LLM。

## 已落地

| 阶段 | 实现 | 验收 |
| --- | --- | --- |
| 代码制品 | 项目级模块目录，module_id + 不可变code_revision，参数类型/单位/边界，标签，来源和需求映射 | HTTP注册/检索/片段读取、项目隔离、语法校验、来源撤回、命令幂等 |
| 精确修改 | 有基础版本的唯一文本补丁；新版本不覆盖旧版；装配参数差异按当前artifact合并 | 歧义/版本/类型/单位错误拒绝；历史源码保留；两轮Agent迭代不回传整段源码 |
| 增量构建 | 后端生成驱动脚本，顺序依赖DAG，参数引用，独立零件局部BRep、位姿和局部STL | 改盒高只重建盒身；盒盖BRep/STL复用；只改位姿复用全部几何；精度变化只重生成网格 |
| 失效与恢复 | 代码/参数/几何依赖/运行时进入缓存键；失败保留成功模型；排队后来源失效不采纳；导入缓存不当作本机运行证据 | 真实CAD执行、模块错误定位、依赖传播、bundle往返、旧仿真body绑定拒绝 |

目录使用现有数据库sources来源账本，源码使用不可变artifacts，不新增并行存储事实源。检索先按项目、来源有效性、运行时兼容性、标签和参数过滤，再文本排序；可选已有本地重排器。检索结果含接口与验证级别，不含源码。当前实现没有独立模块向量索引。

简单单件继续使用原快速脚本路径。多零件计划、已有模块目录或模块制品启用模块工具。已采用模块的工程在Agent建模工具中使用模块引用/装配差异，不自动退回整段驱动脚本。默认只注入少量模块接口和当前装配引用，其他片段按需读取；来源失效时同步退出上下文。恢复阶段仍允许读取和修补失败模块，重复无效查询继续受原次数限制。

## 工具与HTTP契约

工具：register_code_module、search_code_modules、read_code_module、patch_code_module、read_code_assembly，以及build_geometry/preview_build的module_assembly。

对应POST接口前缀为 `/api/v2/projects/{project}`：

- `/code-modules`：注册代码和参数契约；source_ids为有效项目来源，可附bindings（requirement_id、source_id、feature）。
- `/code-modules/search`：query、tags、parameter_names、limit（至多8）、semantic。
- `/code-modules/read`：module_id、code_revision、offset、limit（至多6000字符）。
- `/code-modules/patch`：精确基础版本、script_edits、source_ids及工程命令围栏。
- `/code-assembly/read`：读取当前装配的某个零件或有界切片。

模块为普通Python，获得u、parameters（params别名）、parts；必须返回一个局部坐标Brep到result。parts仅含depends_on声明的几何独立副本，避免布尔运算消耗其他零件句柄。默认长度mm；参数引用必须单位一致，未实现隐式单位换算。rotation_deg按局部XYZ依次旋转，再translation；这只是刚体摆放，未实现机械装配约束求解。

建模引用示例（哈希由注册回执取得）：

```json
{
  "module_assembly": [
    {"component_id":"body","module_id":"box_body","code_revision":"<body revision>","parameters":{"height":40}},
    {"component_id":"lid","module_id":"lid","code_revision":"<lid revision>",
     "translation":[0,0,{"component_id":"body","parameter":"height","offset":30}]}
  ]
}
```

后续修改只需向preview_build提交：

```json
{
  "base_assembly_artifact":"<current geometry artifact>",
  "assembly_edits":[{"component_id":"body","parameters":{"height":50}}]
}
```

然后build_geometry提交 `{}` 执行精确已保存输入。其他参数与盒盖高度绑定保留，不需读回源码或重写装配。requirement_id是模块映射标识，不能代替实际检查证据；来源、检查和制品版本仍由原验收链路校验。

## 验收证据

最终结果：建模回归88/88通过；工程/任务/上下文集成90项中80通过、10项按环境或显式opt-in条件跳过；前端TypeScript检查通过。后端已在无活动任务/作业时重启，8112直连与5173代理健康检查均200，五个模块HTTP接口均出现在实际OpenAPI中。未复跑用户付费模型任务。

运行 `.python313/python.exe scripts/audit_modeling_flow.py` 执行建模流程回归，日志见code-channel-regression.log。模块专项测试见tests/test_code_modules_v2.py，含真实CAD和模拟模型响应；模拟调用数用于验证编排，不能当作真实模型速度或遵循率测评。

运行 `.python313/python.exe scripts/validate_code_channel.py` 重做独立真实CAD验收并生成code-channel-acceptance.json，包含逐场景耗时、重建/复用零件和尺寸。耗时包括本地预览、队列与独立worker开销，不含远程LLM、网络或浏览器渲染，单次测量不构成性能基准。

两轮编排测试：已注册模块首次建模为3次模拟模型请求（登记要求、构建、结束）；参数修改为4次（更新要求、预览差异、构建保存输入、结束），均只有1次CAD作业，无原生API文档查询，输入上下文不重复传输源码。首次创建新模块仍需要生成和注册源码，未宣称零成本。

## 当前边界

缓存只复用当前成功制品及其本机作业证据中的零件，不是跨工程或全历史缓存。顺序依赖要求先声明前置节点，循环/前向引用拒绝，未实现并行CAD调度。

仿真继续走结构化Study、材料/载荷/网格与现有求解器；当前几何变化后，显式body/face和语义对象绑定必须按原规则重绑定。本轮未新增仿真模板注册表、求解结果缓存或完整网格增量更新，未运行新增模块的完整有限元求解验收。

运行成功、bbox/体积和缓存命中只证明对应执行与数值检查；螺纹牙型、装配配合、壁厚和结构安全仍需针对性特征检查或求解。首次复杂模块生成速度、真实模型多轮遵循率和用户可见端到端延迟仍待实际交互测试。
