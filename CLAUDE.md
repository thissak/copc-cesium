# copc-cesium — 운영 규칙

COPC 포인트클라우드를 사전 변환 없이 CesiumJS에 직접 렌더하는 오픈소스 플러그인.
배포 패키지 = `@goldenlabs/copc-cesium` (npm, Apache-2.0). SSOT는 이 파일 → `docs/PROGRESS.md` → `docs/CHANGELOG.md` 순.

## 빌드 / 실행

```bash
npm install
npm run dev      # 개발 서버 (http://localhost:5173)
npm run build    # tsc + 프로덕션 번들
npm test         # 헤드리스 테스트 (오프라인 unit · test:integration=S3 통합 · test:all)
npm run verify   # 헤드리스 정확성·timings 검증 (Node)
npm run sweep    # 데이터축 성능 스윕 (Node)
npm run preview  # 빌드 결과 미리보기
npm run release  # .env(NPM_TOKEN) 로드 → build:lib → npm publish
```

npm 인증 토큰은 `.env`의 `NPM_TOKEN`(gitignore)에만 두고 `.npmrc`가 `${NPM_TOKEN}`로 참조한다(시크릿 미커밋).

브라우저: 기본 = `CopcTileset.fromUrl` 데모 · `?naive`(Phase1 baseline) · `?bench`(fps 벽) · `?perf`/`?soak`(스트리밍 측정). 데모/랩 코드는 `demo/`.
공개 API: `src/copc-tileset.ts` (`CopcTileset.fromUrl(url, opts)`).

## 스택

- CesiumJS (렌더), copc.js(`copc`) + laz-perf(파싱/디코드), Vite + TypeScript.
- 디코드는 Web Worker(`comlink`), range 읽기 복원력은 `p-retry`(재시도+타임아웃).
- Cesium 정적 에셋은 `vite-plugin-cesium`가 처리.

## 코드 스타일

- TypeScript strict. 기존 파일 스타일을 따른다.
- 주변 코드를 "개선"하지 않는다. 변경 라인은 요청에 직결되어야 한다.

## 금지 / STOP 규칙

- **스트리밍 / LOD / 캐싱 / 상태동기화 / 워커 풀** 코드는 손코딩 전 STOP.
  먼저 (a) 기존 라이브러리/prior art가 푸는지 확인, (b) 손수 만든 primitive는 정당화.
  계획 + 검증기준(Acceptance Criteria) 제시 → 승인 후 착수.
- 추측으로 단정 금지. 병목/동작은 **측정**으로 말한다 (`docs/PROFILING.md` 4축).
- 대용량 COPC 원본을 repo에 커밋하지 않는다 (`data/`는 gitignore).

## 핵심 설계 (ADR-001 확정)

- 결과물 = `CopcTileset.fromUrl()` **Cesium provider 플러그인**. 아키텍처 = A안: COPC 옥트리를
  동적 Cesium3DTileset으로 노출, **LOD는 Cesium 위임**. 노드 content는 **서비스워커**가 온디맨드 공급.
  상세·근거는 `docs/adr/001-provider-plugin-architecture-A.md`.
