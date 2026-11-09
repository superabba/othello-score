'use strict';
// othello.test.cjs — 점수 규칙과 판 읽기. 판 읽기는 그려서 만든 사진(원근·그늘·반사 포함)으로 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const O = require('./othello.js');

const EXPECTED = [
  [20, 10, 10, 10, 10, 10, 10, 20],
  [10, 5, 5, 5, 5, 5, 5, 10],
  [10, 5, 2, 2, 2, 2, 5, 10],
  [10, 5, 2, 1, 1, 2, 5, 10],
  [10, 5, 2, 1, 1, 2, 5, 10],
  [10, 5, 2, 2, 2, 2, 5, 10],
  [10, 5, 5, 5, 5, 5, 5, 10],
  [20, 10, 10, 10, 10, 10, 10, 20],
];

test('칸 점수표가 합의한 그림과 같고 전체는 448점', () => {
  let total = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { assert.strictEqual(O.cellPoints(r, c), EXPECTED[r][c], `${r},${c}`); total += EXPECTED[r][c]; }
  assert.strictEqual(total, 448);
});

test('흑백 합계, 돌 개수, 승자, 무승부', () => {
  const allB = O.scoreBoard('B'.repeat(64));
  assert.deepStrictEqual(allB, { black: 448, white: 0, blackCount: 64, whiteCount: 0, winner: 'black' });
  const corner = O.scoreBoard('W' + '.'.repeat(62) + 'B');
  assert.strictEqual(corner.black, 20); assert.strictEqual(corner.white, 20); assert.strictEqual(corner.winner, 'draw');
  // 돌 수가 적어도 모서리를 가진 쪽이 이긴다
  const fewer = O.scoreBoard('W' + '.'.repeat(26) + 'BBBB' + '.'.repeat(33));
  assert.strictEqual(fewer.blackCount, 4); assert.strictEqual(fewer.winner, 'white');
});

// ---- 합성 사진 ----
function makeBoard(seed, emptyRate) {
  let x = seed, out = '';
  for (let i = 0; i < 64; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const v = (x >> 8) % 100;
    out += v < emptyRate ? '.' : v % 2 ? 'B' : 'W';
  }
  return out;
}

// 사진의 각 픽셀을 판 좌표로 되돌려 색을 정한다(역변환). shade(u,v)는 조명.
function render(board, quad, opts = {}) {
  const width = opts.width || 640, height = opts.height || 480;
  const data = new Uint8ClampedArray(width * height * 4);
  const surface = opts.surface || [34, 128, 72], bg = opts.bg || [150, 120, 95];
  const shade = opts.shade || (() => 1);
  // 단위 정사각형 → 사각형의 역행렬을 격자 탐색 없이 뉴턴법으로 풀면 복잡하므로, 판 위를 촘촘히 훑어 찍는다
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, n = ((x * 7 + y * 13) % 11) - 5;
    data[i] = bg[0] + n; data[i + 1] = bg[1] + n; data[i + 2] = bg[2] + n; data[i + 3] = 255;
  }
  const [p0, p1, p2, p3] = quad, map = homographyOf(p0, p1, p2, p3);
  const N = 2400;
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
    const u = (a + 0.5) / N, v = (b + 0.5) / N, p = map(u, v);
    const px = Math.floor(p.x), py = Math.floor(p.y);
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const c = Math.floor(u * 8), r = Math.floor(v * 8), fu = u * 8 - c, fv = v * 8 - r;
    const dist = Math.hypot(fu - 0.5, fv - 0.5), line = fu < 0.025 || fu > 0.975 || fv < 0.025 || fv > 0.975;
    let col = line ? [12, 30, 18] : surface;
    const s = board[r * 8 + c];
    if (s !== '.' && dist < 0.44) {
      col = s === 'B' ? [24, 24, 28] : [228, 228, 222];
      if (opts.glare && s === 'B' && Math.hypot(fu - 0.42, fv - 0.42) < 0.09) col = [235, 235, 235];
    }
    const k = shade(u, v), i = (py * width + px) * 4;
    data[i] = col[0] * k; data[i + 1] = col[1] * k; data[i + 2] = col[2] * k;
  }
  return { data, width, height };
}

function homographyOf(p0, p1, p2, p3) {
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: ((p1.x - p0.x + g * p1.x) * u + (p3.x - p0.x + h * p3.x) * v + p0.x) / w, y: ((p1.y - p0.y + g * p1.y) * u + (p3.y - p0.y + h * p3.y) * v + p0.y) / w };
  };
}

const P = (x, y) => ({ x, y });
const STRAIGHT = [P(120, 40), P(520, 40), P(520, 440), P(120, 440)];
const TILTED = [P(170, 50), P(490, 70), P(570, 430), P(70, 400)];
const ROTATED = [P(320, 20), P(560, 240), P(330, 465), P(90, 250)];

function assertReads(board, quad, opts) {
  const img = render(board, quad, opts);
  const found = O.findBoardQuad(img);
  assert.ok(found, 'board found');
  // 찾은 네 점이 실제 모서리 가까이 있어야 한다(순서는 상관없다)
  for (const q of quad) assert.ok(Math.min(...found.map((f) => Math.hypot(f.x - q.x, f.y - q.y))) < 14, `corner ${q.x},${q.y} found ${JSON.stringify(found)}`);
  const read = O.readBoard(img, quad);
  assert.strictEqual(read.board, board);
}

test('정면 사진을 읽는다 — 꽉 찬 판과 빈칸 섞인 판', () => {
  assertReads(makeBoard(1, 0), STRAIGHT);
  assertReads(makeBoard(2, 30), STRAIGHT);
});

test('기울어 찍은 사진과 돌려 찍은 사진을 읽는다', () => {
  assertReads(makeBoard(3, 12), TILTED);
  assertReads(makeBoard(4, 12), ROTATED);
});

test('한쪽이 어두운 조명과 검은 돌의 반사를 견딘다', () => {
  assertReads(makeBoard(5, 20), STRAIGHT, { shade: (u) => 0.6 + 0.5 * u, glare: true });
});

test('자동으로 찾은 모서리로 읽으면 사진과 같은 방향의 판이 나온다', () => {
  const board = makeBoard(6, 15), img = render(board, TILTED);
  assert.strictEqual(O.readBoard(img, O.findBoardQuad(img)).board, board);
});

test('초록 판이 없으면 찾았다고 하지 않는다', () => {
  const width = 320, height = 240, data = new Uint8ClampedArray(width * height * 4).fill(128);
  assert.strictEqual(O.findBoardQuad({ data, width, height }), null);
});
