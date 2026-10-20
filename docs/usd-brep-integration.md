# USD BRep 原生建模与工程分析集成

本文件描述当前实现与可执行验证，不把 API 可访问性等同于每种复杂工程模型已通过验证。

## 设计边界

完整建模支持指安装版本公开的 `usd_brep` Python API 均可通过脚本调用，并可查询实际函数、类型、方法和枚举文档。该接口覆盖 Python 绑定公开的能力，不声称覆盖未绑定的 C++ 重载、内部调试接口、商业 CAD 的草图/装配约束系统或所有可能输入的鲁棒性。

最终几何输出支持闭合实体、片体、命名多体与体列表；曲线、曲面、裁剪、放样等可作为建模中间操作，最终须构造成 Brep。独立 Curve / Surface 对象不是可保存的工程实体输出协议。

## 运行与能力发现

Windows 项目内运行时：

```powershell
python scripts/setup_native.py --fea
npm run dev
```

安装脚本从官方 CPython NuGet 发行包安装本地 Python 3.12 / 3.13；USD BRep 1.0.0 安装到 `.python312`，TetGen、scikit-fem、NumPy、SciPy 安装到 `.python313`。不更改系统 Python。大 wheel 分段下载并检查 PyPI SHA-256。其他平台可自行安装依赖并用 `VISION_USD_PYTHON` 指定 CAD Python，HTTP 服务运行在具有数值依赖的 Python 中。

`npm run dev` 自动检查并启动默认 8111 本地后端，再提供 4173 前端；已有健康服务则复用，退出时仅清理自己启动的服务。前端端口被占用会直接报错。`npm run backend` 仍可独立运行。`VISION_ENGINEERING_PORT` 可修改托管的本地端口；环境变量或 `.env` 的 `VISION_ENGINEERING_URL` 指向独立管理的后端，此时不自动启动。代理连接失败返回带目标地址与修复提示的 JSON 503，Agent 中止本轮而不连续重试建模。

`GET /health` 实际启动 CAD worker 并导入库，报告真实版本与错误。`GET /cad/capabilities?q=fillet&offset=0` 从安装包发现 API 文档，每页 16 项。分类涵盖 primitives、curves、surfaces、sweeps、booleans、fillets、offset、cutting、stitching、intersect、queries、heal、poly、transforms、io、usd；不暴露包实现内部导入的 os / sys 等作为建模接口。

ATLAS 的 `query_usd_brep` 工具提供同一查询协议，避免通过简短提示词猜测 API。`run_usd_brep` 接受脚本、构建参数和是否载入当前精确几何。完整脚本进入上下文，不再静默截断长脚本。

## 建模协议

兼容旧的单体脚本：

```python
import usd_brep as u
result = u.create_box((0, 0, 0), 100, 20, 10)
```

命名多体和可编辑参数：

```python
length = parameters.setdefault('length', 100)
result = {
    'base': u.create_box((0, 0, 0), length, 20, 10),
    'cap': u.create_cylinder((0, 40, 0), 10, 8),
}
```

`options.parameters` 覆盖标量参数；`tolerance_mm` 是绝对弦高容差，默认 0.05 mm；`angle_deg` 默认 10；体积积分 `relative_accuracy` 默认 1e-5；`heal` 显式选择是否运行内核修复。脚本仍需遵守内核的输入消费、复制和几何合法性规则。

载入已有原生制品后，`parts` 以原始名称提供精确 BRep：

```python
body = parts['base'].copy()
result = {'base': u.boolean_difference(body, u.create_cylinder((30, 10, -1), 3, 12)),
          'cap': parts['cap']}
```

独立零件不会自动布尔合并或当作粘接。重复输出同一句柄需要复制。片体不计算体积，不冒充可网格化实体。

## 制品与拓扑

`vision.cad/3` 返回 `artifactId`、真实内核版本、原生 SHA-256、命名体列表、solid/sheet 分类、精确几何的数值积分指标、面/边编号、面积、边长、包围盒、构建参数与离散设置。

后端 `.cad_artifacts/<sha256>/` 保存：

- `body-N.brep`：原生 SMLib 数据，后续编辑和面查询优先读取它，避免 USD 转换规范化改变输入。
- `model.usda`：多体 USD BRep 交换制品。
- `body-N.stl`、`preview.stl`：每体网格和总预览。
- `source.py`、`request.json`、`manifest.json`：来源与元数据。

构建全部成功才提交 manifest；失败不替换当前工程。下载端点只接受 SHA-256 ID 和受限文件名，不能读取任意本地路径。`archive.zip` 导出制品包；导入包只读取几何，不自动执行其中的 Python。

项目库仅保存原生制品引用、脚本、参数与工况，大预览从后端按需恢复。本地存储失败会显示通知。制品引用依赖当前后端磁盘；跨机器使用应导出 USD/工程包。当前工程包以几何制品为中心，不包含完整应用聊天或当前项目全部工况；保存工况还应同时导出项目 JSON。

面/边 ID 作用域是原生制品，形如 `body-0/face-3`。几何修改后原生面工况必须重新绑定；系统拒绝将旧制品面号用于新几何，不承诺拓扑变化下的永久面命名。

## 多区域静力分析

数值链路为 TetGen → scikit-fem P1 四面体 → SciPy 稀疏求解。避免 Windows SfePy 源码构建依赖。刚度分批组装；总自由度超过 60,000 时采用 Jacobi 预处理 CG，小系统保留直接法。表面合力按实际选中三角面的面积一致分配到节点。

后端限制同时运行一个数值任务，单次求解上限 600 秒，前端工程代理等待上限 900 秒。超时或进程退出会保留 request 目录下的日志和执行记录，并显示具体错误；连接中断不会被当作数值不收敛，Agent 停止自动重复提交。独立解析梁基准改为按需手动运行。按用户要求，最新的分批组装、CG、大网格超时和并发限制改动未运行测试，下文数值记录来自此前版本。

每个工况允许多个有效固定约束和多个有效合力载荷，上限各 64 项。方向按完整向量归一化，不丢失比例。支持：

- 六个包围盒极值面选择器；
- box / sphere 局部空间区域；
- `cad-face` 原生裁剪面选择：网格节点先做包围盒筛选，再调用 CAD worker 的 `Face.closest_point()` 判断是否属于真实面及其裁剪边界。容差应覆盖 STL 离散误差。

后端返回每个区域实际节点数、面片数、载荷面积与施加合力。每个不连通网格分量必须有足够的非共线固定节点，否则拒绝求解。载荷区域与固定节点重叠也会报错，避免载荷被直接约束吸收。多体共同分析前通过原生 `brep_relationship` 检查：相接、干涉、包含或表面间隙不足两倍离散容差的零件被拒绝，防止网格焊接意外生成粘接；需要完全粘接的材料应显式布尔合并。

实体可以按 bodyIds 选择子集。结果显示只对参与分析的曲面投影，不把同一结果涂到未求解零件上。当前所有参与实体使用同一个各向同性材料，不做隐式粘接或接触。

有封闭内部空腔时，脚本须提供 TetGen 空腔种子：

```python
mesh_holes = {'housing': [(10, 10, 10)]}  # 点位于该封闭空腔内部
```

内核 `material_census()` 发现空腔却没有种子时拒绝分析，避免悄悄填满。离散体积与 CAD 体积偏差超过 5% 也会失败。孔隙连通外界的流道/通孔无需封闭空腔种子。该校验不是通用自交或网格有效性证明。

网格尺寸不再受全局对角线 / 140 或 0.5 mm 的隐式钳制；TetGen 仍有 Steiner 点限制。单次网格默认上限为一百万单元，可在启动后端前设置正整数环境变量 `VISION_FEA_MAX_ELEMENTS` 修改。已有后端必须先停止再启动，Vite 复用旧进程不会更新其环境变量。超限时显示实际生成数量和当前上限；此检查在 TetGen 返回后执行，不是生成阶段的内存硬上限，也不会自动延长求解超时。

返回真实自由 DOF 相对残差、收敛状态、支座反力、合力平衡误差、应变能、网格/求解时间、最小缩放 Jacobian 和归一化后的负体积单元数。未提供的其他质量指标仍为 null。两级 h 对比是真实两次求解，不构成应力网格无关性证明。

## 前端与 Agent

模型面板按需提供：原生导入导出、多体拓扑、参数与源码、离散精度、API 查询、参与分析实体、多个约束/载荷和原生面选择。保持最低 14px 辅助字号与折叠式高级设置。

ATLAS 使用 `configure_study` 原子更新工况。后端模型改变后，旧面引用不会悄悄沿用；用户可从当前拓扑重新选择。手工工况与参数操作可撤销。当前无通用草图约束求解器、装配配合或三维交互式面拾取工具；真实面选择通过拓扑列表完成。

## 验证

```powershell
npm test
npm run build
python -m unittest discover -s tests -p "test_*.py"
python scripts/test_native_engineering.py --cad-only
.python313/python.exe scripts/test_native_engineering.py
npm run test:native-ui
```

原生 CAD 测试调用实际 USD BRep 1.0.0：布尔、拉伸、旋转、路径扫掠、实体放样、圆角、倒角、抽壳、偏置、缝合/修复、片体、NURBS 裁剪、多体、原生往返、增量编辑、参数重放与面查询。

原生浏览器测试使用本机 Edge，在独立的 8115 / 4175 端口启动真实后端和前端，验证面选择、多载荷保存、真实有限元结果、多边界标注，以及三个窗口宽度下的最小可见字号和页面溢出。输出截图位于忽略的 `screenshots/`，不使用模拟 CAD/FEA 返回。

`server/examples/twisted_blade_usd.py` 和 `flow_manifold_usd.py` 是可重放工程几何示例，不是默认模型或已认证设计。已运行的真实数值回归包括轴向解析校核（约 0.58% 位移误差）、合力叠加、同一几何的原生面选择等价性、7000 mm³ 封闭空腔体积，以及流道零件的 76,955 单元静力分析（合力平衡误差约 1.93e-12）。这些结果只验证对应输入与版本，不表示所有公开 API 都已逐个验证。

## 明确不支持的工程物理

当前不是完整多物理场 CAE 平台：没有接触/摩擦、螺栓预紧、各向异性复合铺层、壳/梁单元、塑性、疲劳、屈曲、模态、热/流体耦合。不能仅根据几何生成成功就宣称这些分析成立。

## 官方依据

- [NVIDIA USD BRep API](https://nvidia-omniverse.github.io/usd-brep/latest/docs/python.html)
- [usd-brep 1.0.0](https://pypi.org/project/usd-brep/1.0.0/)
- [scikit-fem API](https://scikit-fem.readthedocs.io/en/latest/api.html)
- [CPython Windows NuGet 运行时](https://docs.python.org/3/using/windows.html)
