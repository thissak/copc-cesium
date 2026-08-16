# 데모 녹화 핸드오프 — GPU 머신에서 시연 소재 확보

> 대상: 이 저장소를 클론한 **GPU 워크스테이션의 에이전트**.
> 이 문서는 절차서가 아니라 **목표·제약·검증 기준**이다. 그 안에서 방법은 스스로 정한다.

## 1. 왜 이 작업이 따로 존재하는가

기존 시연 소재는 headless Chromium으로 녹화됐고, 그건 GPU가 아니라 **소프트웨어 래스터라이저**로 그린 화면이다. 같은 머신 실측:

```
headless : ANGLE (SwiftShader driver)              10 FPS
headed   : ANGLE Metal Renderer, Apple M4 Pro      60 FPS
```

이 라이브러리의 핵심 주장이 "무거운 포인트클라우드를 부드럽게 스트리밍한다"인데, 소재가 10 FPS로 찍혀 있으면 주장과 증거가 어긋난다. **그래서 실제 GPU가 있는 머신에서 다시 찍는다.** 그게 이 작업의 전부다.

## 2. 산출물

`docs/submission/video/assets/raw/` 아래 webm 4종. (이 경로는 gitignore 대상이라 git으로 돌아오지 않는다 — 파일을 직접 전달할 것.)

| 컷 | 증명해야 하는 것 |
|---|---|
| **hero** | 원본 RGB 포인트클라우드가 지구본 위 실제 위치에서 부드럽게 돈다 |
| **style** | `window.__copcStyle(true)` 로 분류별 색상이 **한 컷 안에서** 전환된다 |
| **pick** | 점을 클릭하면 경위도·고도·`Classification`·`Intensity` 가 패널에 뜬다 |
| **large** | 1.9GB SoFi 데이터가 같은 API로 스트리밍되고, 줌인하면 디테일이 채워진다 |

**style·pick이 이 영상의 핵심이다.** 반환값이 표준 `Cesium3DTileset`이라서 Cesium의 스타일 언어와 피킹이 그대로 동작한다는 뜻이고, 자체 렌더 파이프라인을 쓰는 구현은 이걸 보여줄 수 없다. 나머지 둘은 맥락이다.

## 3. 하드 제약 (타협 불가)

1. **소프트웨어 렌더링으로 찍힌 소재는 폐기 대상이다.**
   녹화 시작 전 `UNMASKED_RENDERER_WEBGL`을 읽어 확인하고, `SwiftShader`/`llvmpipe`가 잡히면 **진행하지 말고 중단**할 것. 조용히 찍어 넘기면 이 작업을 한 의미가 없다.
   ```js
   const gl = document.createElement('canvas').getContext('webgl2');
   const dbg = gl.getExtension('WEBGL_debug_renderer_info');
   gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);   // NVIDIA / D3D11 이어야 한다
   ```
2. **1920×1080.** 1280×720에서 Cesium이 `DeveloperError: Expected width to be greater than 0`로 렌더를 멈추는 것을 확인했다(원인 미규명, 회피만 검증).
3. **화면에 남기지 않을 것**: Cesium 툴바·네비게이션 도움말 패널·전체화면 버튼·ion 크레딧, 그리고 `demo/main.ts`가 만드는 좌상단 측정 HUD(`z-index: 999`), FPS 카운터.
   단 **pick 컷에서는 `#pick-panel`을 남긴다** — 그게 그 컷의 주인공이다.
4. **카메라는 스크립트로 구동.** 마우스 드래그 녹화는 흔들려서 못 쓴다.

## 4. 스스로 판단할 것

아래는 지시하지 않는다. 화면을 보고 더 나아 보이는 쪽으로 정하면 된다.

- 컷별 길이, 카메라 궤적(heading/pitch/range), 이징
- 프레이밍 — **다만 기존 소재의 가장 큰 결함이 이것이다.** `viewer.zoomTo()` 기본값은 대상을 화면 하단 1/3로 몰아넣고 나머지를 빈 배경으로 남긴다. `camera.lookAt(boundingSphere.center, { range })` 로 직접 잡는 편이 낫다.
- style 컷에서 색상 전환 전후로 얼마나 머무를지, 왕복할지
- pick 컷에서 어느 점을 클릭할지 (속성값이 잘 읽히는 지점)
- large 컷에서 로딩 구간을 배속할지 (배속하면 화면에 `2×` 표기 필요)
- 데이터셋 추가/교체 (`demo/datasets.ts`에 autzen 77MB · millsite 1.35GB · sofi 1.9GB)
- 기존 녹화 스크립트를 고쳐 쓸지, 새로 짤지

판단이 갈리면 **"심사자가 이 컷 하나만 본다면 무엇이 남는가"**를 기준으로 정할 것.

## 5. 검증 기준

- [ ] 4개 컷 모두 렌더러가 SwiftShader/llvmpipe가 **아님** (로그로 남길 것)
- [ ] 녹화 중 관측 FPS가 30 이상
- [ ] style 컷에서 색상 변화가 **하나의 연속 컷 안에서** 일어남 (별도 클립 이어붙이기 아님)
- [ ] pick 컷에서 패널의 `Classification`·`Intensity` 값이 1080p에서 판독 가능
- [ ] 4개 컷 모두 §3의 UI 요소가 화면에 없음 (pick 패널 제외)
- [ ] 포인트클라우드가 프레임의 절반 이상을 차지 (빈 배경이 지배하지 않음)
- [ ] `ffprobe -v error <file>` 무출력 (디코딩 오류 0)

## 6. 함정 (먼저 읽으면 시간을 아낀다)

- **dev 서버가 `127.0.0.1`에 안 뜬다.** Vite 8이 `localhost`(IPv6)로만 바인딩한다. 구 녹화 스크립트 기본값이 `http://127.0.0.1:5173`이라 그대로 쓰면 연결 실패. `npm run dev -- --host` 를 쓰거나 URL을 `localhost`로.
- **스타일 토글 훅은 기본 데모 페이지에만 있다.** `?bench`/`?soak`/`?perf`/`?naive` 경로에는 없다. `window.__copcStyle`이 정의될 때까지 기다린 뒤 진행할 것.
- **SoFi는 1.9GB다.** 첫 로드에 네트워크 시간이 걸린다. 한 번 예열해 캐시된 뒤 찍을 것.
- **ion 토큰이 없으면 베이스맵이 없다.** 배경이 단색이 된다. `.env`의 `VITE_CESIUM_ION_TOKEN`이 있으면 지형·위성이 붙어 화면이 훨씬 낫다. 없으면 프레이밍으로 빈 배경을 줄일 것.
- **피킹 패널은 이미 구현돼 있다** (`demo/pick-panel.ts`). 새로 만들 필요 없다. 클릭하면 뜬다.

## 7. 참고 위치

| | |
|---|---|
| 데모 진입점 | `demo/main.ts` (`runDemo`) |
| 스타일 토글 | `demo/main.ts` `installStyleToggle` — 키 `c` 또는 `window.__copcStyle(bool)` |
| 피킹 패널 | `demo/pick-panel.ts` |
| 데이터셋 | `demo/datasets.ts` |
| 구 녹화 스크립트 | `scripts/video/record-demo.mjs` — **headless로 찍는 구버전이라 그대로 쓰면 안 된다.** 다만 `orbit()`(`camera.lookAt` 보간) 헬퍼와 UI 숨김 CSS는 재사용할 만하다 |
| 합성·렌더 스크립트 | `scripts/video/render-{narration,composition,final}.mjs` — 다른 머신에서 도는 것들. 여기서 실행할 필요 없다(macOS `say` TTS + darwin ffmpeg 의존) |

## 8. 끝나면

녹화 결과 webm과 함께 다음을 보고할 것: 각 컷의 **렌더러 문자열·관측 FPS·길이**, 그리고 §5 체크리스트 결과. 소재는 다른 머신에서 합성·렌더에 쓰인다.
