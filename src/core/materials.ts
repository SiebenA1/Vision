export interface MaterialSpec {
  id: string;
  name: string;
  shortName: string;
  standard: string;
  family: 'aluminium' | 'steel' | 'titanium' | 'polymer';
  E: number;
  nu: number;
  rho: number;
  yieldStrength: number;
  ultimateStrength: number;
  thermalExpansion: number;
  color: string;
  finish: string;
  note: string;
  validated: boolean;
}

/**
 * Engineering material database.
 *
 * Units are strictly: E / yield / ultimate in MPa, density in kg/m³,
 * coefficient of thermal expansion in 1/K. Properties are nominal,
 * room-temperature, isotropic values for preliminary sizing only.
 */
export const MATERIALS: MaterialSpec[] = [
  {
    id: 'AL6061-T6',
    name: '铝合金 6061-T6',
    shortName: 'AL 6061-T6',
    standard: 'ASTM B209 / AMS-QQ-A-250/11',
    family: 'aluminium',
    E: 68_900,
    nu: 0.33,
    rho: 2700,
    yieldStrength: 276,
    ultimateStrength: 310,
    thermalExpansion: 23.6e-6,
    color: '#b7c0c1',
    finish: '阳极氧化 / 喷砂',
    note: '通用结构铝合金；焊接热影响区需折减。',
    validated: true,
  },
  {
    id: 'AL7075-T6',
    name: '铝合金 7075-T6',
    shortName: 'AL 7075-T6',
    standard: 'ASTM B209',
    family: 'aluminium',
    E: 71_700,
    nu: 0.33,
    rho: 2810,
    yieldStrength: 503,
    ultimateStrength: 572,
    thermalExpansion: 23.6e-6,
    color: '#a8b1b1',
    finish: '硬质阳极氧化',
    note: '高强度、低延展性；不推荐作为焊接结构。',
    validated: true,
  },
  {
    id: 'STEEL-4340',
    name: '合金钢 AISI 4340',
    shortName: 'AISI 4340',
    standard: 'ASTM A29 / AMS 6414',
    family: 'steel',
    E: 205_000,
    nu: 0.29,
    rho: 7850,
    yieldStrength: 470,
    ultimateStrength: 745,
    thermalExpansion: 12.3e-6,
    color: '#8f9698',
    finish: '发黑 / 镀锌',
    note: '调质态名义值；疲劳设计需依据实际热处理。',
    validated: true,
  },
  {
    id: 'TI64',
    name: '钛合金 Ti-6Al-4V',
    shortName: 'Ti-6Al-4V',
    standard: 'AMS 4911',
    family: 'titanium',
    E: 113_800,
    nu: 0.342,
    rho: 4430,
    yieldStrength: 880,
    ultimateStrength: 950,
    thermalExpansion: 8.6e-6,
    color: '#9da3a4',
    finish: '喷丸 / 钝化',
    note: '高比强度；比刚度低于钢，屈曲需单独校核。',
    validated: true,
  },
  {
    id: 'PA12-GF',
    name: '玻纤增强尼龙 PA12-GF',
    shortName: 'PA12-GF',
    standard: '供应商数据 / 等效各向同性',
    family: 'polymer',
    E: 6000,
    nu: 0.35,
    rho: 1250,
    yieldStrength: 105,
    ultimateStrength: 130,
    thermalExpansion: 25e-6,
    color: '#d6d2c6',
    finish: 'SLS 打印 / 染色',
    note: '各向同性等效模型；纤维取向与实际打印方向会显著影响强度。',
    validated: false,
  },
];

export const DEFAULT_MATERIAL_ID = 'AL6061-T6';

export function getMaterial(id: string): MaterialSpec {
  return MATERIALS.find((material) => material.id === id) ?? MATERIALS[0];
}

export function massFromVolume(volumeMm3: number, densityKgM3: number): number {
  return (volumeMm3 * 1e-9) * densityKgM3;
}

export function safetyFactor(yieldStrength: number, vonMises: number): number {
  if (!Number.isFinite(vonMises) || vonMises <= 1e-9) return Number.POSITIVE_INFINITY;
  return yieldStrength / vonMises;
}

export function materialOptionsByFamily(): Array<{ family: string; label: string; items: MaterialSpec[] }> {
  const labels: Record<MaterialSpec['family'], string> = {
    aluminium: '铝合金',
    steel: '钢',
    titanium: '钛合金',
    polymer: '聚合物',
  };
  return (['aluminium', 'steel', 'titanium', 'polymer'] as const).map((family) => ({
    family,
    label: labels[family],
    items: MATERIALS.filter((material) => material.family === family),
  }));
}
