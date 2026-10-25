"""Snapshot-specific Markdown reporting. Never runs a calculation implicitly."""
import json

from .assessment import assess


def report(workspace, project, revision_id=None):
    revision = workspace.revision(project, revision_id)
    assessment = assess(workspace, project, revision["revision_id"])
    document = revision["document"]
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")
    lines = ["# VISION 工程指标核验报告", "", f"工程：{cell(document['name'])}",
             f"版本：`{revision['revision_id']}`", f"几何制品：`{document['geometry'] or '未构建'}`",
             "单位：mm、N、MPa、kg。物理模型：均匀各向同性线弹性静力。", "",
             f"判定方法：`{assessment['method']}`；实现：`{assessment['evaluator_sha256']}`", "",
             "## 已定义要求", "", "| 要求 | 阈值 | 计算值 | 判定 |", "| --- | --- | --- | --- |"]
    for item in assessment["findings"]:
        requirement = item["requirement"]
        limit = f"{'≤' if requirement['comparison'] == 'le' else '≥'} {requirement['threshold']} {requirement['unit']}"
        value = f"{item['value']:.8g} {requirement['unit']}" if item["value"] is not None else "未核验"
        lines.append(f"| {cell(requirement['name'])} | {cell(limit)} | {cell(value)} | {item['status']} |")
    if not assessment["findings"]:
        lines.append("| 未定义工程要求 | — | — | unknown |")
    lines.extend(["", "## 数值证据", ""])
    if assessment["evidence_job_id"]:
        job = workspace.job(assessment["evidence_job_id"])
        manifest = workspace.artifacts.manifest(job["result"]["artifact_id"])
        summary = manifest["result"]
        lines.extend([f"作业：`{job['id']}`", f"原始输入版本：`{job['revision']}`",
                      f"分析制品：`{job['result']['artifact_id']}`",
                      f"当前计算输入摘要：`{assessment['calculation_key']}`", ""])
        for key, label, unit in (("maxDisplacement", "最大位移", "mm"), ("maxVonMises", "节点平均 von Mises 应力极值", "MPa"),
                                 ("safetyFactor", "屈服安全系数", ""), ("mass_kg", "网格质量", "kg"),
                                 ("relativeResidual", "自由 DOF 相对残差", ""), ("equilibriumError", "相对反力平衡误差", ""),
                                 ("elements", "四面体单元", ""), ("dofs", "自由度", "")):
            lines.append(f"- {label}：{summary[key]} {unit}")
        lines.extend(["", "运行环境与实现记录：", "", *["    " + line for line in json.dumps(manifest["provenance"], ensure_ascii=False, indent=2).splitlines()]])
    else:
        lines.append("当前输入没有可核验的本地成功数值证据；导入、失败、计算中或运行环境变化的结果不用于判定。")
    lines.extend(["", "## 工况", "", *["    " + line for line in json.dumps(document.get("study"), ensure_ascii=False, indent=2).splitlines()],
                  "", "## 要求来源", ""])
    with workspace.db() as db:
        for item in assessment["findings"]:
            requirement = item["requirement"]
            row = db.execute("SELECT payload FROM sources WHERE id=? AND project=?", (requirement["source_event"], project)).fetchone()
            lines.extend([f"来源 `{requirement['source_event']}` · {cell(requirement['name'])}", ""])
            text = json.loads(row[0])["text"] if row else "来源不可用"
            if row:
                lines.extend([f"来源类型：{cell(json.loads(row[0]).get('origin', 'unknown'))}", ""])
            lines.extend("    " + line for line in text.splitlines())
            lines.append("")
    lines.extend(["## 适用边界", "", assessment["notice"],
                  "应力为节点平均恢复值；未证明局部应力收敛。接触、塑性、疲劳、屈曲、模态与多物理场不在本次模型范围。",
                  "报告仅比较明确给定的指标，不补造验收阈值，不构成整体设计认证。", ""])
    return "\n".join(lines)
