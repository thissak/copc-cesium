export interface BenchResult {
  label: 'ours' | 'eptium';
  url: string;
  ok: boolean;
  error?: string;
  glRenderer: string; // 실GPU vs swiftshader 증거
  // 정규화 증인
  msse: number;
  pointsSelected: number;
  pointsLength: number; // COPC point-cloud tilesets: pointsLength; standard 3D Tiles: numberOfPointsSelected
  tilesReady: number;
  tilesTotal: number;
  bsRadius: number;
  // tier 1a (북극성)
  ttdMs: number;
  bytesTotal: number;
  reqCount: number;
  peakHeapMB: number;
  // tier 1b (보조)
  frametimeMs: { p50: number; p95: number; p99: number };
  hitchesGt50: number;
  longTaskTotalMs: number;
  // tier 2 (실GPU 보조)
  fpsFromP50: number;
}

export interface BenchMeta {
  dataset: string;
  datasetUrl: string;
  msse: number;
  secs: number;
  throttle: string;
  timestamp: string;
}

export interface BenchConfig {
  ds: string; // dataset id: autzen | millsite | sofi
  msse: number;
  /** 매칭 점수 비교용 per-target msse 오버라이드. 없으면 msse 공통 적용. */
  msseOurs?: number;
  msseEptium?: number;
  secs: number;
  throttle: 'none' | 'fast3g';
  /** settle 판정 타임아웃(ms). 깊은 매칭점(고밀도)은 늘린다. 기본 25000. */
  settleMs: number;
  targets: Array<'ours' | 'eptium'>;
}
