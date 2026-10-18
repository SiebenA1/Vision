import type { AnalysisResult, ModelDocument, ValidationResult } from '../types';
import { getMaterial } from '../materials';

export function buildReportMarkdown(
  model: ModelDocument,
  result: AnalysisResult,
  validation: ValidationResult | null,
): string {
  const material = getMaterial(model.materialId);
  const pass = result.safetyFactor >= 2.0 && result.maxDisplacement <= 2.0;
  const fmt = (value: number, digits = 3) => value.toFixed(digits);
  const rows = model.variables
    .map((variable) => `| ${variable.label} | ${variable.labelEn} | ${variable.value} | ${variable.unit} | ${variable.group} |`)
    .join('\n');
  const warnings = result.warnings.length ? result.warnings.map((warning) => `- ${warning}`).join('\n') : '- 无自动警告。';
  const validationText = validation
    ? `| ${validation.caseId} | ${validation.name} | ${fmt(validation.reference, 5)} | ${fmt(validation.computed, 5)} | ${fmt(validation.errorPercent, 2)}% | ${validation.passed ? 'PASS' : 'FAIL'} |`
    : '| — | 尚未运行 | — | — | — | — |';

  return `# VISION 工程校核报告

**项目**  ${model.name} / ${model.code}  
**版本**  ${model.revision}  
**报告编号**  VIS-${model.code}-${result.id.slice(-6).toUpperCase()}  
**生成时间**  ${new Date(result.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  
**分析人**  ${model.meta.analyst}  
**单位制**  ${model.units}（长度 mm · 力 N · 应力 MPa · 质量 kg）

---

## 1. 结论摘要

| 指标 | 结果 | 判据 | 状态 |
|---|---:|---:|---|
| 最大 von Mises 应力 | ${fmt(result.maxVonMises, 1)} MPa | 屈服 ${material.yieldStrength} MPa | ${result.safetyFactor >= 1 ? 'PASS' : 'FAIL'} |
| 安全系数 SF | ${fmt(result.safetyFactor, 2)} | ≥ 2.00 | ${result.safetyFactor >= 2.0 ? 'PASS' : 'REVIEW'} |
| 最大位移 | ${fmt(result.maxDisplacement, 3)} mm | ≤ 2.000 mm | ${result.maxDisplacement <= 2.0 ? 'PASS' : 'REVIEW'} |
| 结构质量 | ${fmt(result.massKg, 4)} kg | 设计目标 | — |
| 反力平衡误差 | ${result.equilibrium.relativeError.toExponential(2)} | ≤ 1e-4 | ${result.equilibrium.relativeError <= 1e-4 ? 'PASS' : 'REVIEW'} |

**总体判定：${pass ? '满足当前设计目标' : '需要设计迭代或工程复核'}**

> 本报告为线弹性、小变形、各向同性静力分析。结果用于概念与详细设计阶段的趋势判断，不替代材料认证、疲劳寿命、屈曲、冲击、连接件滑移/预紧或试验验证。

---

## 2. 设计意图与工况

- 设计意图：${model.meta.designIntent}
- 客户 / 专业：${model.meta.client} · ${model.meta.discipline}
- 材料：${material.name}（${material.standard}）
- 材料参数：E = ${material.E} MPa，ν = ${material.nu}，ρ = ${material.rho} kg/m³，σy = ${material.yieldStrength} MPa
- 载荷工况：${result.loadCase}；加载面 ${model.loads[0]?.face ?? '—'}；方向 [${model.loads[0]?.vector.join(', ')}]；合力 ${model.loads[0]?.magnitude ?? 0} N
- 约束：${model.supports.map((support) => `${support.name}（${support.face}，6 DOF fixed）`).join('；')}

---

## 3. 几何与参数

- 几何内核：build123d / OCCT B-Rep（脚本可重放）
- 网格：${result.mesh.elements.toLocaleString('en-US')} 个 ${result.solver.method === 'SfePy' ? 'C3D4 四面体' : 'C3D8 六面体'}单元 / ${result.mesh.nodes.toLocaleString('en-US')} 节点
- 模型指纹：\`${result.modelHash}\`（参数 + 几何版本）
- 网格指纹：\`${result.id}\`

| 中文名 | English | 数值 | 单位 | 分组 |
|---|---|---:|---|---|
${rows}

---

## 4. 有限元模型

- 单元类型：${result.solver.method === 'SfePy' ? '4 节点线性四面体（C3D4），SfePy P1' : '8 节点三线性六面体（C3D8 / Hex8），2×2×2 Gauss 全积分'}
- 网格策略：${result.solver.method === 'SfePy' ? 'Gmsh 3D tetrahedral mesh from OCCT STEP' : '结构化体素网格'}
- 网格尺寸：h = ${fmt(result.mesh.cellSize, 3)} mm
- 自由度：${result.mesh.dofs.toLocaleString('en-US')} DOF
- 材料本构：各向同性线弹性
- 求解器：${result.solver.method === 'SfePy' ? 'Gmsh + SfePy 直接法' : '矩阵自由 PCG + Jacobi 预条件'}
- 收敛：${result.solver.converged ? 'CONVERGED' : 'NOT CONVERGED'}
- 墙钟时间：网格 ${fmt(result.solver.meshMs, 0)} ms；求解 ${fmt(result.solver.solveMs, 0)} ms
- 应变能：${fmt(result.solver.strainEnergyMj, 2)} mJ

### 4.1 平衡校核

| 分量 | 施加荷载 (N) | 支座反力 (N) | 残差 (N) |
|---|---:|---:|---:|
| Fx | ${fmt(result.equilibrium.applied[0], 3)} | ${fmt(result.equilibrium.reaction[0], 3)} | ${fmt(result.equilibrium.residual[0], 3)} |
| Fy | ${fmt(result.equilibrium.applied[1], 3)} | ${fmt(result.equilibrium.reaction[1], 3)} | ${fmt(result.equilibrium.residual[1], 3)} |
| Fz | ${fmt(result.equilibrium.applied[2], 3)} | ${fmt(result.equilibrium.reaction[2], 3)} | ${fmt(result.equilibrium.residual[2], 3)} |

---

## 5. 结果极值

- 最大 von Mises 应力：**${fmt(result.maxVonMises, 2)} MPa** @ (${result.maxVonMisesLocation.map((v) => fmt(v, 1)).join(', ')}) mm
- 最大位移：**${fmt(result.maxDisplacement, 4)} mm** @ (${result.maxDisplacementLocation.map((v) => fmt(v, 1)).join(', ')}) mm
- 安全系数（屈服）：**${fmt(result.safetyFactor, 2)}**
- 质量：**${fmt(result.massKg, 4)} kg**

---

## 6. 求解器验证

解析基准：悬臂梁端部挠度，L=100 mm，b=20 mm，h=10 mm，P=100 N，E=210,000 MPa，ν=0.3。

| 案例 | 名称 | 解析解 (mm) | 计算解 (mm) | 误差 | 判定 |
|---|---|---:|---:|---:|---|
${validationText}

- 误差容限：${validation ? validation.tolerancePercent : 8}%
- 基准公式：${validation?.formula ?? 'δ = P·L³ / (3·E·I)'}

---

## 7. 自动检查与限制

${warnings}

工程限制：

1. 体素网格对曲面和薄壁边界采用保守切割，峰值应力对网格尺寸敏感；当前 ${result.mesh.elements.toLocaleString('en-US')} 单元的峰值应力不应直接用于疲劳或断裂评定。
2. 载荷以节点等分方式施加于外缘约 2.2 个单元宽的节点带，未模拟螺栓预紧、接触、间隙、摩擦或载荷偏心。
3. 约束为理想 6-DOF 固定面，未模拟螺栓柔度、垫片或基础柔度。
4. 材料为室温名义各向同性参数；铝合金焊接热影响区、残余应力与表面处理未建模。
5. 未进行网格无关性证明时，应补充 h-refinement / 收敛研究；系统已提供 1.8× 加密校核入口。
6. 未包含重力、热载、疲劳、屈曲、模态、冲击或非线性塑性。

---

## 8. 可追溯性

- 文档 schema：${model.schema}
- 模型版本：${model.revision}
- 模型指纹：\`${result.modelHash}\`
- 求解时间：${new Date(result.createdAt).toISOString()}
- 求解器：${result.solver.method === 'SfePy' ? 'Gmsh + SfePy / OCCT STEP' : 'VISION C3D8 / PCG-Jacobi v0.1'}
- 结果状态：${result.status.toUpperCase()}
- 签名：____________________（分析）　____________________（复核）

---

*由 VISION AI-native Engineering Studio 生成。所有数值来自当前浏览器内运行的可复现求解流水线；报告本身不含估算或虚构数据。*
`;
}

export function downloadText(filename: string, content: string, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBinary(filename: string, data: ArrayBuffer, mime = 'application/octet-stream') {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportReportFile(
  model: ModelDocument,
  result: AnalysisResult,
  validation: ValidationResult | null,
): string {
  const content = buildReportMarkdown(model, result, validation);
  downloadText(`VISION_${model.code}_${result.id}.md`, content);
  return content;
}
