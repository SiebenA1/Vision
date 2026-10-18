import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { Box, Crosshair, Eye, EyeOff, Maximize2, Scan, Tag } from 'lucide-react';
import type { AnalysisResult, FieldKind, GeometryData, ModelDocument } from '../core/types';
import type { MaterialSpec } from '../core/materials';
import { projectField } from '../core/fea/fieldProjection';

type CameraPreset = 'iso' | 'front' | 'top' | 'side';

interface SceneViewportProps {
  geometry: GeometryData | null;
  model: ModelDocument;
  material: MaterialSpec;
  analysis: AnalysisResult | null;
  viewMode: 'design' | 'result';
  field: FieldKind;
  deformationScale: number;
  showEdges: boolean;
  showAnnotations: boolean;
  autoFit?: boolean;
  active?: boolean;
  onToggleEdges?: () => void;
  onToggleAnnotations?: () => void;
}

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  controls: OrbitControls;
  modelGroup: THREE.Group;
  annotationGroup: THREE.Group;
  edgeGroup: THREE.Group;
  raf: number;
  disposed: boolean;
  lastFit: string | null;
  loadMaterials: THREE.MeshBasicMaterial[];
  marker: THREE.Mesh | null;
  labels: CSS2DObject[];
  grid: THREE.GridHelper | null;
  ground: THREE.Mesh | null;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}

function makeLabel(className: string, html: string, position: THREE.Vector3): CSS2DObject {
  const element = document.createElement('div');
  element.className = `scene-label ${className}`;
  element.innerHTML = html;
  const label = new CSS2DObject(element);
  label.position.copy(position);
  return label;
}

function makeSupportPlane(bbox: GeometryData['bbox'], face: string): THREE.Group {
  const group = new THREE.Group();
  const spanX = bbox.max[0] - bbox.min[0];
  const spanY = bbox.max[1] - bbox.min[1];
  const spanZ = bbox.max[2] - bbox.min[2];
  const pad = 0.16;
  let width = spanZ * (1 + pad);
  let height = spanY * (1 + pad);
  let center = new THREE.Vector3(bbox.min[0] - 0.7, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
  let rotation = new THREE.Euler(0, Math.PI / 2, 0);
  if (face === 'x-max') {
    center = new THREE.Vector3(bbox.max[0] + 0.7, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
  } else if (face === 'z-min') {
    width = spanX * (1 + pad);
    height = spanY * (1 + pad);
    center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, bbox.min[2] - 0.7);
    rotation = new THREE.Euler(0, 0, 0);
  } else if (face === 'z-max') {
    width = spanX * (1 + pad);
    height = spanY * (1 + pad);
    center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, bbox.max[2] + 0.7);
    rotation = new THREE.Euler(0, 0, 0);
  } else if (face === 'y-min') {
    width = spanX * (1 + pad);
    height = spanZ * (1 + pad);
    center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, bbox.min[1] - 0.7, (bbox.min[2] + bbox.max[2]) / 2);
    rotation = new THREE.Euler(Math.PI / 2, 0, 0);
  } else if (face === 'y-max') {
    width = spanX * (1 + pad);
    height = spanZ * (1 + pad);
    center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, bbox.max[1] + 0.7, (bbox.min[2] + bbox.max[2]) / 2);
    rotation = new THREE.Euler(Math.PI / 2, 0, 0);
  }
  const material = new THREE.MeshBasicMaterial({
    color: 0x7fe3c4,
    transparent: true,
    opacity: 0.045,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height, 1, 1), material);
  plane.rotation.copy(rotation);
  plane.position.copy(center);
  plane.renderOrder = 1;
  group.add(plane);

  const gridMaterial = new THREE.LineBasicMaterial({
    color: 0x7fe3c4,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const points: number[] = [];
  const cols = 7;
  const rows = 5;
  for (let i = 0; i <= cols; i += 1) {
    const u = -0.5 + i / cols;
    points.push(u * width, -height / 2, 0, u * width, height / 2, 0);
  }
  for (let i = 0; i <= rows; i += 1) {
    const v = -0.5 + i / rows;
    points.push(-width / 2, v * height, 0, width / 2, v * height, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const lines = new THREE.LineSegments(geometry, gridMaterial);
  lines.rotation.copy(rotation);
  lines.position.copy(center);
  group.add(lines);
  return group;
}

function loadFaceCenter(geometry: GeometryData, face: string): THREE.Vector3 {
  const bbox = geometry.bbox;
  const axis = face[0] as 'x' | 'y' | 'z';
  const side = face.endsWith('min') ? 'min' : 'max';
  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const plane = side === 'min' ? bbox.min[axisIndex] : bbox.max[axisIndex];
  const tolerance = Math.max(
    2,
    0.035 *
      Math.max(
        bbox.max[0] - bbox.min[0],
        bbox.max[1] - bbox.min[1],
        bbox.max[2] - bbox.min[2],
      ),
  );
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let count = 0;
  for (let i = 0; i < geometry.positions.length / 3; i += 1) {
    const x = geometry.positions[i * 3];
    const y = geometry.positions[i * 3 + 1];
    const z = geometry.positions[i * 3 + 2];
    const value = axisIndex === 0 ? x : axisIndex === 1 ? y : z;
    if (side === 'min' ? value <= plane + tolerance : value >= plane - tolerance) {
      sx += x;
      sy += y;
      sz += z;
      count += 1;
    }
  }
  if (count > 0) return new THREE.Vector3(sx / count, sy / count, sz / count);
  return new THREE.Vector3(
    (bbox.min[0] + bbox.max[0]) / 2,
    (bbox.min[1] + bbox.max[1]) / 2,
    (bbox.min[2] + bbox.max[2]) / 2,
  );
}

export function SceneViewport({
  geometry,
  model,
  material,
  analysis,
  viewMode,
  field,
  deformationScale,
  showEdges,
  showAnnotations,
  autoFit = false,
  active = true,
  onToggleEdges,
  onToggleAnnotations,
}: SceneViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('iso');
  const dataRef = useRef({ analysis, field, deformationScale, model, material });
  dataRef.current = { analysis, field, deformationScale, model, material };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(220, -300, 220);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = 'scene-canvas';
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = 'scene-label-layer';
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.inset = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controls.minDistance = 20;
    controls.maxDistance = 2000;
    controls.target.set(65, 0, 64);

    const hemi = new THREE.HemisphereLight(0xe6f0db, 0x22251e, 1.35);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff1d8, 3.2);
    key.position.set(170, -220, 300);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 10;
    key.shadow.camera.far = 800;
    key.shadow.camera.left = -220;
    key.shadow.camera.right = 220;
    key.shadow.camera.top = 220;
    key.shadow.camera.bottom = -220;
    key.shadow.bias = -0.0005;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8bb9ff, 1.1);
    fill.position.set(-260, 120, 120);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffb487, 1.4);
    rim.position.set(80, 240, 180);
    scene.add(rim);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    const edgeGroup = new THREE.Group();
    scene.add(edgeGroup);
    const annotationGroup = new THREE.Group();
    scene.add(annotationGroup);

    const context: SceneContext = {
      scene,
      camera,
      renderer,
      labelRenderer,
      controls,
      modelGroup,
      annotationGroup,
      edgeGroup,
      raf: 0,
      disposed: false,
      lastFit: null,
      loadMaterials: [],
      marker: null,
      labels: [],
      grid: null,
      ground: null,
    };
    contextRef.current = context;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      labelRenderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const clock = new THREE.Clock();
    const animate = () => {
      if (context.disposed) return;
      context.raf = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();
      const pulse = 0.72 + Math.sin(elapsed * 2.4) * 0.2;
      context.loadMaterials.forEach((mat) => {
        mat.opacity = pulse;
      });
      if (context.marker) {
        const scale = 1 + Math.sin(elapsed * 3.1) * 0.12;
        context.marker.scale.setScalar(scale);
      }
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();

    return () => {
      context.disposed = true;
      cancelAnimationFrame(context.raf);
      observer.disconnect();
      controls.dispose();
      disposeObject(modelGroup);
      disposeObject(edgeGroup);
      disposeObject(annotationGroup);
      for (const label of context.labels) label.element.remove();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
      contextRef.current = null;
    };
  }, []);

  const fitCamera = (preset: CameraPreset = cameraPreset) => {
    const context = contextRef.current;
    if (!context || !geometry) return;
    const { camera, controls } = context;
    const center = new THREE.Vector3(
      (geometry.bbox.min[0] + geometry.bbox.max[0]) / 2,
      (geometry.bbox.min[1] + geometry.bbox.max[1]) / 2,
      (geometry.bbox.min[2] + geometry.bbox.max[2]) / 2,
    );
    const size = new THREE.Vector3(
      geometry.bbox.max[0] - geometry.bbox.min[0],
      geometry.bbox.max[1] - geometry.bbox.min[1],
      geometry.bbox.max[2] - geometry.bbox.min[2],
    );
    const radius = Math.max(size.length() * 0.5, 20);
    const dirs: Record<CameraPreset, THREE.Vector3> = {
      iso: new THREE.Vector3(1, -1.15, 0.82).normalize(),
      front: new THREE.Vector3(0, -1, 0.04).normalize(),
      top: new THREE.Vector3(0.001, 0, 1).normalize(),
      side: new THREE.Vector3(1, 0, 0.05).normalize(),
    };
    const dir = dirs[preset];
    camera.up.set(0, 0, 1);
    if (preset === 'top') camera.up.set(0, 1, 0);
    camera.position.copy(center).addScaledVector(dir, radius * 3.55);
    camera.near = Math.max(0.5, radius / 200);
    camera.far = radius * 40;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = radius * 0.35;
    controls.maxDistance = radius * 12;
    controls.update();
    setCameraPreset(preset);
  };

  useEffect(() => {
    const context = contextRef.current;
    if (!context || !geometry) return;
    if (!context.lastFit) {
      fitCamera('iso');
      context.lastFit = geometry.watermark;
    } else if (autoFit && context.lastFit !== geometry.watermark) {
      fitCamera(cameraPreset);
      context.lastFit = geometry.watermark;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, autoFit]);

  useEffect(() => {
    const context = contextRef.current;
    if (!context || !geometry) return;
    disposeObject(context.modelGroup);
    disposeObject(context.edgeGroup);
    context.modelGroup.clear();
    context.edgeGroup.clear();
    context.loadMaterials = [];
    const showResult = viewMode === 'result' && analysis;
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3));
    base.setIndex(new THREE.BufferAttribute(geometry.indices, 1));

    if (showResult && analysis) {
      const projected = projectField(geometry, analysis, field, deformationScale, material.yieldStrength);
      const resultGeometry = new THREE.BufferGeometry();
      resultGeometry.setAttribute('position', new THREE.BufferAttribute(projected.positions, 3));
      resultGeometry.setAttribute('color', new THREE.BufferAttribute(projected.colors, 3));
      resultGeometry.setIndex(new THREE.BufferAttribute(geometry.indices, 1));
      resultGeometry.computeVertexNormals();
      const materialResult = new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.18,
        roughness: 0.52,
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(resultGeometry, materialResult);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      context.modelGroup.add(mesh);
      if (showEdges) {
        const edges = new THREE.EdgesGeometry(resultGeometry, 32);
        const line = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({
            color: 0x1a1d18,
            transparent: true,
            opacity: 0.23,
            depthWrite: false,
          }),
        );
        context.edgeGroup.add(line);
      }
    } else {
      const creased = toCreasedNormals(base, Math.PI / 7);
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(material.color),
        metalness: 0.62,
        roughness: 0.33,
        envMapIntensity: 0.8,
      });
      const mesh = new THREE.Mesh(creased, bodyMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      context.modelGroup.add(mesh);
      if (showEdges) {
        const edges = new THREE.EdgesGeometry(base, 28);
        const line = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({
            color: 0x33372f,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        );
        context.edgeGroup.add(line);
      }
    }
    base.dispose();

    const size = Math.max(
      geometry.bbox.max[0] - geometry.bbox.min[0],
      geometry.bbox.max[1] - geometry.bbox.min[1],
      geometry.bbox.max[2] - geometry.bbox.min[2],
    );
    if (!context.ground) {
      const groundGeometry = new THREE.PlaneGeometry(size * 7, size * 7);
      const groundMaterial = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.34 });
      const ground = new THREE.Mesh(groundGeometry, groundMaterial);
      ground.receiveShadow = true;
      ground.position.z = geometry.bbox.min[2] - 0.5;
      context.scene.add(ground);
      context.ground = ground;
      const grid = new THREE.GridHelper(size * 6, 48, 0x596052, 0x343a30);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(
        (geometry.bbox.min[0] + geometry.bbox.max[0]) / 2,
        (geometry.bbox.min[1] + geometry.bbox.max[1]) / 2,
        geometry.bbox.min[2] - 0.35,
      );
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMaterials.forEach((mat) => {
        mat.transparent = true;
        mat.opacity = 0.26;
      });
      context.scene.add(grid);
      context.grid = grid;
    } else {
      context.ground.position.z = geometry.bbox.min[2] - 0.5;
    }
    context.edgeGroup.visible = showEdges;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, analysis, viewMode, field, deformationScale, material, showEdges]);

  useEffect(() => {
    const context = contextRef.current;
    if (!context) return;
    context.edgeGroup.visible = showEdges;
  }, [showEdges]);

  useEffect(() => {
    const context = contextRef.current;
    if (!context || !geometry) return;
    for (const label of context.labels) label.element.remove();
    context.labels = [];
    disposeObject(context.annotationGroup);
    context.annotationGroup.clear();
    context.annotationGroup.visible = showAnnotations;
    context.loadMaterials = [];
    context.marker = null;
    if (!showAnnotations) return;

    const support = model.supports[0];
    if (support) {
      const supportGroup = makeSupportPlane(geometry.bbox, support.face);
      context.annotationGroup.add(supportGroup);
      const center = loadFaceCenter(geometry, support.face);
      const offset = new THREE.Vector3(
        support.face.endsWith('min') ? -7 : support.face.endsWith('max') ? 7 : 0,
        support.face.startsWith('y') ? (support.face.endsWith('min') ? -7 : 7) : 0,
        support.face.startsWith('z') ? (support.face.endsWith('min') ? -7 : 7) : 0,
      );
      const label = makeLabel(
        'scene-label--fixed',
        '<span class="scene-label__dot"></span><span><b>FIXED</b><small>6 DOF · ' +
          (support.face === 'x-min' ? '背板' : support.face) +
          '</small></span>',
        center.clone().add(offset),
      );
      context.annotationGroup.add(label);
      context.labels.push(label);
    }

    const load = model.loads[0];
    if (load) {
      const center = loadFaceCenter(geometry, load.face);
      const dir = new THREE.Vector3(load.vector[0], load.vector[1], load.vector[2]).normalize();
      const faceNormal =
        load.face === 'x-min'
          ? new THREE.Vector3(-1, 0, 0)
          : load.face === 'x-max'
            ? new THREE.Vector3(1, 0, 0)
            : load.face === 'y-min'
              ? new THREE.Vector3(0, -1, 0)
              : load.face === 'y-max'
                ? new THREE.Vector3(0, 1, 0)
                : load.face === 'z-min'
                  ? new THREE.Vector3(0, 0, -1)
                  : new THREE.Vector3(0, 0, 1);
      const offset = faceNormal.clone().multiplyScalar(12);
      const span = Math.max(
        geometry.bbox.max[1] - geometry.bbox.min[1],
        geometry.bbox.max[2] - geometry.bbox.min[2],
      );
      const spread = Math.min(26, span * 0.22);
      const lateral = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, 1));
      if (lateral.lengthSq() < 0.01) lateral.set(0, 1, 0);
      lateral.normalize();
      for (const factor of [-1, 0, 1]) {
        const origin = center
          .clone()
          .add(offset)
          .addScaledVector(lateral, factor * spread)
          .addScaledVector(dir, -18);
        const arrow = new THREE.ArrowHelper(dir, origin, 18, 0xff7253, 7, 3.4);
        const materials = Array.isArray(arrow.line.material) ? arrow.line.material : [arrow.line.material];
        const coneMaterial = Array.isArray(arrow.cone.material) ? arrow.cone.material : [arrow.cone.material];
        for (const mat of [...materials, ...coneMaterial]) {
          if (mat instanceof THREE.MeshBasicMaterial) {
            mat.transparent = true;
            mat.opacity = 0.9;
            context.loadMaterials.push(mat);
          }
          if (mat instanceof THREE.LineBasicMaterial) {
            mat.transparent = true;
            mat.opacity = 0.9;
          }
        }
        context.annotationGroup.add(arrow);
      }
      const label = makeLabel(
        'scene-label--load',
        `<span class="scene-label__glyph">↓</span><span><b>${load.magnitude.toFixed(0)} N</b><small>LOAD · ${load.face}</small></span>`,
        center.clone().add(offset).addScaledVector(dir, -6).addScaledVector(lateral, spread + 18),
      );
      context.annotationGroup.add(label);
      context.labels.push(label);
    }

    if (viewMode === 'result' && analysis) {
      const location = new THREE.Vector3(
        analysis.maxVonMisesLocation[0],
        analysis.maxVonMisesLocation[1],
        analysis.maxVonMisesLocation[2],
      );
      const markerMaterial = new THREE.MeshBasicMaterial({
        color: 0xff5b45,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      });
      const marker = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 16), markerMaterial);
      marker.position.copy(location);
      marker.renderOrder = 8;
      context.annotationGroup.add(marker);
      context.marker = marker;
      const label = makeLabel(
        'scene-label--critical',
        `<span class="scene-label__dot scene-label__dot--hot"></span><span><b>${analysis.maxVonMises.toFixed(1)} MPa</b><small>CRITICAL · VON MISES</small></span>`,
        location.clone().add(new THREE.Vector3(8, 0, 8)),
      );
      context.annotationGroup.add(label);
      context.labels.push(label);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, model, analysis, viewMode, field, showAnnotations]);

  return (
    <div className="scene-viewport" ref={containerRef}>
      <div className="scene-vignette" />
      <div className="view-toolbar" role="toolbar" aria-label="视图控制">
        <button
          type="button"
          className={cameraPreset === 'iso' ? 'is-active' : ''}
          onClick={() => fitCamera('iso')}
          title="等轴测视图"
        >
          <Box size={15} />
        </button>
        <button
          type="button"
          className={cameraPreset === 'front' ? 'is-active' : ''}
          onClick={() => fitCamera('front')}
          title="前视图"
        >
          <Scan size={15} />
        </button>
        <button
          type="button"
          className={cameraPreset === 'top' ? 'is-active' : ''}
          onClick={() => fitCamera('top')}
          title="顶视图"
        >
          <Crosshair size={15} />
        </button>
        <span className="view-toolbar__divider" />
        <button type="button" onClick={() => fitCamera(cameraPreset)} title="适配视图">
          <Maximize2 size={15} />
        </button>
        <button type="button" className={showEdges ? 'is-active' : ''} onClick={onToggleEdges} title="边线">
          {showEdges ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button
          type="button"
          className={showAnnotations ? 'is-active' : ''}
          onClick={onToggleAnnotations}
          title="边界条件标注"
        >
          <Tag size={15} />
        </button>
      </div>
    </div>
  );
}
