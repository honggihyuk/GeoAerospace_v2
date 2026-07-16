// 데모용 TLE 세트. 프로덕션은 CelesTrak GP API에서 매일 수집(설계서 §7.5 get_tle).
// 아래 요소는 시연용으로 오래될 수 있음 — SGP4 전파는 정상 동작.

export type SatDef = {
  noradId: number;
  name: string;
  tle1: string;
  tle2: string;
  color: [number, number, number]; // RGB
  kind: "payload" | "tracked" | "debris";
};

export const SATELLITES: SatDef[] = [
  {
    noradId: 25544,
    name: "ISS (ZARYA)",
    tle1: "1 25544U 98067A   24187.45789227  .00016717  00000+0  30074-3 0  9993",
    tle2: "2 25544  51.6416 121.2333 0009035  99.8340 260.3893 15.50022067    05",
    color: [255, 183, 77], // amber = tracked
    kind: "tracked",
  },
  {
    noradId: 44713,
    name: "STARLINK-1007",
    tle1: "1 44713U 19074A   24187.50000000  .00001234  00000+0  10000-3 0  9990",
    tle2: "2 44713  53.0540 200.0000 0001300  90.0000 270.0000 15.06000000    05",
    color: [92, 225, 255], // cyan
    kind: "payload",
  },
  {
    noradId: 40536,
    name: "KOMPSAT-3A",
    tle1: "1 40536U 15011A   24187.50000000  .00000500  00000+0  20000-4 0  9990",
    tle2: "2 40536  97.5000 250.0000 0010000  90.0000 270.0000 14.82000000    05",
    color: [143, 180, 232], // ice blue (SSO)
    kind: "payload",
  },
  {
    noradId: 33591,
    name: "NOAA-19",
    tle1: "1 33591U 09005A   24187.50000000  .00000100  00000+0  80000-4 0  9990",
    tle2: "2 33591  99.1900 200.0000 0013000  90.0000 270.0000 14.13000000    05",
    color: [143, 180, 232],
    kind: "payload",
  },
];
