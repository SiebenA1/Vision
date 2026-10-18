import type {
  AnalysisResult,
  ModelDocument,
  OptimizerCandidate,
  OptimizationResult,
} from '../types';
import { buildGeometry } from '../geometry/kernel';
import { SimulationClient } from '../fea/client';
import { getMaterial } from '../materials';

export interface OptimizerProgress {
  stage: 'baseline' | 'screen' | 'refine' | 'verify' | 'done';
  completed: number;
  total: number;
  message: string;
  candidate?: OptimizerCandidate;
}

interface OptimizeOptions {
  variableKey: string;
  targetSafety: number;
  displacementLimit: number;
  onProgress?: (progress: OptimizerProgress) => void;
  coarseElements?: number;
}

interface Evaluation {
  candidate: OptimizerCandidate;
  result: AnalysisResult;
}

function snap(value: number, min: number, max: number, step: number): number {
  const snapped = Math.round((value - min) / step) * step + min;
  return Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
}

async function evaluateCandidate(
  client: SimulationClient,
  model: ModelDocument,
  variableKey: string,
  value: number,
  targetSafety: number,
  displacementLimit: number,
  targetElements: number,
  tolerance: number,
): Promise<Evaluation> {
  const candidateModel = structuredClone(model);
  const variable = candidateModel.variables.find((item) => item.key === variableKey);
  if (!variable) throw new Error(`未知设计变量：${variableKey}`);
  variable.value = value;
  const { geometry } = await buildGeometry(candidateModel);
  const result = await client.solve(geometry, candidateModel, getMaterial(candidateModel.materialId), {
    meshOverride: { targetElements, tolerance },
    studyName: `OPT · ${variable.label} = ${value}`,
  });
  const feasible = result.safetyFactor >= targetSafety && result.maxDisplacement <= displacementLimit;
  return {
    candidate: {
      value,
      massKg: result.massKg,
      safetyFactor: result.safetyFactor,
      maxDisplacement: result.maxDisplacement,
      feasible,
      status: 'screened',
    },
    result,
  };
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => Number(value.toFixed(4))))].sort((a, b) => a - b);
}

/**
 * Bounded design-space search with FE-in-the-loop screening and a fine-mesh
 * verification pass. Screening solves run concurrently across a small local
 * worker pool; the final candidate is always re-solved at the study mesh size.
 * Objective: exact CAD mass. Constraints: yield safety factor and displacement.
 */
export async function runOptimization(
  model: ModelDocument,
  options: OptimizeOptions,
): Promise<OptimizationResult> {
  const started = performance.now();
  const variable = model.variables.find((item) => item.key === options.variableKey);
  if (!variable) throw new Error(`未知设计变量：${options.variableKey}`);
  const targetSafety = Math.max(0.5, options.targetSafety);
  const displacementLimit = Math.max(0.01, options.displacementLimit);
  const coarseElements = options.coarseElements ?? Math.min(7000, model.mesh.targetElements);
  const evaluations = new Map<number, Evaluation>();
  const baselineValue = variable.value;

  const rawPlan = [0, 0.2, 0.4, 0.6, 0.8, 1].map((ratio) =>
    snap(variable.min + (variable.max - variable.min) * ratio, variable.min, variable.max, variable.step),
  );
  const screenValues = uniqueSorted([...rawPlan, baselineValue]);
  const totalPlanned = screenValues.length + 3;
  let completed = 0;
  let failures = 0;
  const report = (progress: OptimizerProgress) =>
    options.onProgress?.({ ...progress, completed, total: totalPlanned });

  const runEvaluation = async (
    client: SimulationClient,
    value: number,
    targetElements: number,
    tolerance: number,
    stage: OptimizerProgress['stage'],
  ) => {
    try {
      const evaluation = await evaluateCandidate(
        client,
        model,
        variable.key,
        value,
        targetSafety,
        displacementLimit,
        targetElements,
        tolerance,
      );
      evaluations.set(value, evaluation);
      completed += 1;
      report({
        stage,
        completed,
        total: totalPlanned,
        message: `${variable.label} ${value} mm · SF ${evaluation.result.safetyFactor.toFixed(2)} · ${evaluation.result.massKg.toFixed(3)} kg`,
        candidate: evaluation.candidate,
      });
    } catch (error) {
      failures += 1;
      completed += 1;
      report({
        stage,
        completed,
        total: totalPlanned,
        message: `${variable.label} ${value} mm · 求解失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const workerCount =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? Math.max(1, Math.min(3, Math.floor(navigator.hardwareConcurrency / 2)))
      : 2;
  const pool = Array.from({ length: workerCount }, () => new SimulationClient());
  let nextWorker = 0;
  const withClient = <T>(task: (client: SimulationClient) => Promise<T>): Promise<T> => {
    const client = pool[nextWorker % pool.length];
    nextWorker += 1;
    return task(client);
  };

  report({
    stage: 'baseline',
    completed,
    total: totalPlanned,
    message: `并行粗筛 · ${screenValues.length} 个设计点 · ${workerCount} 个本地求解器`,
  });

  try {
    await Promise.all(
      screenValues.map((value) =>
        withClient((client) =>
          runEvaluation(
            client,
            value,
            coarseElements,
            2e-4,
            value === baselineValue ? 'baseline' : 'screen',
          ),
        ),
      ),
    );

    const candidates = [...evaluations.values()].map((entry) => entry.candidate);
    const feasible = candidates.filter((candidate) => candidate.feasible);
    if (feasible.length > 0) {
      const best = feasible.reduce((a, b) => (a.massKg <= b.massKg ? a : b));
      const index = screenValues.indexOf(best.value);
      const lower = screenValues[Math.max(0, index - 1)] ?? variable.min;
      const lowerEvaluation = evaluations.get(lower)?.candidate;
      const refineValues =
        lower < best.value && lowerEvaluation && !lowerEvaluation.feasible
          ? uniqueSorted([
              snap(lower + (best.value - lower) * 0.65, variable.min, variable.max, variable.step),
              snap(lower + (best.value - lower) * 0.88, variable.min, variable.max, variable.step),
            ]).filter((value) => !evaluations.has(value))
          : [];

      await Promise.all(
        refineValues.map((value) =>
          withClient((client) => runEvaluation(client, value, coarseElements, 2e-4, 'refine')),
        ),
      );
    }

    const allCoarse = [...evaluations.values()].map((entry) => entry.candidate);
    const feasibleFinal = allCoarse.filter((candidate) => candidate.feasible);
    const bestCoarse = feasibleFinal.length
      ? feasibleFinal.reduce((a, b) => (a.massKg <= b.massKg ? a : b))
      : allCoarse.length
        ? allCoarse.reduce((a, b) => (a.safetyFactor >= b.safetyFactor ? a : b))
        : null;

    let recommended: OptimizerCandidate | null = null;
    let note = `${model.mesh.cellSizeMm ? `固定 h=${model.mesh.cellSizeMm} mm` : `${coarseElements.toLocaleString('en-US')} EL`} C3D8 网格 · ${workerCount} 路并行 FE；推荐解经过最终复核。`;
    if (bestCoarse?.feasible) {
      const verificationQueue = feasibleFinal
        .slice()
        .sort((a, b) => a.massKg - b.massKg)
        .slice(0, 3);
      for (const coarse of verificationQueue) {
        report({
          stage: 'verify',
          completed,
          total: totalPlanned,
          message: `目标网格复核 · ${variable.label} = ${coarse.value} mm`,
        });
        try {
          const verification = await evaluateCandidate(
            pool[0],
            model,
            variable.key,
            coarse.value,
            targetSafety,
            displacementLimit,
            model.mesh.targetElements,
            model.mesh.tolerance,
          );
          const verified: OptimizerCandidate = {
            ...coarse,
            massKg: verification.result.massKg,
            safetyFactor: verification.result.safetyFactor,
            maxDisplacement: verification.result.maxDisplacement,
            feasible:
              verification.result.safetyFactor >= targetSafety &&
              verification.result.maxDisplacement <= displacementLimit,
            status: verification.result.safetyFactor >= targetSafety &&
              verification.result.maxDisplacement <= displacementLimit
              ? 'verified'
              : 'screened',
          };
          completed += 1;
          const existing = allCoarse.find((candidate) => candidate.value === coarse.value);
          if (existing) {
            existing.status = verified.feasible ? 'verified' : 'screened';
            existing.safetyFactor = verified.safetyFactor;
            existing.maxDisplacement = verified.maxDisplacement;
            existing.feasible = verified.feasible;
          }
          if (verified.feasible) {
            recommended = verified;
            note += ` ${coarse.value} mm 通过目标网格复核。`;
            break;
          }
          note += ` ${coarse.value} mm 粗筛通过但细网格复核未通过，已回退到下一候选。`;
        } catch (error) {
          failures += 1;
          completed += 1;
          note += ` ${coarse.value} mm 细网格复核失败：${error instanceof Error ? error.message : String(error)}。`;
        }
      }
      if (!recommended) {
        note += ' 前三个质量最优候选均未通过细网格复核。';
      }
    } else if (allCoarse.length === 0) {
      note += ' 所有候选点均求解失败。';
    } else {
      note += ' 在变量边界内未找到同时满足安全系数与位移约束的解。';
    }
    if (failures > 0) note += ` 共 ${failures} 个候选点求解失败。`;

    const baseline = evaluations.get(baselineValue)?.candidate ?? {
      value: baselineValue,
      massKg: 0,
      safetyFactor: 0,
      maxDisplacement: 0,
      feasible: false,
      status: 'screened' as const,
    };
    const massDeltaPercent = recommended
      ? ((recommended.massKg - baseline.massKg) / Math.max(baseline.massKg, 1e-9)) * 100
      : null;
    completed = totalPlanned;
    report({
      stage: 'done',
      completed,
      total: totalPlanned,
      message: recommended ? `优化完成 · 推荐 ${recommended.value} mm` : '优化完成 · 无可行解',
    });

    return {
      objective: 'min-mass',
      variableKey: variable.key,
      variableLabel: variable.label,
      targetSafety,
      displacementLimit,
      candidates: [...evaluations.values()].map((entry) => entry.candidate).sort((a, b) => a.value - b.value),
      recommended,
      baseline,
      massDeltaPercent,
      elapsedMs: performance.now() - started,
      note,
    };
  } finally {
    for (const client of pool) client.dispose();
  }
}
