// scripts/bench/fair-types.ts
export interface ConfigSnapshot {
  edl: boolean;
  attenuation: boolean;
  resolutionScale: number;
  canvasW: number;
  canvasH: number;
  globeShow: boolean;
}
export interface Sample {
  pointsSelected: number;
  frametimeMs: { p50: number; p95: number; p99: number };
  fps: number;
  gpuMs: number | null; // p50 GPU ms (timer query). null = disjoint/미가용 → verdict 제외
  hitches: number;
  peakHeapMB: number;
  cesiumMB: number;
  settleMs: number;
  tilesReady: number;
}
export interface PointResult { target: number; trials: Sample[]; median: Sample; iqrGpuMs: number }
export interface ViewerResult { label: 'ours' | 'eptium'; glRenderer: string; points: PointResult[] }
export interface ValidityGates {
  gpuMsOk: boolean;     // 양쪽 GPU ms 측정 성공(disjoint 아님)
  configHeld: boolean;  // 양쪽 config readback 일치(throw 안 함)
  overlapOk: boolean;   // 공통 점 버킷 충분(>=3)
  nullTestOk: boolean;  // ours-vs-ours = 동급
}
export interface CurvePoint { pts: number; gpuMs: number; n: number }
export interface ViewerCurve { label: 'ours' | 'eptium'; glRenderer: string; gpuOk: boolean; finalPts: number; curve: CurvePoint[] }
