import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseBinaryStl } from '../../core/cad/stl';
import { coreArtifactUrl, type CoreInspection } from './api';
import { parseSurface, surfaceColors, type ResultField } from './fields';
import { viewRuler } from './viewHelpers';
import { boundaryAnchor, type BoundaryPreview } from './simulationHelpers';
import { Box, Maximize2, SlidersHorizontal } from 'lucide-react';

/** Mesh hits locate queries; only the native kernel resolves topology identity. */
export function CoreViewport({ artifact, picking, onPick, onMiss, onClear, clearToken, visual, result, selectionOverlay, toolbar, boundary, boundaries, hotspot, theme = 'light' }: { artifact: string | null; picking: boolean; theme?: 'light' | 'dark';
  boundary?: BoundaryPreview | null;
  boundaries?: BoundaryPreview[];
  hotspot?: { point: number[]; displacement?: number[]; label: string; token: number } | null;
  result?: { artifact: string; field: ResultField; scale: number } | null;
  onPick: (point: number[], pixelMm: number) => void; onMiss?: () => void;
  onClear?: () => void; clearToken?: number;
  selectionOverlay?: ReactNode; toolbar?: ReactNode; visual: CoreInspection['visual'] | null }) {
  const host = useRef<HTMLDivElement>(null);
  const engineeringStyle = useRef({ boundary, boundaries, hotspot, visual, result }); engineeringStyle.current = { boundary, boundaries, hotspot, visual, result };
  const updateEngineering = useRef<() => void>(() => {});
  const [engineeringNote, setEngineeringNote] = useState('');
  const [markerCount, setMarkerCount] = useState(0);
  const viewOptions = useRef<HTMLDetailsElement>(null);
  const interaction = useRef({ picking, onPick, onMiss }); interaction.current = { picking, onPick, onMiss };
  const viewAction = useRef<(preset: string) => void>(() => {});
  const sceneStyle = useRef<() => void>(() => {});
  const currentTheme = useRef(theme); currentTheme.current = theme;
  const refreshHud = useRef<() => void>(() => {});
  const clearMarker = useRef<() => void>(() => {});
  const gridObject = useRef<THREE.Group | null>(null);
  const [gridVisible, setGridVisible] = useState(true);
  const gridVisibility = useRef(gridVisible); gridVisibility.current = gridVisible;
  const axes = useRef<SVGSVGElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const rulerText = useRef<HTMLSpanElement>(null);
  const [hitPoint, setHitPoint] = useState<number[] | null>(null);
  const [clickHint, setClickHint] = useState('');
  const currentVisual = useRef(visual); currentVisual.current = visual;
  const highlight = useRef<(value: CoreInspection['visual'] | null) => void>(() => {});
  const fieldStyle = useRef(result); fieldStyle.current = result;
  const updateField = useRef<() => void>(() => {});
  const [range, setRange] = useState<{ min: number; max: number; field: ResultField } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!artifact || !host.current) return;
    const container = host.current;
    const abort = new AbortController();
    let release = () => {};
    setError(''); setLoading(true); setRange(null); setHitPoint(null); setClickHint('');
    void (async () => {
      let surface = null;
      if (result) {
        const manifest = await fetch(`/api/v2/artifacts/${result.artifact}/manifest`, { signal: abort.signal });
        if (!manifest.ok) throw new Error('结果场制品暂不可读取');
        const metadata = await manifest.json();
        if (metadata.kind !== 'fea' || metadata.geometry !== artifact || !metadata.display?.available) throw new Error(metadata.display?.reason ?? '此历史结果不含可显示的边界场，请重新求解');
      }
      const response = await fetch(coreArtifactUrl(result?.artifact ?? artifact, result ? 'surface.bin' : 'preview.stl'), { signal: abort.signal });
      if (!response.ok) throw new Error('几何制品暂不可读取');
      const bytes = await response.arrayBuffer();
      const data = result ? (surface = parseSurface(bytes)) : parseBinaryStl(new Uint8Array(bytes), artifact);
      if (abort.signal.aborted) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      container.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#f0f2f5');
      const camera = new THREE.PerspectiveCamera(40, 1, .01, 100000);
      camera.up.set(0, 0, 1);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
      const diagonal = Math.max(1, geometry.boundingBox!.getSize(new THREE.Vector3()).length());
      const material = surface ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ color: '#b8c4d5', metalness: .18, roughness: .5, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      const edgeGeometry = new THREE.EdgesGeometry(geometry, 25);
      const edgeMaterial = new THREE.LineBasicMaterial({ color: '#78869b' });
      if (!surface) scene.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
      if (surface) {
        const fieldData = surface;
        updateField.current = () => {
          const style = fieldStyle.current;
          if (!style) return;
          const { colors, min, max } = surfaceColors(fieldData, style.field);
          // The legend ramp is sRGB; vertex attributes are linear-light colors.
          const color = new THREE.Color();
          for (let i = 0; i < colors.length; i += 3) {
            color.setRGB(colors[i], colors[i + 1], colors[i + 2], THREE.SRGBColorSpace);
            colors.set([color.r, color.g, color.b], i);
          }
          const positions = geometry.getAttribute('position');
          const deformed = Float32Array.from(fieldData.positions, (value, i) => value + fieldData.displacement[i] * style.scale);
          if (!deformed.every(Number.isFinite)) { setError('变形倍率使显示坐标超出范围，请减小倍率'); return; }
          setError(''); positions.array.set(deformed);
          positions.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere();
          geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          setRange({ min, max, field: style.field });
        };
        updateField.current();
      }
      scene.add(new THREE.HemisphereLight('#ffffff', '#46513f', 2.5));
      const light = new THREE.DirectionalLight('#ffffff', 3);
      light.position.copy(center).add(new THREE.Vector3(diagonal, -diagonal, diagonal * 2));
      scene.add(light);
      camera.position.copy(center).add(new THREE.Vector3(diagonal, -diagonal * 1.3, diagonal * .85));
      camera.near = diagonal / 10000; camera.far = diagonal * 1000;
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(center); controls.enableDamping = true; controls.update();
      const engineering = new THREE.Group(); scene.add(engineering);
      const clearEngineering = () => {
        engineering.traverse(object => {
          const item = object as THREE.Mesh;
          item.geometry?.dispose();
          if (item.material) (Array.isArray(item.material) ? item.material : [item.material]).forEach(material => material.dispose());
        });
        engineering.clear();
      };
      let lastFocus = 0;
      updateEngineering.current = () => {
        clearEngineering(); setEngineeringNote(''); setMarkerCount(0);
        const { boundary: manual, boundaries: automatic, hotspot: focus, visual: outline, result: style } = engineeringStyle.current;
        const line = (points: THREE.Vector3[], color: string) => {
          const object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, depthTest: false }));
          object.renderOrder = 30; engineering.add(object);
        };
        if (focus && style) {
          const position = new THREE.Vector3(...focus.point as [number, number, number]);
          if (focus.displacement) position.addScaledVector(new THREE.Vector3(...focus.displacement as [number, number, number]), style.scale);
          else if (style.scale !== 0) { setEngineeringNote('此历史结果未记录热点位移，请将变形倍率设为 0 后定位。'); return; }
          const marker = new THREE.Mesh(new THREE.SphereGeometry(diagonal * .012, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffcf62', depthTest: false }));
          marker.position.copy(position); marker.renderOrder = 40; engineering.add(marker);
          if (lastFocus !== focus.token) {
            camera.position.add(position.clone().sub(controls.target)); controls.target.copy(position); controls.update(); lastFocus = focus.token;
          }
          setEngineeringNote(`${focus.label} · 原始坐标 [${focus.point.map(x => Number(x.toPrecision(6))).join(', ')}] mm；内部极值可能位于表面之后。`);
          return;
        }
        const notes: string[] = [];
        let glyphs = 0;
        for (const value of manual ? [manual] : automatic ?? []) {
        const color = value.kind === 'load' ? '#e34646' : '#2998df';
        let anchor: THREE.Vector3 | null = null;
        if (value.evidence?.center) {
          const samples = value.evidence.displayNodes ?? [];
          const selectedPoint = boundaryAnchor(samples, value.evidence.center);
          if (selectedPoint) anchor = new THREE.Vector3(...selectedPoint as [number, number, number]);
          const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(samples.map(point => new THREE.Vector3(...point as [number, number, number]))),
            new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false, depthTest: false }));
          dots.renderOrder = 30; engineering.add(dots);
        } else if (value.region?.type === 'cad-face' || value.region?.type === 'semantic-object') {
          const points = value.lines?.flat() ?? (manual ? outline?.lines.flat() ?? [] : []);
          const selectedPoint = boundaryAnchor(points);
          if (selectedPoint) anchor = new THREE.Vector3(...selectedPoint as [number, number, number]);
        } else {
          const bounds = value.bounds ? new THREE.Box3(new THREE.Vector3(...value.bounds.min as [number, number, number]), new THREE.Vector3(...value.bounds.max as [number, number, number])) : geometry.boundingBox!;
          let lo = bounds.min.clone(), hi = bounds.max.clone();
          if (value.region?.type === 'box') {
            lo = new THREE.Vector3(...value.region.min); hi = new THREE.Vector3(...value.region.max);
          }
          if (value.region?.type === 'sphere') {
            anchor = new THREE.Vector3(...value.region.center);
            for (let axis = 0; axis < 3; axis++) {
              const points = Array.from({ length: 65 }, (_, i) => {
                const point = anchor!.clone(), angle = i / 64 * Math.PI * 2;
                point.setComponent((axis + 1) % 3, point.getComponent((axis + 1) % 3) + Math.cos(angle) * (value.region as { radius: number }).radius);
                point.setComponent((axis + 2) % 3, point.getComponent((axis + 2) % 3) + Math.sin(angle) * (value.region as { radius: number }).radius); return point;
              }); line(points, color);
            }
          } else {
            if (!value.region) {
              const axis = ['x','y','z'].indexOf((value.face ?? 'x-min')[0]);
              const limit = (value.face?.endsWith('max') ? hi : lo).getComponent(axis);
              lo.setComponent(axis, limit); hi.setComponent(axis, limit);
            }
            anchor = lo.clone().add(hi).multiplyScalar(.5);
            const box = new THREE.Box3Helper(new THREE.Box3(lo, hi), new THREE.Color(color)); engineering.add(box);
          }
          // A selector envelope is not evidence of a physical surface attachment.
          anchor = null;
        }
        if (anchor) {
          if (value.kind === 'load' && value.force && Math.hypot(...value.force) > 0) {
            glyphs++;
            const direction = new THREE.Vector3(...value.force as [number, number, number]).normalize();
            const arrow = new THREE.ArrowHelper(direction, anchor, diagonal * .16, color, diagonal * .035, diagonal * .02);
            arrow.traverse(object => {
              object.renderOrder = 30;
              const drawable = object as THREE.Mesh;
              if (drawable.material) (Array.isArray(drawable.material) ? drawable.material : [drawable.material]).forEach(material => { material.depthTest = false; });
            });
            engineering.add(arrow);
          } else if (value.kind === 'support') {
            glyphs++;
            const size = diagonal * .025;
            line([anchor.clone().add(new THREE.Vector3(-size,0,-size)), anchor.clone().add(new THREE.Vector3(size,0,size))], color);
            line([anchor.clone().add(new THREE.Vector3(size,0,-size)), anchor.clone().add(new THREE.Vector3(-size,0,size))], color);
          }
        }
        notes.push(`${value.name} · ${value.kind === 'load' ? `合力 [${value.force?.map(x => Number(x.toPrecision(5))).join(', ')}] N` : '三个平移方向全固定'} · ${value.evidence ? '实际命中节点抽样标记（最多 192 个）' : anchor ? '求解前区域示意，箭长仅示方向，非 FEM 命中证明' : '仅选区范围示意，实际作用位置尚未确认；请选择模型面或求解后核对'}`);
        }
        setMarkerCount(glyphs);
        setEngineeringNote(notes.slice(0, 3).join('；') + (notes.length > 3 ? `；另有 ${notes.length - 3} 条` : '') + (style && style.scale !== 0 && notes.length ? ' · 载荷标记按原形位置显示' : ''));
      };
      updateEngineering.current();
      const worldGrid = new THREE.Group();
      const gridStep = 10 ** Math.floor(Math.log10(diagonal / 10));
      const floor = new THREE.GridHelper(gridStep * 40, 40, '#8691a0', '#a3afbf');
      floor.rotation.x = Math.PI / 2;
      floor.position.set(Math.round(center.x / gridStep) * gridStep, Math.round(center.y / gridStep) * gridStep, 0);
      floor.material.transparent = true; floor.material.opacity = .22; floor.material.depthWrite = false;
      const worldAxes = new THREE.AxesHelper(diagonal * .35);
      worldGrid.add(floor, worldAxes); worldGrid.visible = gridVisibility.current;
      scene.add(worldGrid); gridObject.current = worldGrid;
      sceneStyle.current = () => {
        const dark = currentTheme.current === 'dark';
        scene.background = new THREE.Color(dark ? '#1c1e22' : '#f0f2f5');
        if (!surface) material.color.set(dark ? '#b8c4d5' : '#a4b3c8');
        edgeMaterial.color.set(dark ? '#718198' : '#718096');
        floor.material.opacity = dark ? .24 : .38;
      };
      sceneStyle.current();
      const updateHud = () => {
        const inverse = camera.quaternion.clone().invert();
        [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].forEach((direction, index) => {
          direction.applyQuaternion(inverse);
          const line = axes.current?.querySelector(`[data-axis="${index}"]`);
          const text = axes.current?.querySelector(`[data-label="${index}"]`);
          line?.setAttribute('x2', String(48 + direction.x * 30)); line?.setAttribute('y2', String(48 - direction.y * 30));
          text?.setAttribute('x', String(48 + direction.x * 40)); text?.setAttribute('y', String(52 - direction.y * 40));
        });
        const scale = viewRuler(camera.position.distanceTo(controls.target), camera.fov, Math.max(1, container.clientHeight));
        if (scale && ruler.current && rulerText.current) {
          ruler.current.style.width = `${scale.pixels}px`;
          rulerText.current.textContent = `${Number(scale.length.toPrecision(4))} mm`;
        }
      };
      refreshHud.current = updateHud;
      viewAction.current = preset => {
        const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
        const distance = diagonal / 2 / Math.sin(Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect))) * 1.35;
        const direction = preset === 'front' ? new THREE.Vector3(0, -1, 0) : preset === 'right' ? new THREE.Vector3(1, 0, 0) :
          preset === 'top' ? new THREE.Vector3(0, -.0001, 1) : preset === 'iso' ? new THREE.Vector3(1, -1.3, .85) : camera.position.clone().sub(controls.target);
        controls.target.copy(center); camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
        controls.update(); updateHud();
      };
      controls.addEventListener('change', updateHud);
      let fitted = false;
      const resize = new ResizeObserver(() => {
        const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const previousSpan = tangent * Math.min(1, camera.aspect);
        camera.aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
        // Preserve the target and orientation when panels change the viewport width.
        if (fitted) camera.position.sub(controls.target).multiplyScalar(previousSpan / (tangent * Math.min(1, camera.aspect))).add(controls.target);
        camera.updateProjectionMatrix();
        renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
        updateHud();
        if (!fitted) { fitted = true; viewAction.current('fit'); }
      });
      resize.observe(container);
      const overlay = new THREE.Group(); scene.add(overlay);
      const markerGeometry = new THREE.SphereGeometry(1, 12, 8);
      const markerMaterial = new THREE.MeshBasicMaterial({ color: '#ffcf62', depthTest: false });
      const marker = new THREE.Mesh(markerGeometry, markerMaterial); marker.visible = false; marker.renderOrder = 20; scene.add(marker);
      clearMarker.current = () => { marker.visible = false; setHitPoint(null); setClickHint(''); };
      const clearOverlay = () => {
        for (const child of [...overlay.children]) {
          const line = child as THREE.Line;
          line.geometry.dispose(); (line.material as THREE.Material).dispose(); overlay.remove(line);
        }
      };
      highlight.current = value => {
        clearOverlay();
        for (const points of value?.lines ?? []) {
          const shape = new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(point[0], point[1], point[2])));
          const line = new THREE.Line(shape, new THREE.LineBasicMaterial({ color: '#67e8f9', depthTest: false }));
          line.renderOrder = 10; overlay.add(line);
        }
      };
      highlight.current(currentVisual.current);
      let start: [number, number] | null = null;
      const down = (event: PointerEvent) => { start = event.button === 0 ? [event.clientX, event.clientY] : null; };
      const up = (event: PointerEvent) => {
        const origin = start; start = null;
        if (surface || !origin || event.button !== 0 || Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 4) return;
        if (!interaction.current.picking) { setClickHint('当前不可选择；请切换选择模式或等待正在进行的查询完成。'); return; }
        const rect = renderer.domElement.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
        const hit = ray.intersectObject(mesh, false)[0];
        if (!hit) { marker.visible = false; setHitPoint(null); setClickHint('未命中模型，选择已清除。'); interaction.current.onMiss?.(); return; }
        const pixelMm = 2 * camera.position.distanceTo(hit.point) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / rect.height;
        marker.position.copy(hit.point); marker.scale.setScalar(pixelMm * 4); marker.visible = true;
        setHitPoint(hit.point.toArray()); setClickHint('');
        interaction.current.onPick(hit.point.toArray(), pixelMm);
      };
      renderer.domElement.addEventListener('pointerdown', down);
      renderer.domElement.addEventListener('pointerup', up);
      let frame = 0;
      const render = () => {
        controls.update();
        if (marker.visible) marker.scale.setScalar(2 * camera.position.distanceTo(marker.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, container.clientHeight) * 4);
        renderer.render(scene, camera); frame = requestAnimationFrame(render);
      };
      viewAction.current('fit');
      render();
      release = () => {
        renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', up);
        highlight.current = () => {}; clearOverlay();
        viewAction.current = () => {}; gridObject.current = null;
        refreshHud.current = () => {};
        sceneStyle.current = () => {};
        clearMarker.current = () => {};
        controls.removeEventListener('change', updateHud);
        updateField.current = () => {};
        cancelAnimationFrame(frame); resize.disconnect(); controls.dispose();
        updateEngineering.current = () => {}; clearEngineering();
        geometry.dispose(); material.dispose(); edgeGeometry.dispose(); edgeMaterial.dispose();
        floor.geometry.dispose(); floor.material.dispose(); worldAxes.geometry.dispose(); (worldAxes.material as THREE.Material).dispose();
        markerGeometry.dispose(); markerMaterial.dispose();
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      };
      setLoading(false);
    })().catch((failure: unknown) => {
      if (!abort.signal.aborted) { setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); }
    });
    return () => { abort.abort(); release(); };
  }, [artifact, result?.artifact]);
  useEffect(() => { updateField.current(); }, [result?.field, result?.scale]);
  useEffect(() => { updateEngineering.current(); }, [boundary, boundaries, hotspot, visual, result?.scale, result?.artifact]);
  useEffect(() => { sceneStyle.current(); }, [theme]);
  useEffect(() => { highlight.current(visual); }, [visual]);
  useEffect(() => { if (gridObject.current) gridObject.current.visible = gridVisible; }, [gridVisible]);
  useEffect(() => { clearMarker.current(); }, [clearToken]);
  useEffect(() => { if (viewOptions.current) viewOptions.current.open = false; }, [artifact]);
  useEffect(() => {
    if (!clickHint) return;
    const timer = setTimeout(() => setClickHint(''), 2200);
    return () => clearTimeout(timer);
  }, [clickHint]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (viewOptions.current?.open && event.target instanceof Node && !viewOptions.current.contains(event.target)) viewOptions.current.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  useEffect(() => {
    if (loading) return;
    const frame = requestAnimationFrame(() => refreshHud.current());
    return () => cancelAnimationFrame(frame);
  }, [loading, artifact]);
  return <div className={`core-viewport${picking ? ' is-picking' : ''}${result ? ' has-field' : ''}`} ref={host} aria-label="原生几何视口" tabIndex={0} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (viewOptions.current?.open) { viewOptions.current.open = false; viewOptions.current.querySelector('summary')?.focus(); }
    else onClear?.();
  }}>
    {!artifact && <div className="viewport-empty"><Box size={42} strokeWidth={1} /><h2>从想法开始建模</h2><p>在右侧描述你的设计，或打开工程工具编写脚本。模型将在这里生成。</p></div>}
    {artifact && loading && <p>正在读取几何制品…</p>}
    {artifact && error && <p role="alert">{error}</p>}
    {artifact && <div className="viewport-toolbar" role="toolbar" aria-label="模型工具栏">
      {toolbar}
      <button className="viewport-icon" aria-label="适应模型" title="适应模型" disabled={loading || !!error} onClick={() => viewAction.current('fit')}><Maximize2 size={15} /></button>
      <details className="viewport-options" ref={viewOptions}>
        <summary aria-label="视图选项" title="视角、网格与操作说明"><SlidersHorizontal size={15} /></summary>
        <div className="viewport-options-menu">
          <span>标准视角</span><div className="viewport-presets">{[['iso','等轴测'],['front','正视'],['top','俯视'],['right','右视']].map(([preset,label]) =>
            <button key={preset} disabled={loading || !!error} onClick={() => { viewAction.current(preset); if (viewOptions.current) viewOptions.current.open = false; }}>{label}</button>)}</div>
          <label title="XY 平面网格（Z=0），XYZ 轴从世界原点出发"><input type="checkbox" aria-label="坐标网格" checked={gridVisible} onChange={event => setGridVisible(event.target.checked)} />坐标网格</label>
          <p>拖动旋转 · 滚轮缩放 · 右键平移<br />Esc 清除选择</p>
        </div>
      </details>
    </div>}
    {artifact && !loading && !error && <>
      <div className="core-axis-hud" aria-label="世界坐标方向 X Y Z，单位毫米">
        <svg ref={axes} viewBox="0 0 96 96" aria-hidden="true">{['#ff8585', '#99d899', '#89beff'].map((color, index) => <g key={index} fill={color} stroke={color}>
          <line data-axis={index} x1="48" y1="48" x2="48" y2="48" strokeWidth="2" /><text data-label={index} x="48" y="48" stroke="none" textAnchor="middle">{['X', 'Y', 'Z'][index]}</text>
        </g>)}<circle cx="48" cy="48" r="2" fill="white" /></svg><span>世界坐标 · mm</span>
      </div>
      <div className="core-ruler" aria-label="视图中心比例尺，仅供参考，不是测量值"><span ref={rulerText} /><div ref={ruler} /></div>
      {!result && (selectionOverlay || clickHint || hitPoint) && <div className="core-pick-overlay" aria-live="polite">{selectionOverlay}{clickHint && <p>{clickHint}</p>}
        {hitPoint && <small>点击点（显示网格） · X {hitPoint[0].toFixed(3)} / Y {hitPoint[1].toFixed(3)} / Z {hitPoint[2].toFixed(3)} mm</small>}
      </div>}
    </>}
    {(boundary || boundaries?.length || hotspot) && engineeringNote && <div className="simulation-viewport-note" data-marker-count={markerCount} role="status">{engineeringNote}</div>}
    {result && range && <div className="core-field-legend" aria-label="结果场图例">
      <strong>{range.field === 'displacement' ? '位移幅值 / mm' : '节点平均 von Mises / MPa'}</strong>
      <div className="core-color-ramp" /><span>{range.min.toPrecision(5)} — {range.max.toPrecision(5)}</span>
      <span>变形倍率 ×{result.scale} · 仅 FEM 边界节点范围（非全模型极值）</span>
    </div>}
  </div>;
}
