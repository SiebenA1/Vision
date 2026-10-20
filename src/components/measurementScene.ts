import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { CadInspection } from '../services/engineeringBackend';
import type { GeometryData } from '../core/types';
import { groupMeasurementLabels, measurementValue, placeMeasurementLabel, type LabelRect } from '../core/cad/measurementLabels';

/** Native coordinates provide anchors; screen layout only moves the text cards. */
export function attachMeasurementAnnotations(scene: THREE.Scene, camera: THREE.PerspectiveCamera, container: HTMLElement, geometry: GeometryData, result: CadInspection) {
  const root = new THREE.Group();
  const bounds = new THREE.Box3(new THREE.Vector3(...geometry.bbox.min), new THREE.Vector3(...geometry.bbox.max));
  const center = bounds.getCenter(new THREE.Vector3());
  const span = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1e-6);
  const line = (points: THREE.Vector3[]) => {
    root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x7ceaf0, depthTest: false, transparent: true, opacity: .65 })));
  };
  const groups = groupMeasurementLabels(result.properties);
  if (!result.selection.length) groups.sort((a, b) => Number(!!b.dimension) - Number(!!a.dimension));
  // Additional parameters remain in the selected-object details; keep leaders local.
  const labels = groups.slice(0, 3).map(group => {
    const anchor = new THREE.Vector3(...group.anchor);
    if (group.dimension) {
      const start = new THREE.Vector3(...group.dimension.start), end = new THREE.Vector3(...group.dimension.end);
      const distance = start.distanceTo(end);
      const direction = end.clone().sub(start).normalize();
      const offset = new THREE.Vector3();
      if (group.dimension.offset && distance > 1e-10) {
        offset.copy(anchor).sub(center);
        offset.addScaledVector(direction, -offset.dot(direction));
        if (offset.lengthSq() > 1e-12) offset.normalize().multiplyScalar(span * .065);
      }
      const from = start.clone().add(offset), to = end.clone().add(offset);
      anchor.copy(from).lerp(to, .5);
      if (distance > 1e-10) {
        line([start, from]); line([end, to]);
        const head = Math.min(distance * .15, span * .016);
        root.add(new THREE.ArrowHelper(direction, from, distance, 0x7ceaf0, head, head * .42));
        root.add(new THREE.ArrowHelper(direction.clone().negate(), to, distance, 0x7ceaf0, head, head * .42));
      }
    }
    const element = document.createElement('div');
    element.className = 'measurement-callout';
    element.dataset.anchor = JSON.stringify(group.anchor);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('measurement-callout__leader');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.append(path);
    const dot = document.createElement('i'); dot.className = 'measurement-callout__dot';
    const card = document.createElement('div'); card.className = 'measurement-callout__card';
    for (const property of group.properties) {
      const row = document.createElement('div');
      const label = document.createElement('span'); label.textContent = property.label;
      const value = document.createElement('strong'); value.textContent = measurementValue(property, true);
      row.append(label, value);
      row.title = [property.nativeLabel, property.reason, property.method].filter(Boolean).join(' · ');
      card.append(row);
    }
    element.append(svg, dot, card);
    const label = new CSS2DObject(element);
    label.center.set(0, 0); label.position.copy(anchor); root.add(label);
    return { label, anchor, card, path, element, offset: null as { x: number; y: number } | null };
  });
  root.traverse(object => {
    object.renderOrder = 12;
    const renderable = object as THREE.Mesh;
    const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
    for (const material of materials) if (material) { material.depthTest = false; material.depthWrite = false; }
  });
  scene.add(root);
  return {
    update: () => {
      const viewport = container.getBoundingClientRect();
      const occupied: LabelRect[] = [];
      for (const element of container.querySelectorAll('.measurement-hud, .view-toolbar, .measurement-hint, .scene-label')) {
        const r = element.getBoundingClientRect();
        if (r.width && r.height) occupied.push({ x: r.left - viewport.left, y: r.top - viewport.top, width: r.width, height: r.height });
      }
      for (const item of labels) {
        const projected = item.anchor.clone().project(camera);
        if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.1 || Math.abs(projected.y) > 1.1) {
          item.element.style.visibility = 'hidden'; continue;
        }
        const anchor = { x: (projected.x + 1) * viewport.width / 2, y: (1 - projected.y) * viewport.height / 2 };
        const size = { width: item.card.offsetWidth, height: item.card.offsetHeight };
        const preferred = item.offset ? { x: anchor.x + item.offset.x, y: anchor.y + item.offset.y, ...size } : undefined;
        const rect = placeMeasurementLabel(anchor, size, viewport, occupied, preferred);
        item.element.style.visibility = rect ? 'visible' : 'hidden';
        if (!rect) continue;
        occupied.push(rect);
        item.offset = { x: rect.x - anchor.x, y: rect.y - anchor.y };
        item.card.style.transform = `translate(${rect.x - anchor.x}px, ${rect.y - anchor.y}px)`;
        const endX = rect.x > anchor.x ? rect.x : rect.x + rect.width;
        const endY = Math.max(rect.y + 8, Math.min(anchor.y, rect.y + rect.height - 8));
        const x = endX - anchor.x, y = endY - anchor.y;
        item.path.setAttribute('d', `M 0 0 L ${x * .55} 0 L ${x} ${y}`);
      }
    },
    dispose: () => {
      root.removeFromParent();
      for (const item of labels) item.element.remove();
      root.traverse(object => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material?.dispose();
      });
    },
  };
}
