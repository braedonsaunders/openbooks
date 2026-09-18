/**
 * DE PAP 2026 conformance goldens.
 *
 * Three proof layers, per the payroll-live bar:
 *
 * 1. Agency goldens: the PAP's own "Allgemeine maschinelle Jahreslohnsteuer
 *    2026 (Prüftabelle)" and "Besondere maschinelle Jahreslohnsteuer 2026
 *    (Prüftabelle)" (Anlage 1, pages 39–40), transcribed cell for cell.
 *    Quoted test setup: "Berechnet mit den Merkern ALV, KRV und PKV = 0
 *    sowie KVZ = 2,90" with "In der Steuerklasse II gilt PVZ = 0, in den
 *    anderen Steuerklassen gilt PVZ = 1" (allgemeine); "Berechnet mit den
 *    Merkern ALV, KRV und PKV = 1" with "In der Steuerklasse III gilt
 *    PKPV = 50.000, in der Steuerklasse VI gilt PKPV = 0, in den anderen
 *    Steuerklassen gilt PKPV = 30.000" (besondere — "Besondere Lohnsteuer
 *    ist die Lohnsteuer, die für einen Arbeitnehmer zu erheben ist, der in
 *    keinem Sozialversicherungszweig versichert ist").
 * 2. Hand-worked cases independent of the engine, arithmetic shown.
 * 3. Tariff boundary units plus a monotonicity/bounds sweep.
 *
 * Money convention: inputs in integer Cent; LSTJAHR/JBMG/ST in whole Euro.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  computePapLaufend2026,
  DE_PAP_2026_SOURCE,
  papMst56,
  papUptab26,
  type DePapLaufendInput,
} from "./pap.ts";

/** Standard laufende-Bezüge inputs; each test overrides what it needs. */
function std(over: Partial<DePapLaufendInput>): DePapLaufendInput {
  return {
    lzz: 1, af: 0, f: 1,
    alv: 0, krv: 0, pkv: 0, kvz: 2.9,
    pvs: 0, pva: 0, r: 0,
    lzzfreib: 0, lzzhinzu: 0, pkpv: 0, pkpvagz: 0, zkf: 0,
    ...over,
  } as DePapLaufendInput;
}

/** [Jahresbruttolohn, Steuerklassen I, II, III, IV, V, VI] — agency cells. */
type TableRow = [number, number, number, number, number, number, number];
const STKL = [1, 2, 3, 4, 5, 6] as const;

const ALLGEMEINE: TableRow[] = [
  [5000, 0, 0, 0, 0, 372, 558],
  [7500, 0, 0, 0, 0, 647, 838],
  [10000, 0, 0, 0, 0, 922, 1117],
  [12500, 0, 0, 0, 0, 1197, 1397],
  [15000, 0, 0, 0, 0, 1472, 1676],
  [17500, 51, 0, 0, 51, 1778, 1956],
  [20000, 380, 0, 0, 380, 2234, 2766],
  [22500, 782, 32, 0, 782, 3073, 3604],
  [25000, 1251, 359, 0, 1251, 3911, 4443],
  [27500, 1742, 759, 0, 1742, 4749, 5281],
  [30000, 2248, 1230, 0, 2248, 5588, 6120],
  [32500, 2767, 1724, 0, 2767, 6426, 6952],
  [35000, 3300, 2233, 294, 3300, 7216, 7682],
  [37500, 3847, 2756, 628, 3847, 7954, 8436],
  [40000, 4407, 3293, 1000, 4407, 8720, 9218],
  [42500, 4982, 3843, 1406, 4982, 9512, 10030],
  [45000, 5570, 4408, 1850, 5570, 10334, 10865],
  [47500, 6172, 4987, 2324, 6172, 11171, 11703],
  [50000, 6788, 5580, 2810, 6788, 12010, 12542],
  [52500, 7417, 6186, 3302, 7417, 12848, 13380],
  [55000, 8060, 6807, 3802, 8060, 13687, 14218],
  [57500, 8718, 7442, 4308, 8718, 14525, 15057],
  [60000, 9389, 8091, 4822, 9389, 15364, 15895],
  [62500, 10073, 8754, 5342, 10073, 16202, 16734],
  [65000, 10772, 9430, 5870, 10772, 17040, 17572],
  [67500, 11484, 10121, 6402, 11484, 17879, 18410],
  [70000, 12220, 10835, 6952, 12220, 18729, 19260],
  [72500, 13062, 11647, 7574, 13062, 19681, 20213],
  [75000, 13922, 12476, 8206, 13922, 20633, 21165],
  [77500, 14799, 13323, 8846, 14799, 21585, 22117],
  [80000, 15694, 14188, 9496, 15694, 22538, 23070],
  [82500, 16607, 15071, 10154, 16607, 23490, 24022],
  [85000, 17538, 15971, 10822, 17538, 24443, 24974],
  [87500, 18486, 16890, 11498, 18486, 25395, 25927],
  [90000, 19438, 17826, 12182, 19438, 26347, 26879],
  [92500, 20390, 18777, 12876, 20390, 27300, 27831],
  [95000, 21343, 19729, 13580, 21343, 28252, 28784],
  [97500, 22295, 20682, 14292, 22295, 29204, 29736],
  [100000, 23248, 21634, 15012, 23248, 30157, 30689],
  [102500, 24243, 22629, 15774, 24243, 31152, 31684],
  [105000, 25293, 23679, 16590, 25293, 32202, 32734],
  [107500, 26343, 24729, 17416, 26343, 33252, 33784],
  [110000, 27393, 25779, 18252, 27393, 34302, 34834],
];

const BESONDERE: TableRow[] = [
  [5000, 0, 0, 0, 0, 18, 700],
  [7500, 0, 0, 0, 0, 368, 1050],
  [10000, 0, 0, 0, 0, 718, 1400],
  [12500, 0, 0, 0, 0, 1068, 1750],
  [15000, 0, 0, 0, 0, 1418, 2359],
  [17500, 40, 0, 0, 40, 1768, 3409],
  [20000, 461, 0, 0, 461, 2415, 4459],
  [22500, 995, 153, 0, 995, 3465, 5509],
  [25000, 1604, 607, 0, 1604, 4515, 6559],
  [27500, 2234, 1173, 0, 2234, 5565, 7514],
  [30000, 2886, 1788, 0, 2886, 6615, 8460],
  [32500, 3559, 2424, 76, 3559, 7564, 9446],
  [35000, 4254, 3083, 466, 4254, 8510, 10473],
  [37500, 4971, 3763, 914, 4971, 9498, 11523],
  [40000, 5710, 4464, 1420, 5710, 10529, 12573],
  [42500, 6470, 5188, 1982, 6470, 11579, 13623],
  [45000, 7252, 5932, 2584, 7252, 12629, 14673],
  [47500, 8055, 6699, 3198, 8055, 13679, 15723],
  [50000, 8880, 7487, 3824, 8880, 14729, 16773],
  [52500, 9727, 8297, 4458, 9727, 15779, 17823],
  [55000, 10595, 9128, 5106, 10595, 16829, 18873],
  [57500, 11485, 9981, 5762, 11485, 17879, 19923],
  [60000, 12396, 10856, 6430, 12396, 18929, 20973],
  [62500, 13330, 11752, 7110, 13330, 19979, 22023],
  [65000, 14284, 12670, 7798, 14284, 21029, 23073],
  [67500, 15261, 13610, 8500, 15261, 22079, 24123],
  [70000, 16259, 14571, 9210, 16259, 23129, 25173],
  [72500, 17279, 15554, 9932, 17279, 24179, 26223],
  [75000, 18320, 16559, 10666, 18320, 25229, 27273],
  [77500, 19370, 17585, 11410, 19370, 26279, 28323],
  [80000, 20420, 18631, 12164, 20420, 27329, 29373],
  [82500, 21470, 19681, 12930, 21470, 28379, 30423],
  [85000, 22520, 20731, 13706, 22520, 29429, 31473],
  [87500, 23570, 21781, 14492, 23570, 30479, 32523],
  [90000, 24620, 22831, 15290, 24620, 31529, 33573],
  [92500, 25670, 23881, 16098, 25670, 32579, 34623],
  [95000, 26720, 24931, 16918, 26720, 33629, 35673],
  [97500, 27770, 25981, 17748, 27770, 34679, 36723],
  [100000, 28820, 27031, 18590, 28820, 35729, 37773],
  [102500, 29870, 28081, 19442, 29870, 36779, 38823],
  [105000, 30920, 29131, 20304, 30920, 37829, 39873],
  [107500, 31970, 30181, 21178, 31970, 38879, 40923],
  [110000, 33020, 31231, 22062, 33020, 39929, 41973],
];

test("agency golden: allgemeine Prüftabelle (43×6 cells, KVZ 2.90)", () => {
  let cells = 0;
  for (const [gross, ...want] of ALLGEMEINE) {
    STKL.forEach((stkl, i) => {
      const out = computePapLaufend2026(std({
        re4: gross * 100,
        stkl,
        pvz: stkl === 2 ? 0 : 1,
      }));
      assert.equal(out.lstjahr, want[i], `${gross} Kl.${stkl}`);
      cells += 1;
    });
  }
  assert.equal(cells, 258);
});

test("agency golden: besondere Prüftabelle (43×6 cells, privat versichert)", () => {
  let cells = 0;
  for (const [gross, ...want] of BESONDERE) {
    STKL.forEach((stkl, i) => {
      const out = computePapLaufend2026(std({
        re4: gross * 100,
        stkl,
        alv: 1, krv: 1, pkv: 1,
        pkpv: stkl === 3 ? 5000000 : stkl === 6 ? 0 : 3000000,
        pvz: 1,
      }));
      assert.equal(out.lstjahr, want[i], `${gross} Kl.${stkl}`);
      cells += 1;
    });
  }
  assert.equal(cells, 258);
});

test("hand-worked: 30000 Klasse I allgemeine, every step shown", () => {
  // ZRE4 = 30000.00; ANP = 1230 (30000 ≥ 1230); Sonderausgaben-Pauschbetrag
  // 36 (Kl. I); ZTABFB = 1266. VSPR = ⌊30000×0.093⌋ = 2790.00;
  // VSPKVPV = ⌊30000×(0.0145+0.07+0.024)⌋ = ⌊30000×0.1085⌋ = 3255.00;
  // VSP = ⌈2790+3255⌉ = 6045. MVSPHB: VSPALV = ⌊30000×0.013⌋ = 390.00;
  // VSPHB = 390+3255 = 3645 → capped 1900; VSPN = ⌈2790+1900⌉ = 4690 < 6045.
  // ZVE = 30000 − 1266 − 6045 = 22689.00; X = 22689.
  // Zone 3: Y = (22689−17799)/10000 = 0.489; RW = 0.489×173.1 = 84.6459;
  // RW = 2481.6459; RW = 1213.5248…; ST = ⌊1213.5248 + 1034.87⌋ = 2248.
  // JBMG = 2248 < 20350 → no Soli. R = 0 → BK = 0.
  const out = computePapLaufend2026(std({ re4: 3000000, stkl: 1, pvz: 1 }));
  assert.equal(out.vsp, 604500);
  assert.equal(out.zve, 2268900);
  assert.equal(out.st, 2248);
  assert.equal(out.lstjahr, 2248);
  assert.equal(out.jbmg, 2248);
  assert.equal(out.solzj, 0);
  assert.equal(out.solzlzz, 0);
  assert.equal(out.bk, 0);
  assert.equal(out.vfrb, 123000);
  assert.equal(out.wvfrb, 1034100);
  assert.equal(out.lstlzz, 224800);
});

test("hand-worked: Soli Milderungszone at 110000 Klasse I", () => {
  // LSTJAHR = JBMG = 27393 (agency cell). Full 5.5%: ⌊27393×5.5/100⌋ in
  // Cent = ⌊150661.5⌋ = 150661. Milderung: ⌊(27393−20350)×11.9/100⌋ =
  // ⌊83811.7⌋ = 83811 < 150661 → SOLZJ = 83811.
  const out = computePapLaufend2026(std({ re4: 11000000, stkl: 1, pvz: 1 }));
  assert.equal(out.lstjahr, 27393);
  assert.equal(out.solzj, 83811);
  assert.equal(out.solzlzz, 8381100);
});

test("hand-worked: monthly split of the 30000 Klasse I year", () => {
  // LZZ = 2, RE4 = 2500.00 → ZRE4J = 30000.00, same year, then
  // LSTLZZ = ⌊224800/12⌋ = 18733.
  const out = computePapLaufend2026(std({ lzz: 2, re4: 250000, stkl: 1, pvz: 1 }));
  assert.equal(out.lstjahr, 2248);
  assert.equal(out.lstlzz, 18733);
});

test("hand-worked: Kinderfreibetrag lowers JBMG, not LSTJAHR", () => {
  // 40000 Kl. III, ZKF = 1: KFB = 9756. First pass ST = 1000 (agency cell).
  // Second pass ZTABFB = 1266 + 9756 = 11022; ZVE = 40000 − 11022 − 8060 =
  // 20918.00; X = ⌊20918/2⌋ = 10459 < 12349 → JBMG = 0.
  const out = computePapLaufend2026(std({ re4: 4000000, stkl: 3, pvz: 1, zkf: 1 }));
  assert.equal(out.lstjahr, 1000);
  assert.equal(out.jbmg, 0);
  assert.equal(out.solzj, 0);
});

test("hand-worked: micro wage uses ANP ceiling and VSPN uplift", () => {
  // 1000.00 Kl. I: ZRE4 = 1000 < 1230 → ANP = ⌈1000⌉ = 1000 (Euro ↑);
  // ZTABFB = 1036. VSPR = ⌊1000×0.093⌋ = 93.00; VSPKVPV = ⌊1000×0.1085⌋ =
  // 108.50; VSP = ⌈201.50⌉ = 202 (Euro ↑). MVSPHB: VSPALV = 13.00;
  // VSPHB = 121.50; VSPN = ⌈214.50⌉ = 215 > 202 → VSP = 215.00.
  // ZVE = 1000 − 1036 − 215 < 0 → clamped 0 → ST = 0.
  const out = computePapLaufend2026(std({ re4: 100000, stkl: 1, pvz: 1 }));
  assert.equal(out.vsp, 21500);
  assert.equal(out.zve, 0);
  assert.equal(out.lstjahr, 0);
  assert.equal(out.vfrb, 100000);
});

test("hand-worked: confession key yields the Kirchenlohnsteuer base", () => {
  // R > 0: BK = JBMG per period; the 8%/9% Land rate applies outside PAP.
  const out = computePapLaufend2026(std({ re4: 3000000, stkl: 1, pvz: 1, r: 5 }));
  assert.equal(out.bk, 224800);
});

test("tariff units: zone edges and closed forms", () => {
  assert.equal(papUptab26(12348, 1), 0);
  assert.equal(papUptab26(12349, 1), 0);
  // 17799: Y = 0.5451 → ⌊(0.5451×914.51+1400)×0.5451⌋ = 1034.
  assert.equal(papUptab26(17799, 1), 1034);
  // 17800: Y = 0.0001 → ⌊(0.0001×173.1+2397)×0.0001+1034.87⌋ = 1035.
  assert.equal(papUptab26(17800, 1), 1035);
  // 69878/69879 zone-3/zone-4 joint: both 18213.
  assert.equal(papUptab26(69878, 1), 18213);
  assert.equal(papUptab26(69879, 1), 18213);
  // Closed forms: ⌊0.42×100000−11135.63⌋ = 30864; splitting doubles it.
  assert.equal(papUptab26(100000, 1), 30864);
  assert.equal(papUptab26(100000, 2), 61728);
  // 277825/277826 zone-4/zone-5 joint: 105550/105551.
  assert.equal(papUptab26(277825, 1), 105550);
  assert.equal(papUptab26(277826, 1), 105551);
  // MST5-6 at W1STKL5: UP5-6 gives DIFF = 1968, MIST = 1969 → max; no VERGL
  // path at exactly W1 → 1969.
  assert.equal(papMst56(14071), 1969);
});

test("sweep: tariff monotone, engine bounded on the LZZ×STKL grid", () => {
  let prev = -1;
  for (let x = 0; x <= 300000; x += 37) {
    const st = papUptab26(x, 1);
    assert.ok(st >= prev, `tariff must not fall at ${x}`);
    prev = st;
  }
  for (const lzz of [1, 2, 3, 4] as const) {
    for (const stkl of STKL) {
      const per = lzz === 1 ? 1 : lzz === 2 ? 12 : lzz === 3 ? 52 : 360;
      const out = computePapLaufend2026(std({
        lzz, stkl, re4: 40000, pvz: stkl === 2 ? 0 : 1,
      }));
      assert.ok(out.lstlzz >= 0 && out.solzlzz >= 0 && out.bk >= 0);
      assert.ok(out.lstlzz <= 40000 * per, `period tax cannot exceed period pay`);
    }
  }
});

test("refusals name the untranscribed path", () => {
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 1, pvz: 1, vbez: 100 })), /Versorgungsbez/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 1, pvz: 1, alter1: 1 })), /Altersentlastungsbetrag/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 1, pvz: 1, sonstb: 100 })), /sonstige Bez/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 1, pvz: 1, jre4: 100 })), /sonstige Bez/);
});

test("validators enforce PAP 3.1 plausibility", () => {
  const good = { re4: 3000000, stkl: 1, pvz: 1 } as const;
  assert.throws(() => computePapLaufend2026(std({ ...good, lzz: 5 as never })), /LZZ/);
  assert.throws(() => computePapLaufend2026(std({ ...good, stkl: 7 as never })), /STKL/);
  assert.throws(() => computePapLaufend2026(std({ ...good, re4: -1 })), /RE4/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 5, pvz: 1, zkf: 1 })), /ZKF/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 3, pvz: 1, af: 1 })), /Faktorverfahren/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 4, pvz: 1, af: 1, lzzfreib: 100 })), /Faktor/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 6, pvz: 1, lzzhinzu: 100 })), /VI/);
  assert.throws(() => computePapLaufend2026(std({ re4: 3000000, stkl: 4, pvz: 1, af: 1, f: 0 })), /\bF\b/);
  assert.throws(() => computePapLaufend2026(std({ ...good, pva: 5 as never })), /PVA/);
  assert.throws(() => computePapLaufend2026(std({ ...good, kvz: -0.01 })), /KVZ/);
});

test("PAP source pin: implemented laufende Bezüge", () => {
  assert.equal(DE_PAP_2026_SOURCE.implemented, true);
  assert.ok(DE_PAP_2026_SOURCE.url.includes("bundesfinanzministerium.de"));
  assert.equal(DE_PAP_2026_SOURCE.stand, "12.11.2025 (endgültig)");
});
