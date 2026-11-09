'use strict';
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let toastTimer = 0;
function toast(msg, isError) {
  const el = $('toast'); el.textContent = msg; el.hidden = false; el.classList.toggle('err', !!isError);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 4000 : 2000);
}

// ---- 저장소 ----
const DB_NAME = 'othello-score', STORE = 'games';
let dbOpen = null;
function db() {
  dbOpen = dbOpen || new Promise((ok, no) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  return dbOpen;
}
async function store(mode, work) {
  const d = await db();
  return new Promise((ok, no) => {
    const tx = d.transaction(STORE, mode), req = work(tx.objectStore(STORE));
    tx.oncomplete = () => ok(req.result); tx.onerror = tx.onabort = () => no(tx.error);
  });
}
let games = [], photoUrls = [];

// ---- 화면 전환 ----
function showTab(k) {
  document.querySelectorAll('.subtabs button').forEach((b) => { const on = b.dataset.k === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  document.querySelectorAll('[data-subsec]').forEach((x) => { x.hidden = x.dataset.subsec !== k; });
}
document.querySelector('.subtabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) showTab(b.dataset.k); });

// 찍기(사진·실시간) → 인식 → 고치기 → 저장, 그리고 경기 기록. 기록과 사진은 이 기기의 IndexedDB에만 저장한다.
const OT_MAX_SIDE = 1000, OT_LIVE_SIDE = 480, OT_NEXT = { '.': 'B', B: 'W', W: '.' }, OT_NAME = { '.': '빈칸', B: '흑', W: '백' };
const ot = { source: null, photo: null, quad: null, board: '', doubt: new Set(), stream: null, timer: 0, stable: 0, last: '', drag: -1, removing: '' };
const otData = (cv) => cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
function otCanvas(src, srcW, srcH, maxSide) {
  const k = Math.min(1, maxSide / Math.max(srcW, srcH)), cv = document.createElement('canvas');
  cv.width = Math.round(srcW * k); cv.height = Math.round(srcH * k);
  cv.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}
function otShowStage(which) { for (const [id, k] of [['otStart', 'start'], ['otLive', 'live'], ['otReview', 'review']]) $(id).hidden = k !== which; }
function otStartMsg(t) { $('otStartMsg').hidden = !t; $('otStartMsg').textContent = t || ''; }
const otSideHtml = (color, name, pts, count, win) => `<div class="ot-side${win ? ' win' : ''}"><span class="ot-dot ${color}"></span><div><div class="pts">${pts}</div><div class="who">${escapeHtml(name)} · ${count}개</div></div></div>`;
const otScoreHtml = (sc, b, w) => otSideHtml('B', b, sc.black, sc.blackCount, sc.winner === 'black') + otSideHtml('W', w, sc.white, sc.whiteCount, sc.winner === 'white');
const otResultText = (winner, b, w, black, white) => (winner === 'draw' ? '무승부' : `${winner === 'black' ? b : w} 승 · ${Math.abs(black - white)}점 차`);
function otCellsHtml(board, doubt, button) {
  let h = '';
  for (let i = 0; i < 64; i++) {
    const v = board[i], r = Math.floor(i / 8), c = i % 8, pts = Othello.cellPoints(r, c);
    const inner = v === '.' ? pts : `<span class="st ${v}">${pts}</span>`;
    const cls = `ot-cell${doubt && doubt.has(i) ? ' doubt' : ''}`;
    h += button ? `<button type="button" class="${cls}" data-i="${i}" aria-label="${r + 1}행 ${c + 1}열 ${OT_NAME[v]}, ${pts}점">${inner}</button>` : `<div class="${cls}">${inner}</div>`;
  }
  return h;
}

function otRenderResult() {
  const sc = Othello.scoreBoard(ot.board), b = $('otBlack').value.trim() || '흑', w = $('otWhite').value.trim() || '백';
  $('otScore').innerHTML = otScoreHtml(sc, b, w);
  $('otResult').textContent = otResultText(sc.winner, b, w, sc.black, sc.white);
}
function otRenderBoard() { $('otBoard').innerHTML = otCellsHtml(ot.board, ot.doubt, true); otRenderResult(); }
function otDrawPhoto() {
  const cv = $('otPhoto'), g = cv.getContext('2d'), q = ot.quad, unit = cv.width / (cv.clientWidth || cv.width);
  g.drawImage(ot.source, 0, 0);
  g.lineWidth = 2.5 * unit; g.strokeStyle = '#ffc53d'; g.beginPath(); q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.stroke();
  for (const p of q) { g.beginPath(); g.arc(p.x, p.y, 11 * unit, 0, 7); g.fillStyle = 'rgba(255,197,61,.55)'; g.fill(); g.lineWidth = 2 * unit; g.stroke(); }
}
function otRead() {
  const r = Othello.readBoard(ot.image, ot.quad);
  ot.board = r.board; ot.doubt = new Set(r.uncertain);
  otRenderBoard();
}
// 인식 화면으로 — source는 화면·인식용 캔버스, photo는 저장할 원본(Blob)
function otReview(source, photo) {
  ot.source = source; ot.photo = photo; ot.image = otData(source);
  const found = Othello.findBoardQuad(ot.image), W = source.width, H = source.height, s = Math.min(W, H) * 0.8;
  ot.quad = found || [{ x: (W - s) / 2, y: (H - s) / 2 }, { x: (W + s) / 2, y: (H - s) / 2 }, { x: (W + s) / 2, y: (H + s) / 2 }, { x: (W - s) / 2, y: (H + s) / 2 }];
  $('otQuadMsg').textContent = found ? '네 점이 판의 모서리에 맞지 않으면 끌어서 맞춰 주세요.' : '판을 자동으로 찾지 못했어요. 네 점을 판의 모서리로 끌어 주세요.';
  $('otQuadMsg').classList.toggle('warn', !found);
  const cv = $('otPhoto'); cv.width = W; cv.height = H;
  otShowStage('review'); otRead(); otDrawPhoto();
  $('otReview').scrollIntoView({ block: 'start' });
}
function otOpenFile(input) {
  const file = input.files && input.files[0]; input.value = ''; if (!file) return;
  otStartMsg('');
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    const cv = otCanvas(img, img.naturalWidth, img.naturalHeight, OT_MAX_SIDE); URL.revokeObjectURL(url);
    // 원본을 저장한다. 너무 크거나 웹에서 못 여는 형식일 때만 다시 압축한다
    const direct = file.size <= 10 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type);
    if (direct) return otReview(cv, file);
    cv.toBlob((blob) => otReview(cv, blob), 'image/jpeg', 0.9);
  };
  img.onerror = () => { URL.revokeObjectURL(url); otStartMsg('이 사진을 열 수 없어요. JPG나 PNG 사진으로 다시 해 주세요.'); };
  img.src = url;
}
$('otShot').onchange = (e) => otOpenFile(e.target);
$('otPick').onchange = (e) => otOpenFile(e.target);

// 칸 고치기
$('otBoard').addEventListener('click', (e) => {
  const b = e.target.closest('.ot-cell'); if (!b) return;
  const i = +b.dataset.i;
  ot.board = ot.board.slice(0, i) + OT_NEXT[ot.board[i]] + ot.board.slice(i + 1); ot.doubt.delete(i);
  otRenderBoard();
  const again = $('otBoard').querySelector(`[data-i="${i}"]`); if (again) again.focus();
});
$('otBlack').oninput = otRenderResult; $('otWhite').oninput = otRenderResult;

// 모서리 끌기 — 놓는 순간 다시 읽는다(직접 고친 칸은 새 인식으로 바뀐다)
function otPoint(e) { const cv = $('otPhoto'), r = cv.getBoundingClientRect(), k = cv.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k }; }
$('otPhoto').addEventListener('pointerdown', (e) => {
  const p = otPoint(e); let best = -1, near = 44 * p.k;
  ot.quad.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < near) { near = d; best = i; } });
  if (best < 0) return;
  ot.drag = best; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault();
});
$('otPhoto').addEventListener('pointermove', (e) => {
  if (ot.drag < 0) return;
  const p = otPoint(e), cv = e.currentTarget;
  ot.quad[ot.drag] = { x: Math.max(0, Math.min(cv.width, p.x)), y: Math.max(0, Math.min(cv.height, p.y)) };
  otDrawPhoto();
});
const otDrop = () => { if (ot.drag < 0) return; ot.drag = -1; otRead(); };
$('otPhoto').addEventListener('pointerup', otDrop);
$('otPhoto').addEventListener('pointercancel', otDrop);

// 실시간 카메라
function otStopLive() {
  clearInterval(ot.timer); ot.timer = 0;
  if (ot.stream) ot.stream.getTracks().forEach((t) => t.stop());
  ot.stream = null; $('otVideo').srcObject = null;
}
function otLiveFail(msg) { otStopLive(); otShowStage('start'); otStartMsg(msg); }
$('otLiveOpen').onclick = async () => {
  otStartMsg('');
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return otLiveFail('실시간 카메라는 https 주소에서만 열려요. 지금 주소에서는 사진 찍기를 써 주세요.');
  otShowStage('live'); $('otFreeze').disabled = true; $('otLiveScore').innerHTML = ''; $('otLiveMsg').textContent = '카메라를 준비하고 있어요.';
  ot.stable = 0; ot.last = '';
  try {
    ot.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) { return otLiveFail(e && e.name === 'NotAllowedError' ? '카메라 권한이 꺼져 있어요. 브라우저 설정에서 허용하거나 사진 찍기를 써 주세요.' : '카메라를 열 수 없어요. 사진 찍기를 써 주세요.'); }
  const v = $('otVideo'); v.srcObject = ot.stream; v.play().catch(() => {});
  ot.timer = setInterval(otLiveTick, 350);
};
function otLiveTick() {
  const v = $('otVideo');
  if (!v.offsetParent) return otStopLive(), otShowStage('start');   // 다른 탭으로 가면 카메라를 끈다
  if (v.readyState < 2 || !v.videoWidth) return;
  const cv = otCanvas(v, v.videoWidth, v.videoHeight, OT_LIVE_SIDE), img = otData(cv), ov = $('otLiveOv');
  ov.width = cv.width; ov.height = cv.height;
  const quad = Othello.findBoardQuad(img, { quick: true }), g = ov.getContext('2d');
  $('otFreeze').disabled = !quad;
  if (!quad) { ot.stable = 0; ot.last = ''; $('otLiveMsg').textContent = '판 전체가 화면에 들어오게 비춰 주세요.'; $('otLiveScore').innerHTML = ''; return; }
  g.lineWidth = 3; g.strokeStyle = '#ffc53d'; g.beginPath(); quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.stroke();
  const { board } = Othello.readBoard(img, quad), sc = Othello.scoreBoard(board);
  ot.stable = board === ot.last ? ot.stable + 1 : 0; ot.last = board;
  $('otLiveScore').innerHTML = otScoreHtml(sc, '흑', '백');
  $('otLiveMsg').textContent = ot.stable >= 3 ? '인식이 안정됐어요. 확정해 주세요.' : '판을 읽고 있어요. 잠시 고정해 주세요.';
}
$('otLiveClose').onclick = () => { otStopLive(); otShowStage('start'); };
$('otFreeze').onclick = () => {
  const v = $('otVideo'), full = otCanvas(v, v.videoWidth, v.videoHeight, 4096), cv = otCanvas(full, full.width, full.height, OT_MAX_SIDE);
  full.toBlob((blob) => { otStopLive(); otReview(cv, blob); }, 'image/jpeg', 0.92);
};

$('otAgain').onclick = () => { ot.source = ot.photo = ot.image = null; otShowStage('start'); };
const otToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const otName = (v, fallback) => v.trim().slice(0, 40) || fallback;
$('otSave').onclick = async () => {
  const b = $('otSave'); b.disabled = true; b.textContent = '저장 중…';
  try {
    const game = { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, date: otToday(), blackName: otName($('otBlack').value, '흑'), whiteName: otName($('otWhite').value, '백'),
      board: ot.board, ...Othello.scoreBoard(ot.board), photo: ot.photo, createdAt: new Date().toISOString() };
    await store('readwrite', (s) => s.put(game));
    toast('경기를 저장했어요');
    ot.source = ot.photo = ot.image = null; $('otBlack').value = ''; $('otWhite').value = '';
    otShowStage('start'); showTab('history'); await refreshGames();
  } catch { toast('저장하지 못했어요. 저장 공간을 확인하고 다시 시도해 주세요.', true); }
  finally { b.disabled = false; b.textContent = '경기 저장'; }
};

// 경기 기록
async function refreshGames() {
  games = await store('readonly', (s) => s.getAll());
  renderGames();
}
function renderGames() {
  $('otCount').textContent = games.length ? String(games.length) : '';
  const open = new Set([...$('otGames').querySelectorAll('.ot-game-body:not([hidden])')].map((x) => x.dataset.id));
  photoUrls.forEach((u) => URL.revokeObjectURL(u)); photoUrls = [];
  const list = games.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('otGames').innerHTML = list.length ? list.map((g) => {
    const res = otResultText(g.winner, g.blackName, g.whiteName, g.black, g.white);
    let photo = '';
    if (g.photo) { const url = URL.createObjectURL(g.photo); photoUrls.push(url); photo = `<img loading="lazy" src="${url}" alt="${escapeHtml(g.date)} 경기 사진">`; }
    return `<div class="card ot-game"><button type="button" class="ot-game-head" data-open="${escapeHtml(g.id)}" aria-expanded="${open.has(g.id)}">
      <span class="vs">${g.winner === 'black' ? '<em>' : ''}${escapeHtml(g.blackName)} ${g.black}${g.winner === 'black' ? '</em>' : ''} : ${g.winner === 'white' ? '<em>' : ''}${g.white} ${escapeHtml(g.whiteName)}${g.winner === 'white' ? '</em>' : ''}</span>
      <span class="date">${escapeHtml(g.date)} · 흑 ${g.blackCount}개 / 백 ${g.whiteCount}개</span><span class="res">${escapeHtml(res)}</span></button>
      <div class="ot-game-body" data-id="${escapeHtml(g.id)}"${open.has(g.id) ? '' : ' hidden'}><div class="ot-board mini">${otCellsHtml(g.board, null, false)}</div>
      ${photo}
      <div class="ot-acts"><button type="button" class="ot-btn" data-del="${escapeHtml(g.id)}">${ot.removing === g.id ? '정말 삭제' : '삭제'}</button></div></div></div>`;
  }).join('') : '<div class="empty">아직 저장한 경기가 없어요.</div>';
}
$('otGames').addEventListener('click', async (e) => {
  const head = e.target.closest('[data-open]');
  if (head) { const body = head.nextElementSibling; body.hidden = !body.hidden; head.setAttribute('aria-expanded', String(!body.hidden)); return; }
  const del = e.target.closest('[data-del]'); if (!del) return;
  const id = del.dataset.del;
  if (ot.removing !== id) { ot.removing = id; renderGames(); return; }   // 한 번 더 눌러야 지운다
  ot.removing = '';
  try { await store('readwrite', (s) => s.delete(id)); toast('경기를 지웠어요'); await refreshGames(); }
  catch { toast('지우지 못했어요. 다시 시도해 주세요.', true); }
});

refreshGames().catch(() => toast('기록을 열 수 없어요. 개인정보 보호 모드라면 일반 모드로 열어 주세요.', true));
// 저장 공간이 부족할 때 브라우저가 기록을 지우지 않도록 요청하고, 오프라인에서도 열리게 한다
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
