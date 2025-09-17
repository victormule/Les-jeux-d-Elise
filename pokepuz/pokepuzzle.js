// ==================== Sélection des éléments ====================
const titleScreen = document.getElementById('titleScreen');
const titleForm   = document.getElementById('titleForm');
const playerNameI = document.getElementById('playerName');
const opSelect    = document.getElementById('op');
const piecesInput = document.getElementById('pieces');

const hud         = document.getElementById('hud');
const playerBadge = document.getElementById('playerBadge');
const opBadge     = document.getElementById('opBadge');
const timerEl     = document.getElementById('timer');
const errorsBadge = document.getElementById('errorsBadge');

const fleeBtn     = document.getElementById('flee');
const quitBtn     = document.getElementById('quit');

const layout      = document.getElementById('gameLayout');
const gridEl      = document.getElementById('grid');
const trayLeft    = document.getElementById('trayLeft');
const trayRight   = document.getElementById('trayRight');
const dropHint    = document.getElementById('dropHint');

const collectionGrid = document.getElementById('collectionGrid');
const toastEl     = document.getElementById('toast');

const gameOver    = document.getElementById('gameOver');
const summary     = document.getElementById('summary');
const againBtn    = document.getElementById('again');
const closeModal  = document.getElementById('closeModal');
const printDiplomaBtn = document.getElementById('printDiploma');

const diploma     = document.getElementById('diploma');
const dPlayer     = document.getElementById('dPlayer');
const dLeague     = document.getElementById('dLeague');
const dTeam       = document.getElementById('dTeam');

const openDiplomaBtn = document.getElementById('openDiploma');

const workCanvas  = document.getElementById('workCanvas');

// ==================== État global ====================
const state = {
  rows: 0,
  cols: 0,
  n: 0,
  img: null,
  imgUrl: null,
  mapping: [],
  placed: 0,
  startTime: 0,
  timerInterval: null,
  player: '',
  op: '+',
  desiredPieces: 16,
  currentPokemon: null, // 1..151
  captured: [],         // [{num, src}]
  targetTeam: 6,
  round: 0,
  errors: 0,
  maxErrors: 3,
  active: false,
};

// ==================== Utilitaires ====================
const cssNum = (name) =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

function formatTime(s) {
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

function resetTimer() {
  clearInterval(state.timerInterval);
  timerEl.textContent = '00:00';
}
function startTimer() {
  resetTimer();
  state.startTime = Date.now();
  state.timerInterval = setInterval(() => {
    const t = Math.floor((Date.now() - state.startTime) / 1000);
    timerEl.textContent = formatTime(t);
  }, 500);
}

function updateErrorsBadge() {
  if (errorsBadge) errorsBadge.textContent = `Erreurs : ${state.errors}/${state.maxErrors}`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'sync';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function bestGridForImage(desired, W, H) {
  const min = 4, max = 100;
  const want = Math.max(min, Math.min(max, parseInt(desired || 16, 10)));
  const targetRatio = W / H;
  let best = { rows: 1, cols: want, total: want, score: Infinity };

  for (let total = min; total <= max; total++) {
    for (let r = 1; r <= Math.sqrt(total); r++) {
      if (total % r) continue;
      const c = total / r;
      const ratio = c / r;
      const aspectErr = Math.abs(Math.log(ratio / targetRatio));
      const wantErr = Math.abs(total - want) * 0.03;
      const score = aspectErr + wantErr;
      if (score < best.score) best = { rows: r, cols: c, total, score };
    }
  }
  return best;
}

function createCalculSet(n, op) {
  const list = [];
  const used = new Set();
  const R = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  const push = (a, b, res) => {
    const key = `${a}|${b}|${op}`;
    if (used.has(key)) return false;
    used.add(key);
    list.push({ a, b, op, res });
    return true;
  };

  let guard = 0;
  while (list.length < n && guard < n * 200) {
    let a, b, res;
    if (op === '+') { a = R(1, 80); b = R(1, 80); res = a + b; }
    else if (op === '-') { a = R(1, 150); b = R(0, a); res = a - b; }
    else if (op === '×') { a = R(2, 20); b = R(2, 20); res = a * b; }
    else { res = R(2, 30); b = R(2, 20); a = b * res; } // ÷ exact
    push(a, b, res);
    guard++;
  }

  let i = 2;
  while (list.length < n) {
    let a, b, res;
    if (op === '+') { a = i; b = i + 30; res = a + b; }
    else if (op === '-') { a = i + 100; b = i; res = a - b; }
    else if (op === '×') { a = (i % 19) + 2; b = ((i * 3) % 19) + 2; res = a * b; }
    else { const q = (i % 49) + 2; b = ((i * 7) % 19) + 2; a = b * q; res = q; }
    push(a, b, res);
    i++;
  }
  return list;
}

// ==================== Construction / reset UI ====================
function clearUI() {
  gridEl.innerHTML = '';
  gridEl.appendChild(dropHint);
  dropHint.classList.remove('hidden');

  trayLeft.innerHTML = '<h3 class="tray-title">Pièces</h3>';
  trayRight.innerHTML = '<h3 class="tray-title">Pièces</h3>';
}

function renderCollection() {
  collectionGrid.innerHTML = '';
  const total = state.targetTeam;
  for (let i = 0; i < total; i++) {
    const slot = document.createElement('div');
    slot.className = 'collection-slot';
    const caught = state.captured[i];
    if (caught) {
      const img = document.createElement('img');
      img.src = caught.src;
      img.alt = `Pokémon #${caught.num}`;
      slot.appendChild(img);
    } else {
      slot.textContent = `${i + 1}/6`;
    }
    collectionGrid.appendChild(slot);
  }
}

// ==================== Drag & Drop ====================
let currentDrag = null;

function makePieceDraggable(piece) {
  piece.draggable = true;
  piece.addEventListener('dragstart', (e) => {
    currentDrag = piece;
    piece.classList.add('dragging');
    e.dataTransfer.setData('text/plain', piece.dataset.answer);
  });
  piece.addEventListener('dragend', () => {
    piece.classList.remove('dragging');
    currentDrag = null;
  });
}

function wireCellDND(cell, expectedAnswer) {
  cell.addEventListener('dragover', (e) => e.preventDefault());
  cell.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!state.active || !currentDrag || cell.classList.contains('correct')) return;

    const ans = currentDrag.dataset.answer;
    if (String(expectedAnswer) === String(ans)) {
      cell.classList.add('correct');
      currentDrag.remove();
      state.placed++;
      if (state.placed === state.n) onPuzzleComplete();
    } else {
      cell.classList.add('wrong');
      setTimeout(() => cell.classList.remove('wrong'), 300);
      state.errors++;
      updateErrorsBadge();
      if (state.errors >= state.maxErrors) onPokemonEscaped(false);
      else toast(`Mauvaise case (${state.errors}/${state.maxErrors}).`);
    }
  });
}

// ==================== Construction d'un round ====================
async function pickRandomPokemon() {
  const capturedNums = new Set(state.captured.map(c => c.num));
  const pool = [];
  for (let i = 1; i <= 151; i++) if (!capturedNums.has(i)) pool.push(i);
  const list = (pool.length ? pool : Array.from({ length: 151 }, (_, k) => k + 1));

  for (let tries = 0; tries < 10; tries++) {
    const num = list[Math.floor(Math.random() * list.length)];
    const url = `1G/${num}.png`;
    try {
      const img = await loadImage(url);
      return { num, url, img };
    } catch {}
  }
  const num = Math.floor(Math.random() * 151) + 1;
  return { num, url: `1G/${num}.png`, img: await loadImage(`1G/${num}.png`) };
}

function buildGridAndPieces(img, rows, cols, calcs) {
  gridEl.style.gridTemplateColumns = `repeat(${cols}, var(--tile))`;
  gridEl.style.gridTemplateRows = `repeat(${rows}, var(--tile))`;

  state.n = rows * cols;
  state.mapping = [];
  state.placed = 0;

  const sw = img.naturalWidth / cols;
  const sh = img.naturalHeight / rows;

  for (let idx = 0; idx < state.n; idx++) {
    const r = Math.floor(idx / cols);
    const c = idx % cols;

    const cell = document.createElement('div');
    cell.className = 'cell';

    const inner = document.createElement('div');
    inner.className = 'flip-inner';

    const front = document.createElement('div');
    front.className = 'front';
    const eq = calcs[idx];
    front.textContent = `${eq.a} ${eq.op} ${eq.b}`;

    const back = document.createElement('div');
    back.className = 'back';
    const tileCanvas = document.createElement('canvas');
    const tw = Math.round(sw);
    const th = Math.round(sh);
    tileCanvas.width = tw;
    tileCanvas.height = th;
    const ctx = tileCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      img,
      Math.round(c * sw), Math.round(r * sh), Math.round(sw), Math.round(sh),
      0, 0, tw, th
    );
    back.appendChild(tileCanvas);

    inner.appendChild(front);
    inner.appendChild(back);
    cell.appendChild(inner);
    gridEl.appendChild(cell);

    wireCellDND(cell, eq.res);
    state.mapping.push({ idx, result: eq.res });
  }

  // Pièces SANS image Pokémon (seulement le nombre), fond pokéball via CSS
  const answers = calcs.map(c => c.res);
  const order = shuffle([...answers]);

  order.forEach((res, i) => {
    const piece = document.createElement('div');
    piece.className = 'piece';
    piece.dataset.answer = String(res);

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = res;
    piece.appendChild(label);

    makePieceDraggable(piece);
    (i % 2 === 0 ? trayLeft : trayRight).appendChild(piece);
  });

  // Masquer l’indication "déposez ici" une fois la grille prête
  dropHint.classList.add('hidden');
}

async function startRound() {
  state.active = false;
  clearUI();
  state.round += 1;

  state.errors = 0;
  updateErrorsBadge();

  let picked;
  try {
    picked = await pickRandomPokemon();
  } catch (e) {
    toast("Impossible de charger l'image. Réessaie.");
    return;
  }
  state.currentPokemon = picked.num;
  state.imgUrl = picked.url;
  state.img = picked.img;

  const grid = bestGridForImage(state.desiredPieces, state.img.naturalWidth, state.img.naturalHeight);
  state.rows = grid.rows;
  state.cols = grid.cols;
  const calcs = createCalculSet(grid.total, state.op);

  buildGridAndPieces(state.img, state.rows, state.cols, calcs);
  fitGridToViewport();

  startTimer();
  opBadge.textContent = `Opération : ${state.op}`;
  state.active = true;
}

function fitGridToViewport() {
  const maxW = gridEl.parentElement.clientWidth - 12;
  const maxH = window.innerHeight - (hud.clientHeight + 280); // marge pour trays & équipe
  const cols = state.cols, rows = state.rows;
  if (!cols || !rows) return;

  const gap = cssNum('--grid-gap');
  const tileW = Math.floor(Math.min(
    (maxW - (cols - 1) * gap - 12) / cols,
    (maxH - (rows - 1) * gap - 12) / rows,
    120
  ));
  document.documentElement.style.setProperty('--tile', `${Math.max(48, tileW)}px`);
}

// ==================== Fin de puzzle / capture / fuite ====================
function onPuzzleComplete() {
  if (!state.active) return;
  state.active = false;
  clearInterval(state.timerInterval);

  const num = state.currentPokemon;
  const src = state.imgUrl;
  state.captured.push({ num, src });
  renderCollection();
  toast(`Pokémon #${num} capturé !`);

  Array.from(gridEl.querySelectorAll('.cell')).forEach(c => c.classList.add('correct'));

  if (state.captured.length >= state.targetTeam) {
    const totalTime = Math.floor((Date.now() - state.startTime) / 1000);
    summary.textContent =
      `${state.player}, tu as complété ton équipe de 6 Pokémon en ${formatTime(totalTime)}.`;
    gameOver.classList.remove('hidden');
  } else {
    setTimeout(() => startRound(), 900);
  }
}

function onPokemonEscaped(manual = false) {
  if (!state.active) return;
  state.active = false;
  clearInterval(state.timerInterval);
  toast(manual ? "Tu as fui le combat. Un autre Pokémon apparaît !" :
                 `Oh non ! Le Pokémon s'est enfui (${state.errors}/${state.maxErrors}).`);
  gridEl.style.opacity = '0.6';
  setTimeout(() => {
    gridEl.style.opacity = '';
    startRound();
  }, 700);
}

// ==================== Diplôme ====================
function fillDiploma() {
  dPlayer.textContent = state.player || '';
  const league = (state.op === '+') ? 'Addition'
    : (state.op === '-') ? 'Soustraction'
    : (state.op === '×') ? 'Multiplication'
    : 'Division';
  dLeague.textContent = league;

  dTeam.innerHTML = '';
  state.captured.slice(0, 6).forEach(p => {
    const img = document.createElement('img');
    img.src = p.src;
    img.alt = `Pokémon #${p.num}`;
    dTeam.appendChild(img);
  });
}

function printDiploma() {
  fillDiploma();
  diploma.classList.remove('hidden');
  window.print();
  setTimeout(() => diploma.classList.add('hidden'), 300);
}

// ==================== Navigation / événements ====================
titleForm.addEventListener('submit', (e) => {
  e.preventDefault();
  state.player = playerNameI.value.trim();
  state.op = opSelect.value;
  state.desiredPieces = Math.max(4, Math.min(100, parseInt(piecesInput.value || '16', 10)));

  if (!state.player) {
    toast('Entre ton prénom pour commencer.');
    return;
  }

  playerBadge.textContent = `Joueur : ${state.player}`;
  opBadge.textContent = `Opération : ${state.op}`;

  titleScreen.classList.add('hidden');
  hud.classList.remove('hidden');
  layout.classList.remove('hidden');

  renderCollection();
  startRound();
});

if (fleeBtn) {
  fleeBtn.addEventListener('click', () => onPokemonEscaped(true));
}

quitBtn.addEventListener('click', () => {
  clearInterval(state.timerInterval);
  state.round = 0;
  state.img = null;
  state.imgUrl = null;
  state.currentPokemon = null;
  state.placed = 0;
  state.errors = 0;
  updateErrorsBadge();

  hud.classList.add('hidden');
  layout.classList.add('hidden');
  titleScreen.classList.remove('hidden');
  resetTimer();
  clearUI();
});

againBtn.addEventListener('click', () => {
  gameOver.classList.add('hidden');
  state.captured = [];
  state.errors = 0;
  updateErrorsBadge();
  renderCollection();
  startRound();
});
closeModal.addEventListener('click', () => gameOver.classList.add('hidden'));
printDiplomaBtn.addEventListener('click', () => printDiploma());

// Bouton “Voir le diplôme” (aperçu à tout moment)
if (openDiplomaBtn) {
  openDiplomaBtn.addEventListener('click', () => {
    fillDiploma();
    diploma.classList.remove('hidden');
  });
}
// fermer le diplôme en cliquant en dehors de la carte
diploma.addEventListener('click', (e) => {
  if (e.target === diploma) diploma.classList.add('hidden');
});
// fermer avec Echap
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !diploma.classList.contains('hidden')) {
    diploma.classList.add('hidden');
  }
});

// Ajustements responsive
window.addEventListener('resize', fitGridToViewport);

// Init
renderCollection();
resetTimer();
updateErrorsBadge();