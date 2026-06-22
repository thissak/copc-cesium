### 4축 분해 — data/norm-autzen-2M.copc.laz · depth≤5 · 65노드 · 5회median (2.13M점)

| 축 | ms | % | ms/1M점 |
|----|----|---|---------|
| IO(local)        |     69.3 |   3% |     32.5 |
| decode(laz+xyz추출) |   1075.8 |  43% |    504.9 |
| reproject(proj4 수평) |   1240.4 |  50% |    582.2 |
| build(ecef+양자화+pack) |    118.9 |   5% |     55.8 |
| **internal** | **2504.5** | 100% | — |

**BOTTLENECK: reproject(proj4 수평)** (50%, 582.2 ms/1M점)

> 축 경계: decode=laz압축해제+XYZ추출 · reproject=proj4 수평(lon/lat)만 · build=geodeticToEcef(고도→ECEF 삼각변환)+양자화+pnts패킹(속성 batch 미포함)
