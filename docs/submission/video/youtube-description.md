# YouTube 업로드 문안

**영상 URL**: https://youtu.be/g3pzx97skDU  ✅ 업로드 완료·외부 접근 확인 (2026-08-16)
**파일**: `copc-cesium-demo.mp4` (2분 59초 · 1920×1080 · 30fps)

---

## 제목 (권장)

```
COPC 포인트클라우드를 변환 없이 CesiumJS에 스트리밍 — copc-cesium
```

> 현재 입력된 `copc cesium demo` 도 무방하나, 위 제목이 "무엇을 하는 것인지"를 바로 전달합니다.
> 2026 오픈소스 개발자대회 출품작임을 제목에 넣지 않은 이유: 검색·재사용 관점에서 기능이 먼저 읽히는 편이 낫습니다.

---

## 설명 (아래 전체를 복사)

```
LiDAR 포인트클라우드를 웹 지도에 올리려면 보통 원본을 3D Tiles로 미리 변환해야 합니다.
변환에는 시간이 들고, 같은 데이터를 두 벌로 저장해야 하며, 원본이 갱신될 때마다 다시 돌려야 합니다.

copc-cesium은 그 변환 단계를 없앱니다. COPC(.copc.laz) 파일을 HTTP Range 요청으로 직접 읽어
표준 Cesium3DTileset으로 노출하므로, LOD 스트리밍·컬링·GPU 메모리 관리는 CesiumJS가 원래 하던
방식 그대로 동작합니다.

  import { CopcTileset } from '@goldenlabs/copc-cesium';

  const tileset = await CopcTileset.fromUrl('https://…/cloud.copc.laz');
  viewer.scene.primitives.add(tileset);

■ 동작 방식
COPC의 옥트리를 동적 3D Tiles 트리로 노출하면, 어떤 노드를 언제 가져올지는 Cesium이 판단합니다.
Cesium이 타일을 요청하면 Service Worker가 가로채고, 그 노드만 Web Worker에서 디코딩해 돌려줍니다.
LOD는 새로 만들지 않고 Cesium에 위임하며, 디코딩은 메인 스레드 밖에서 처리합니다.

■ 영상에 담긴 것
· Autzen (77MB) 원본 RGB 렌더링과 Cesium3DTileStyle 분류 색상
· 점 조회 — 클릭하면 그 점의 좌표와 LAS 속성(분류·강도·리턴)을 반환합니다.
  화면 픽셀이 아니라 옥트리 최심 노드를 그 시점에 받아 원본 점을 찾습니다.
· SoFi Stadium (1.9GB) — 사전 변환 없이 원본 그대로. RGB가 없는 데이터라 고도로 색을 입혔습니다.
· 스트리밍 구간은 실시간 녹화이며 배속하지 않았습니다.

■ 검증 (모두 자체 측정)
· 오프라인 검증 9/9, 실데이터 통합 검증 9/9 통과
· ECEF 좌표 정합 오차 최대 1.4 × 10⁻⁹ m
· S3 range 왕복 61 → 6 (요청 병합)
· 좌표 재투영 582 → 10.7 ms/100만 점 (54배)
· 깊은 줌 16 → 89 fps (점 예산 적용)
· Cahokia 8.9GB 90초 스트레스 — 메모리 plateau

■ 링크
라이브 데모  https://copc-cesium.vercel.app
소스 코드    https://github.com/thissak/copc-cesium
npm         https://www.npmjs.com/package/@goldenlabs/copc-cesium
라이선스     Apache-2.0

■ 챕터
0:00 문제 — 왜 사전 변환이 걸림돌인가
0:15 COPC는 이미 클라우드 최적화 옥트리
0:28 CopcTileset.fromUrl() 한 줄
0:43 표준 타입이라 Cesium 스타일이 그대로 적용된다
1:02 점 조회 — 원본 점의 좌표와 LAS 속성
1:14 동작 원리 — Service Worker + Web Worker
1:32 스트리밍 (실시간 녹화)
1:48 대형 데이터 — SoFi Stadium 1.9GB
2:00 GB급에서도 보이는 만큼만
2:12 검증 — 실제 테스트 출력
2:27 측정으로 만든 성능
2:49 마무리

2026 오픈소스 개발자대회 출품작입니다.

#CesiumJS #COPC #PointCloud #LiDAR #3DTiles #오픈소스 #WebGL #GIS
```

---

## 태그 (별도 입력란이 있으면)

```
CesiumJS, COPC, point cloud, LiDAR, 3D Tiles, cloud optimized point cloud, WebGL, GIS,
포인트클라우드, 라이다, 오픈소스, 지오스페이셜, laz, las, streaming
```

---

## 업로드 설정 체크리스트

- [ ] **공개 상태**: 대회 심사가 URL로 접근하므로 **공개** 또는 **일부공개(링크 보유자)**.
      *비공개(Private)는 심사위원이 못 봅니다* — 요강도 "비공개 설정 시 확인 불가"로 명시합니다.
- [ ] **아동용 여부**: **"아니요, 아동용이 아닙니다"** 선택
- [ ] **화질**: 업로드 후 1080p 처리가 끝날 때까지 대기 (처리 중에는 저화질로 보입니다)
- [ ] **확인**: 시크릿/로그아웃 창에서 재생해 접근 가능한지 검증
- [ ] 확정된 URL을 결과보고서 "시연영상 URL" 칸에 기재

---

## 썸네일

`파일 업로드` 대신 **`동영상에서 선택`** 을 권합니다. 추천 지점:

| 시점 | 화면 |
|---|---|
| **1:48~1:55** | SoFi Stadium 고도 램프 — 색 대비가 가장 강하고 규모가 드러남 |
| 0:50 부근 | Autzen 분류 색상 — 지반·식생·건물이 또렷함 |

별도 썸네일 이미지가 필요하면 만들어 드리겠습니다.
