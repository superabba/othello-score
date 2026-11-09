'use strict';
// othello.js — 오델로 점수 규칙과 사진 속 판 읽기. 브라우저(window.Othello)와 서버(require) 양쪽에서 쓴다.
// 판 표현: 64글자 문자열(왼쪽 위부터 행 순서) — '.' 빈칸, 'B' 흑, 'W' 백.
// 이미지 표현: { data: RGBA 배열, width, height } (canvas의 ImageData와 같은 모양).
// 점수표가 90도 회전·뒤집기에 대칭이라 판을 어느 방향에서 찍어도 점수는 같다.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Othello = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SIZE = 8;
  const RING_POINTS = [10, 5, 2, 1];   // 바깥 줄부터 안쪽으로 (모서리 4칸은 따로 20점)

  function cellPoints(r, c) {
    const fromEdgeR = Math.min(r, SIZE - 1 - r), fromEdgeC = Math.min(c, SIZE - 1 - c);
    if (fromEdgeR === 0 && fromEdgeC === 0) return 20;
    return RING_POINTS[Math.min(fromEdgeR, fromEdgeC)];
  }

  function scoreBoard(board) {
    const out = { black: 0, white: 0, blackCount: 0, whiteCount: 0, winner: 'draw' };
    for (let i = 0; i < SIZE * SIZE; i++) {
      const pts = cellPoints(Math.floor(i / SIZE), i % SIZE);
      if (board[i] === 'B') { out.black += pts; out.blackCount++; }
      else if (board[i] === 'W') { out.white += pts; out.whiteCount++; }
    }
    if (out.black !== out.white) out.winner = out.black > out.white ? 'black' : 'white';
    return out;
  }

  const isBoard = (b) => typeof b === 'string' && /^[.BW]{64}$/.test(b);

  // ---- 판 찾기 ----
  // 초록 바닥을 모아 가장 큰 덩어리를 판으로 본다. 돌이 판을 거의 덮어도 돌 사이의 초록은 남으므로, 넓혀서 이은 뒤 볼록 껍질을 잡고
  // 돌과 칸이 격자에 가장 잘 맞도록 네 점을 다듬는다. 올리브색 판도 잡고, 판 틀에 비친 옅은 초록은 버릴 만큼만 채도를 본다.
  const isGreen = (r, g, b) => g > 45 && g > r * 1.08 && g > b * 1.2 && (g - Math.min(r, b)) / g > 0.3;

  function greenMask(img, step) {
    const w = Math.floor(img.width / step), h = Math.floor(img.height / step), m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * step * img.width + x * step) * 4;
      if (isGreen(img.data[i], img.data[i + 1], img.data[i + 2])) m[y * w + x] = 1;
    }
    return { m, w, h };
  }

  // 가로·세로로 나눠 넓힌다(구간 합이라 반지름과 무관하게 빠르다)
  function dilate(m, w, h, rad) {
    const pass = (src, len, lines, at) => {
      const out = new Uint8Array(src.length);
      for (let l = 0; l < lines; l++) {
        let run = 0;
        for (let i = 0; i <= Math.min(rad, len - 1); i++) run += src[at(l, i)];
        for (let i = 0; i < len; i++) {
          if (run > 0) out[at(l, i)] = 1;
          if (i + rad + 1 < len) run += src[at(l, i + rad + 1)];
          if (i - rad >= 0) run -= src[at(l, i - rad)];
        }
      }
      return out;
    };
    return pass(pass(m, w, h, (l, i) => l * w + i), h, w, (l, i) => i * w + l);
  }

  function erode(m, w, h, rad) { return dilate(m.map((v) => 1 - v), w, h, rad).map((v) => 1 - v); }

  function largestComponent(m, w, h) {
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
    let best = null, bestSize = 0;
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || seen[s]) continue;
      let top = 0, count = 0; const cells = [];
      stack[top++] = s; seen[s] = 1;
      while (top) {
        const p = stack[--top]; count++; cells.push(p);
        const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q >= 0 && q < w * h && m[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
        }
      }
      if (count > bestSize) { bestSize = count; best = cells; }
    }
    return best;
  }

  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = (list) => {
      const out = [];
      for (const p of list) {
        while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
        out.push(p);
      }
      out.pop();
      return out;
    };
    return half(pts).concat(half(pts.reverse()));
  }

  // 볼록 껍질에서 사각형을 뽑는다: 가장 먼 두 점이 대각선, 그 양쪽으로 가장 먼 점이 나머지 두 모서리
  function quadFromHull(hull) {
    if (hull.length < 4) return null;
    let a = hull[0], b = hull[1], far = -1;
    for (let i = 0; i < hull.length; i++) for (let j = i + 1; j < hull.length; j++) {
      const d = (hull[i].x - hull[j].x) ** 2 + (hull[i].y - hull[j].y) ** 2;
      if (d > far) { far = d; a = hull[i]; b = hull[j]; }
    }
    const diag = Math.sqrt(far);
    let c = null, d = null, cDist = 0, dDist = 0;
    for (const p of hull) {
      const side = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / (diag || 1);
      if (side > cDist) { cDist = side; c = p; }
      if (-side > dDist) { dDist = -side; d = p; }
    }
    if (!c || !d || cDist < diag * 0.25 || dDist < diag * 0.25) return null;
    return [a, c, b, d];
  }

  function findBoardQuad(img, opts) {
    const step = Math.max(1, Math.ceil(Math.max(img.width, img.height) / 420));
    const { m, w, h } = greenMask(img, step);
    const rough = largestComponent(dilate(m, w, h, Math.max(3, Math.round(Math.max(w, h) / 40))), w, h);
    if (!rough) return null;
    // 돌 구멍을 메울 만큼 넓혔다가 더 깎아, 판처럼 넓은 덩어리만 남긴다(판 틀에 비친 초록 띠는 여기서 사라진다)
    const cell = Math.sqrt(rough.length) / SIZE, close = Math.max(2, Math.round(cell * 0.62)), trim = Math.max(1, Math.round(cell * 0.4));
    const solid = dilate(erode(dilate(m, w, h, close), w, h, close + trim), w, h, trim);
    const comp = largestComponent(solid, w, h);
    if (!comp) return null;
    // 경계는 넓히기 전의 진짜 초록 픽셀로 잡는다(넓힌 만큼 판이 커 보이지 않게)
    const minX = new Int32Array(h).fill(-1), maxX = new Int32Array(h).fill(-1);
    for (const p of comp) {
      if (!m[p]) continue;
      const y = Math.floor(p / w), x = p % w;
      if (minX[y] < 0 || x < minX[y]) minX[y] = x;
      if (x > maxX[y]) maxX[y] = x;
    }
    const edge = [];
    for (let y = 0; y < h; y++) if (minX[y] >= 0) edge.push({ x: minX[y], y }, { x: maxX[y] + 1, y });
    if (edge.length < 8) return null;
    const quad = quadFromHull(convexHull(edge));
    if (!quad) return null;
    const area = polygonArea(quad);
    if (area < w * h * 0.08) return null;
    // 판은 정사각형이므로, 비스듬히 찍혀도 변 길이 차이가 너무 크면 판이 아니다
    const sides = quad.map((p, i) => Math.hypot(p.x - quad[(i + 1) % 4].x, p.y - quad[(i + 1) % 4].y));
    if (Math.min(...sides) < Math.max(...sides) * 0.4) return null;
    // 깎는 동안 판 가장자리가 조금 먹히므로 바깥 줄 칸이 밖으로 몰리지 않게 약간 되돌린다(한 줄 더 들어올 만큼은 아니게)
    const core = new Uint8Array(w * h);
    for (const p of comp) core[p] = 1;
    const blob = dilate(core, w, h, Math.max(1, Math.round(cell * 0.3)));
    const inside = (p) => { const x = Math.floor(p.x / step), y = Math.floor(p.y / step); return x >= 0 && y >= 0 && x < w && y < h && blob[y * w + x] === 1; };
    return orderQuad(fitGrid(img, quad.map((p) => ({ x: p.x * step, y: p.y * step })), inside, opts && opts.quick));
  }

  // 네 점을 조금씩 옮겨 가며 돌이 칸 가운데에 가장 잘 놓이는 곳을 찾는다.
  // 칸 귀퉁이는 초록이고, 돌 안쪽 고리는 가운데와 같아야(돌이면 초록 아님, 빈칸이면 초록) 점수가 오른다. 고리가 돌 가장자리 가까이라 몇 픽셀만 어긋나도 점수가 떨어진다.
  // 귀퉁이 초록이 적고 가운데가 판 덩어리(inside) 밖인 칸은 크게 깎는다 — 판 틀을 돌 한 줄로 착각하지 않게.
  const RING = Array.from({ length: 12 }, (_, i) => [0.5 + 0.33 * Math.cos(i * Math.PI / 6), 0.5 + 0.33 * Math.sin(i * Math.PI / 6)]);
  const NOOK = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.17, 0.08], [0.83, 0.08], [0.92, 0.83], [0.08, 0.83]];
  function gridFit(img, quad, inside) {
    const map = homography(quad);
    const green = (u, v) => { const c = pixel(img, map(u / SIZE, v / SIZE)); return isGreen(c[0], c[1], c[2]) ? 1 : 0; };
    let score = 0;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      let nooks = 0;
      for (const [du, dv] of NOOK) nooks += green(c + du, r + dv);
      if (nooks <= 5 && !inside(map((c + 0.5) / SIZE, (r + 0.5) / SIZE))) { score -= 20; continue; }
      const center = green(c + 0.5, r + 0.5);
      score += nooks;
      for (const [du, dv] of RING) score += green(c + du, r + dv) === center ? 1 : 0;
    }
    return score;
  }
  function descend(img, start, firstMove, inside) {
    let quad = start, best = gridFit(img, quad, inside);
    for (let move = firstMove; move >= 0.75; move /= 2) {
      for (let round = 0, moved = true; moved && round < 12; round++) {
        moved = false;
        for (let i = 0; i < 4; i++) for (const [dx, dy] of [[move, 0], [-move, 0], [0, move], [0, -move]]) {
          const next = quad.map((p, k) => (k === i ? { x: p.x + dx, y: p.y + dy } : p)), score = gridFit(img, next, inside);
          if (score > best) { best = score; quad = next; moved = true; }
        }
      }
    }
    return { quad, score: best };
  }
  // 돌 배열은 한 칸마다 되풀이되어, 처음 위치가 한 칸 넘게 어긋나면 그 자리에 머문다. 그래서 변을 한 칸씩 넣고 빼거나 판 전체를 한 칸 옮겨 본다.
  const SHIFTS = [0, 1, 2, 3].flatMap((i) => [[[i, 1]], [[i, -1]], [[i, 1], [(i + 2) % 4, -1]]]);
  function pushEdges(q, edges) {
    const next = q.slice();
    for (const [i, sign] of edges) {
      const j = (i + 1) % 4, from = { [i]: (i + 3) % 4, [j]: (j + 1) % 4 };
      for (const k of [i, j]) next[k] = { x: next[k].x + sign * (q[k].x - q[from[k]].x) / SIZE, y: next[k].y + sign * (q[k].y - q[from[k]].y) / SIZE };
    }
    return next;
  }
  function fitGrid(img, start, inside, quick) {
    const diag = Math.hypot(start[0].x - start[2].x, start[0].y - start[2].y);
    let cur = descend(img, start, diag / 24, inside);
    if (quick) return cur.quad;   // 실시간 미리보기는 빠르게. 확정한 판은 전체 맞춤을 거친다
    // 처음 고른 변이 틀리면 되돌아오기 어려우므로 좋은 후보 셋을 함께 끌고 간다
    let beam = [cur];
    for (let pass = 0; pass < 3; pass++) {
      const found = beam.flatMap((b) => SHIFTS.map((edges) => descend(img, pushEdges(b.quad, edges), diag / 80, inside)));
      beam = beam.concat(found).sort((x, y) => y.score - x.score).slice(0, 3);
      if (beam[0].score <= cur.score) break;
      cur = beam[0];
    }
    return cur.quad;
  }

  // 화면의 판이 사진과 같은 방향으로 보이도록 왼쪽 위부터 시계 방향으로 맞춘다
  function orderQuad(q) {
    const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
    const round = q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    const first = round.reduce((best, p, i) => (p.x + p.y < round[best].x + round[best].y ? i : best), 0);
    return round.slice(first).concat(round.slice(0, first));
  }

  function polygonArea(q) {
    let s = 0;
    for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s) / 2;
  }

  // 단위 정사각형 (0,0)(1,0)(1,1)(0,1) → 사각형 네 점의 원근 변환
  function homography(q) {
    const [p0, p1, p2, p3] = q;
    const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
    const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
    const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x;
    const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y;
    return (u, v) => {
      const w = g * u + h * v + 1;
      return { x: (a * u + b * v + p0.x) / w, y: (d * u + e * v + p0.y) / w };
    };
  }

  // ---- 칸 읽기 ----
  // 밝기 목록을 두 무리로 가장 잘 나누는 경계(오츠). 두 무리 차이가 작으면 한 색뿐으로 보고 fallback을 쓴다
  function stoneSplit(levels, fallback) {
    if (levels.length < 2) return fallback;
    const sorted = levels.slice().sort((a, b) => a - b);
    let bestAt = -1, bestScore = -1, total = sorted.reduce((a, b) => a + b, 0), left = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      left += sorted[i];
      const n1 = i + 1, n2 = sorted.length - n1, gap = (total - left) / n2 - left / n1, score = n1 * n2 * gap * gap;
      if (score > bestScore) { bestScore = score; bestAt = i; }
    }
    const low = sorted.slice(0, bestAt + 1), high = sorted.slice(bestAt + 1);
    if (median(high) - median(low) < 60) return fallback;
    return (sorted[bestAt] + sorted[bestAt + 1]) / 2;
  }

  const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  function median(list) { const s = list.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; }
  const medianColor = (cs) => [0, 1, 2].map((k) => median(cs.map((c) => c[k])));

  function pixel(img, p) {
    const x = Math.min(img.width - 1, Math.max(0, Math.round(p.x))), y = Math.min(img.height - 1, Math.max(0, Math.round(p.y)));
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  }

  // 돌은 칸 가운데를 덮고 칸의 네 귀퉁이는 비워 둔다. 그래서 귀퉁이 색이 곧 판 바닥색이다 — 판 색이 달라도, 판이 꽉 차도 얻을 수 있다.
  const CORNER_INSET = 0.1, CENTER_RADIUS = 0.24, CENTER_STEPS = 3;

  function readBoard(img, quad) {
    const map = homography(quad);
    const at = (r, c, du, dv) => pixel(img, map((c + du) / SIZE, (r + dv) / SIZE));
    const corners = [], centers = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const hi = 1 - CORNER_INSET;
      corners.push([[CORNER_INSET, CORNER_INSET], [hi, CORNER_INSET], [hi, hi], [CORNER_INSET, hi]].map(([u, v]) => at(r, c, u, v)));
      const pts = [];
      for (let i = -CENTER_STEPS; i <= CENTER_STEPS; i++) for (let j = -CENTER_STEPS; j <= CENTER_STEPS; j++) {
        if (i * i + j * j > CENTER_STEPS * CENTER_STEPS) continue;
        pts.push(at(r, c, 0.5 + (i / CENTER_STEPS) * CENTER_RADIUS, 0.5 + (j / CENTER_STEPS) * CENTER_RADIUS));
      }
      centers.push(medianColor(pts));
    }
    const surface = medianColor(corners.flat()), surfaceL = Math.max(1, luma(surface));
    const cells = centers.map((m, i) => {
      // 그늘을 따라가도록 바닥 밝기는 그 칸 귀퉁이에 맞춘다. 귀퉁이가 튀면(손가락·반사) 전체 값 근처로 묶는다
      const shade = Math.min(1.5, Math.max(0.6, luma(medianColor(corners[i])) / surfaceL));
      const localL = surfaceL * shade, L = luma(m), ratio = L / localL;
      const expected = surface.map((v) => (v - surfaceL) * shade * ratio);
      const chromaDist = Math.hypot(m[0] - L - expected[0], m[1] - L - expected[1], m[2] - L - expected[2]) / localL;
      return { ratio, chromaDist, empty: chromaDist < 0.22 && ratio > 0.7 && ratio < 1.55, level: L / shade };
    });
    // 반사된 검은 돌은 바닥보다 밝기도 해서, 흑백 경계는 돌들의 밝기 분포로 정한다. 한 색뿐이면 바닥 밝기를 기준으로 한다
    const split = stoneSplit(cells.filter((x) => !x.empty).map((x) => x.level), surfaceL * 1.25);
    let board = ''; const uncertain = [];
    cells.forEach((x, i) => {
      const v = x.empty ? '.' : x.level < split ? 'B' : 'W';
      board += v;
      const onEdge = x.empty ? x.chromaDist > 0.14 || x.ratio < 0.65 || x.ratio > 1.4 : Math.abs(x.level - split) < 25 || (x.chromaDist < 0.3 && x.ratio > 0.45 && x.ratio < 1.7);
      if (onEdge) uncertain.push(i);
    });
    return { board, uncertain };
  }

  return { SIZE, cellPoints, scoreBoard, isBoard, findBoardQuad, readBoard, polygonArea };
});
