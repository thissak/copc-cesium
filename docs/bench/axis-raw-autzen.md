### 4축 분해 — data/raw-autzen.copc.laz · depth≤5 · 278노드 · 5회median (10.65M점)

| 축 | ms | % | ms/1M점 |
|----|----|---|---------|
| IO(local)        |    203.1 |   4% |     19.1 |
| decode(laz+xyz추출) |   4828.2 |  84% |    453.2 |
| reproject(proj4 수평) |    111.4 |   2% |     10.5 |
| build(ecef+양자화+pack) |    578.6 |  10% |     54.3 |
| **internal** | **5721.3** | 100% | — |

**BOTTLENECK: decode(laz+xyz추출)** (84%, 453.2 ms/1M점)

> 축 경계: decode=laz압축해제+XYZ추출 · reproject=proj4 수평(lon/lat)만 · build=geodeticToEcef(고도→ECEF 삼각변환)+양자화+pnts패킹(속성 batch 미포함)
