"""Fetch pinned public ONNX models, verify files, then smoke-test offline inference."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.vision.retrieval import CACHE, EMBEDDING, RERANKER, models

SPECS = [
    ('embedding', 'Qdrant/bge-small-zh-v1.5', '46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59', 'model_optimized.onnx'),
    ('reranker', 'onnx-community/bge-reranker-v2-m3-ONNX', '6f5ff65298512715a1e669753bc754d2bc8f367b', 'onnx/model_int8.onnx'),
]


def valid(path, entry):
    if not path.is_file() or path.stat().st_size != entry['size']:
        return False
    data = path.read_bytes()
    if entry.get('lfs'):
        return hashlib.sha256(data).hexdigest() == entry['lfs']['oid']
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == entry['oid']


def fetch(url, path, entry):
    if valid(path, entry):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    size = entry['size']
    def segment(bounds):
        start, end = bounds
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}', 'User-Agent': 'VISION-local-model-setup/1'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    if response.status != 206:
                        raise ValueError('model host did not honor byte range')
                    data = response.read()
                if len(data) != end - start + 1:
                    raise ValueError('incomplete model range')
                return start, data
            except (OSError, ValueError):
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
    if size < 1024 * 1024:
        with urllib.request.urlopen(url, timeout=60) as response:
            path.write_bytes(response.read())
    else:
        spans = [(start, min(size-1, start+2*1024*1024-1)) for start in range(0, size, 2*1024*1024)]
        done = 0
        with path.open('wb') as output, ThreadPoolExecutor(max_workers=8) as pool:
            output.truncate(size)
            futures = {pool.submit(segment, span): span for span in spans}
            for future in as_completed(futures):
                offset, data = future.result()
                output.seek(offset); output.write(data)
                done += len(data)
                del futures[future]
                if done == size or done // (32*1024*1024) != (done-len(data)) // (32*1024*1024):
                    print(f'{path.name}: {done * 100 // size}%', flush=True)
    if not valid(path, entry):
        raise ValueError('model checksum mismatch: ' + path.name)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    fingerprints = {}
    for label, repo, revision, weight in SPECS:
        with urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true', timeout=30) as response:
            files = json.load(response)
        wanted = [entry for entry in files if entry['type'] == 'file' and (
            entry['path'] == weight or ('/' not in entry['path'] and entry['path'].endswith(('.json', '.txt', '.model'))))]
        for entry in wanted:
            name = entry['path']
            target = (CACHE / label / name).resolve()
            if not target.is_relative_to((CACHE / label).resolve()):
                raise ValueError('invalid model file path')
            print('fetch', label, name, flush=True)
            fetch(f'https://huggingface.co/{repo}/resolve/{revision}/' + urllib.parse.quote(name), target, entry)
        fingerprints[label + '_revision'] = revision
        fingerprints[label + '_sha256'] = hashlib.sha256((CACHE / label / weight).read_bytes()).hexdigest()
    embedding, reranker = models()
    vector = next(embedding.query_embed('安装支架的固定方式'))
    scores = list(reranker.rerank('如何固定支架', ['用螺栓将支架固定在墙上。', '模型显示为蓝色。'], batch_size=2))
    if len(vector) != 512 or len(scores) != 2 or scores[0] <= scores[1]:
        raise RuntimeError('local model smoke check failed')
    report = {'embedding': EMBEDDING, 'reranker': RERANKER, 'dimension': len(vector), **fingerprints}
    (CACHE / 'ready.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'ready': True, **report, 'smoke_scores': scores}, ensure_ascii=False))


if __name__ == '__main__':
    main()
