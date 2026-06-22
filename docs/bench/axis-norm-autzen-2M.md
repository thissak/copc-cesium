### 4축 분해 — data/norm-autzen-2M.copc.laz · depth≤5 · 65노드 · 5회median (2.13M점)

| 축 | ms | % | ms/1M점 |
|----|----|---|---------|
| IO(local)        |     57.7 |   5% |     27.1 |
| decode(laz+xyz추출) |   1047.5 |  84% |    491.6 |
| reproject(proj4 수평) |     22.8 |   2% |     10.7 |
| build(ecef+양자화+pack) |    117.4 |   9% |     55.1 |
| **internal** | **1245.4** | 100% | — |

**BOTTLENECK: decode(laz+xyz추출)** (84%, 491.6 ms/1M점)

> 축 경계: decode=laz압축해제+XYZ추출 · reproject=proj4 수평(lon/lat)만 · build=geodeticToEcef(고도→ECEF 삼각변환)+양자화+pnts패킹(속성 batch 미포함)
