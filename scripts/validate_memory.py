"""Real local-model retrieval evaluation, using synthetic engineering data only."""
import json
import argparse
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.vision.retrieval import retrieve
from backend.vision.storage import Workspace, identity, packed

CASES = [
    ("机架采用地脚螺栓锚固在混凝土基座上。", "设备底座如何连接到地面？"),
    ("薄壁壳体使用铝合金6061材料，弹性模量69000MPa。", "外罩使用的金属是什么？"),
    ("所有外露棱边做半径2mm的圆角，避免操作人员划伤。", "怎么处理尖锐边缘以保护手部？"),
    ("试验要求一阶固有频率高于80Hz，当前静力求解未验证此项。", "振动方面还有什么验收条件没有检查？"),
    ("载荷由原来的100N改为1000N，以最新工况为准。", "最新施加的作用力多大？"),
    ("模型蓝色仅用于显示，不代表材料或应力值。", "颜色能说明材质和强度吗？"),
]


def main():
    with tempfile.TemporaryDirectory(prefix="vision-memory-eval-") as folder:
        workspace = Workspace(folder)
        def project(name):
            return workspace.create({"command_id": identity(), "idempotency_key": identity(), "name": name})["project_id"]
        owner, foreign = project("synthetic evaluation"), project("isolated project")
        sources = []
        with workspace.db() as db:
            for index, (text, _) in enumerate(CASES):
                source = identity()
                sources.append(source)
                db.execute("INSERT INTO sources VALUES(?,?,?,?)", (source, owner, packed({"origin": "user_task_input", "text": text}), time.time() + index))
                db.execute("INSERT INTO sources VALUES(?,?,?,?)", (identity(), foreign, packed({"origin": "user_task_input", "text": text}), time.time() + index))
            for text in ["相机旋转速度保持默认。", "网格尺寸建议在求解前做收敛检查。", "软件窗口标题为VISION。"]:
                db.execute("INSERT INTO sources VALUES(?,?,?,?)", (identity(), owner, packed({"origin": "user_task_input", "text": text}), time.time()))
        checks = []
        for source, (_, query) in zip(sources, CASES, strict=True):
            found, metadata = retrieve(workspace, owner, query, limit=3)
            rank = next((index + 1 for index, item in enumerate(found) if item["source_id"] == source), None)
            checks.append({"query": query, "expected_source_rank": rank, "metadata": metadata,
                           "results": [{"text": item["text"], "rerank_score": item["rerank_score"]} for item in found]})
        report = {"embedding_and_rerank_real": True, "synthetic_only": True,
            "recall_at_3": sum(item["expected_source_rank"] is not None for item in checks) / len(checks),
            "all_hybrid_reranked": all(item["metadata"]["mode"] == "hybrid_reranked" for item in checks), "cases": checks}
        output = Path(__file__).resolve().parents[1] / "screenshots" / "memory-retrieval-evaluation.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in report.items() if key != "cases"}, ensure_ascii=False))
        if report["recall_at_3"] != 1 or not report["all_hybrid_reranked"]:
            raise SystemExit("local retrieval evaluation failed; see screenshots/memory-retrieval-evaluation.json")


def live_conversation():
    """Two real provider rounds in a disposable project; never opens user projects."""
    from fastapi.testclient import TestClient
    from backend.vision.api import create_app
    def command(**fields):
        key = identity()
        return {"command_id": key, "idempotency_key": key, **fields}
    rounds = []
    with tempfile.TemporaryDirectory(prefix="vision-memory-conversation-") as folder:
        app = create_app(folder, run_jobs=False)
        with TestClient(app) as client:
            revision = client.post('/api/v2/projects', json=command(name='Synthetic memory replay')).json()
            base = '/api/v2/projects/' + revision['project_id']
            messages = [
                '长期要求：测试支架的板厚必须为5mm。请调用remember保存为requirement，随后finish简短确认。只整理记忆，不建模、不查询CAD、不求解。',
                '纠正上一条长期要求：板厚从5mm改为8mm。请用remember的supersedes显式替代旧的厚度记忆，随后finish确认。只整理记忆，不进行其他工程操作。',
            ]
            for index, text in enumerate(messages):
                previous = client.get(base + '/conversation').json()['task']
                sent = client.post(base + '/conversation', json=command(expected_head=revision['revision_id'], text=text,
                    expected_task=previous['id'] if previous else None, expected_epoch=previous['epoch'] if previous else None))
                sent.raise_for_status()
                task = sent.json()['task_id']
                # Bound the verification harness; production conversation remains unlimited.
                for _ in range(8):
                    app.state.tasks.step(task)
                    current = app.state.tasks.get(task)
                    if current['state'] not in ('created', 'executing', 'waiting_job'):
                        break
                if current['state'] != 'completed':
                    app.state.tasks.change(task, command(expected_epoch=current['epoch']))
                    raise RuntimeError('synthetic memory replay did not complete')
                memories = client.get(base + '/memory').json()['entries']
                rounds.append({'message': index + 1, 'state': current['state'], 'requests': current['turns'],
                    'tools': [step['response']['tool'] for step in current['steps'] if step['epoch'] == current['epoch']],
                    'requirements': [{key: entry[key] for key in ('text', 'status', 'authored_by')} for entry in memories if entry['kind'] == 'requirement']})
            active = [entry for entry in memories if entry['kind'] == 'requirement' and entry['status'] == 'active']
            if len(active) != 1 or '8' not in active[0]['text'] or not any(entry['kind'] == 'requirement' and entry['status'] == 'superseded' for entry in memories):
                raise RuntimeError('model failed to explicitly replace the original requirement')
    output = Path(__file__).resolve().parents[1] / 'screenshots' / 'memory-live-replay.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps({'synthetic_only': True, 'real_deepseek': True, 'rounds': rounds}, ensure_ascii=False, indent=2), encoding='utf-8')
    print('real model memory correction replay passed')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live-conversation', action='store_true', help='send two synthetic conversation rounds to the configured DeepSeek service')
    options = parser.parse_args()
    live_conversation() if options.live_conversation else main()
