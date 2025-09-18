// app.js — Coloriage magique (fusion par rectangles)
'use strict';

// ===== Helpers ==========================================================
const qs = (s, el = document) => el.querySelector(s);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const mulberry32 = (a) => () => {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Coupe une chaîne en segments qui tiennent chacun dans maxWidth (mesure en px)
function splitByCharsToWidth(str, fontPx, maxWidth) {
  const out = [];
  let buf = '';
  for (const ch of String(str)) {
    const test = buf + ch;
    if (measureTextWidth(fontPx, test) <= maxWidth) {
      buf = test;
    } else {
      if (buf) out.push(buf);
      // Si même un seul char dépasse (très improbable), on le pousse quand même
      if (measureTextWidth(fontPx, ch) > maxWidth) out.push(ch);
      else buf = ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ===== Mesure de texte & mise en page dans un rectangle ===============
const _measureCanvas = document.createElement('canvas');
const _mctx = _measureCanvas.getContext('2d');

function setMeasureFont(px) {
  // Même pile de police que le SVG
  _mctx.font = `${px}px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;
}

function measureTextWidth(px, text) {
  setMeasureFont(px);
  return _mctx.measureText(text).width;
}

function wrapWordsToWidth(text, fontPx, maxWidth) {
  const paragraphs = String(text).split(/\r?\n/);
  const lines = [];

  for (const para of paragraphs) {
    if (para.trim() === '') { lines.push(''); continue; }

    const words = para.split(/\s+/).filter(w => w.length > 0);
    let line = '';

    for (const word of words) {
      const tryWithSpace = line ? (line + ' ' + word) : word;

      // 1) Si tout tient sur la ligne actuelle -> on ajoute
      if (measureTextWidth(fontPx, tryWithSpace) <= maxWidth) {
        line = tryWithSpace;
        continue;
      }

      // 2) Si le mot seul tient sur une ligne -> on pousse la ligne courante et on commence une nouvelle
      if (measureTextWidth(fontPx, word) <= maxWidth) {
        if (line) lines.push(line);
        line = word;
        continue;
      }

      // 3) Mot trop long : wrap par caractères
      const chunks = splitByCharsToWidth(word, fontPx, maxWidth);
      if (line) { lines.push(line); line = ''; }
      for (const chunk of chunks) {
        // On essaye de coller les chunks successifs sur la même ligne sans espace
        if (!line) line = chunk;
        else if (measureTextWidth(fontPx, line + chunk) <= maxWidth) line += chunk;
        else { lines.push(line); line = chunk; }
      }
    }

    if (line) lines.push(line);
  }

  return lines;
}


// Essaie de caser le texte dans (rw x rh) en horizontal; sinon en vertical
// Essaie de caser le texte dans (rw x rh) : compare H vs V et choisit le meilleur.
// La rotation verticale n'est autorisée que si le rectangle est plus haut que large.
function layoutTextInRect(text, rw, rh, {
  minPx = 10,
  maxPx = 28,
  padding = 0.1,
  verticalOnlyIfTaller = true,   // n'autorise vertical que si rh > rw
  preferVerticalWhenBetter = true // si vertical permet une police plus grande, on choisit vertical
} = {}) {
  const padX = rw * padding;
  const padY = rh * padding;
  const maxW = Math.max(0, rw - 2 * padX);
  const maxH = Math.max(0, rh - 2 * padY);

  // ---- Candidat HORIZONTAL ----
  let bestH = null;
  for (let fs = maxPx; fs >= minPx; fs--) {
    const lineHeight = Math.ceil(fs * 1.15);
    const lines = wrapWordsToWidth(text, fs, maxW);
    const totalH = lines.length * lineHeight;
    if (totalH <= maxH) {
      bestH = { vertical: false, fontPx: fs, lineHeight, lines, padX, padY };
      break;
    }
  }

  // ---- Candidat VERTICAL (seulement si rectangle "vertical" ou si on autorise) ----
  let bestV = null;
  const canVertical = !verticalOnlyIfTaller || rh > rw;
  if (canVertical) {
    for (let fs = maxPx; fs >= minPx; fs--) {
      const lineHeight = Math.ceil(fs * 1.1);
      // En vertical, on “wrap” à la hauteur (qui joue le rôle de largeur après rotation)
      const lines = wrapWordsToWidth(text, fs, Math.max(0, maxH));
      const totalH = lines.length * lineHeight;
      // Après rotation, la pile de lignes doit tenir dans la largeur disponible (ex-maxW)
      if (totalH <= Math.max(0, maxW)) {
        bestV = { vertical: true, fontPx: fs, lineHeight, lines, padX, padY };
        break;
      }
    }
  }

  // ---- Choix du meilleur ----
  if (bestH && bestV) {
    if (preferVerticalWhenBetter && bestV.fontPx > bestH.fontPx) return bestV;
    // à taille égale, on garde horizontal (plus naturel)
    if (bestV.fontPx > bestH.fontPx) return bestV;
    return bestH;
  }
  if (bestH) return bestH;
  if (bestV) return bestV;

  // ---- Dernier recours : si vertical possible, forcer vertical minPx en tronquant; sinon horizontal minPx
  if (canVertical) {
    const fs = minPx;
    const lineHeight = Math.ceil(fs * 1.1);
    let lines = wrapWordsToWidth(text, fs, Math.max(0, maxH));
    const maxLines = Math.max(1, Math.floor(maxW / lineHeight));
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
    return { vertical: true, fontPx: fs, lineHeight, lines, padX, padY };
  } else {
    const fs = minPx;
    const lineHeight = Math.ceil(fs * 1.15);
    let lines = wrapWordsToWidth(text, fs, maxW);
    const maxLines = Math.max(1, Math.floor(maxH / lineHeight));
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
    return { vertical: false, fontPx: fs, lineHeight, lines, padX, padY };
  }
}


// ===== K-means (simple) ================================================
function kmeans(points, k, maxIter = 24, seedVal = 1) {
  if (!points.length) return { centers: [], labels: [] };
  k = clamp(k, 1, points.length);
  const rand = mulberry32(seedVal);
  const centers = [];
  const used = new Set();
  while (centers.length < k) {
    const idx = Math.floor(rand() * points.length);
    if (!used.has(idx)) {
      used.add(idx);
      centers.push(points[idx].slice());
    }
  }
  const labels = new Array(points.length).fill(0);
  const dist2 = (a, b) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0,
        bestd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d2 = dist2(points[i], centers[c]);
        if (d2 < bestd) {
          bestd = d2;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const c = labels[i],
        p = points[i];
      sums[c][0] += p[0];
      sums[c][1] += p[1];
      sums[c][2] += p[2];
      sums[c][3]++;
    }
    for (let c = 0; c < k; c++)
      if (sums[c][3] > 0)
        centers[c] = [
          sums[c][0] / sums[c][3],
          sums[c][1] / sums[c][3],
          sums[c][2] / sums[c][3],
        ];
    if (!changed) break;
  }
  return { centers, labels };
}

// ===== Image ops =======================================================
function applyContrastSaturation(imgData, contrastVal, saturationVal) {
  const data = imgData.data;
  const C = clamp(contrastVal, -100, 100);
  const cf = (259 * (C + 255)) / (255 * (259 - C));
  const S = clamp(saturationVal, -100, 100);
  const sf = 1 + S / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = cf * (data[i] - 128) + 128;
    let g = cf * (data[i + 1] - 128) + 128;
    let b = cf * (data[i + 2] - 128) + 128;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * sf;
    g = luma + (g - luma) * sf;
    b = luma + (b - luma) * sf;
    data[i] = clamp(Math.round(r), 0, 255);
    data[i + 1] = clamp(Math.round(g), 0, 255);
    data[i + 2] = clamp(Math.round(b), 0, 255);
  }
  return imgData;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = async () => {
      try {
        if (typeof img.decode === 'function') await img.decode();
        if ((img.naturalWidth || img.width) === 0)
          return reject(new Error('Image sans dimensions.'));
        resolve(img);
      } catch (e) {
        if ((img.naturalWidth || img.width) > 0) resolve(img);
        else reject(new Error("Échec du décodage de l'image."));
      }
    };
    img.onerror = () =>
      reject(new Error("Impossible de charger l'image (fichier illisible)."));
    img.src = url;
  });
}

// ===== DOM refs ========================================================
const fileInput = qs('#fileInput');
const fileInfo = qs('#fileInfo');
const pixelPreview = qs('#pixelPreview');
const cols = qs('#cols'),
  colsVal = qs('#colsVal');
const numColors = qs('#numColors'),
  numColorsVal = qs('#numColorsVal');
const cellPx = qs('#cellPx'),
  cellPxVal = qs('#cellPxVal');
const mergeSameColor = qs('#mergeSameColor');
const contrast = qs('#contrast'),
  contrastVal = qs('#contrastVal');
const saturation = qs('#saturation'),
  saturationVal = qs('#saturationVal');
const exportPNG = qs('#exportPNG');
const statusEl = qs('#status');
const svgContainer = qs('#svgContainer');
const resultsInline = qs('#resultsInline');
const resultsList = qs('#resultsList');
const resetResults = qs('#resetResults');
const paletteBlock = qs('#paletteBlock');
const paletteList = qs('#paletteList');
const cellEditor = qs('#cellEditor');
const cellMeta = qs('#cellMeta');
const cellText = qs('#cellText');
const saveCellText = qs('#saveCellText');
const clearCellText = qs('#clearCellText');
const work = qs('#work');

// ===== State ============================================================
const state = {
  imageUrl: null,
  imageInfo: null,
  cols: 40,
  numColors: 6,
  seed: 1234,
  cellPx: 36,
  mergeSameColor: true,
  contrast: 0,
  saturation: 0,
  gridWidth: 0,
  gridHeight: 0,
  labels: [],
  palette: [],
 customResults: [],          // nombre par couleur
 customResultsEdited: false,  
 selectedColor: null,        // index choisi pour éditer
  // --- Fusion en rectangles ---
  mergedRects: [],            // [{id,x,y,w,h,k}]
  regionIdAt: new Int32Array(0), // mapping idx -> rect.id
  selectedRegionId: null,     // id du rectangle sélectionné
  manualTexts: new Map(),     // rectId -> texte
};

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b91c1c' : '#b45309';
}
function renderStatus() {
  if (!fileInfo) return;
  const i = state.imageInfo;
  fileInfo.textContent = i
    ? `Sélection : ${i.name || '-'} (${i.type || '-' }${
        i.size ? ', ' + Math.round(i.size / 1024) + ' Ko' : ''
      })`
    : '';
}

// ===== Events: chargement image ========================================
fileInput?.addEventListener('change', (e) => {
  const f = e.currentTarget.files && e.currentTarget.files[0];
  if (!f) return;
  const ok = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp',
  ]).has(f.type);
  if (!ok) {
    setStatus(
      `Format non supporté (${f.type || 'inconnu'}). Utilise PNG/JPEG/WEBP/GIF/BMP.`,
      true
    );
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.imageUrl = String(reader.result);
    state.imageInfo = { name: f.name, type: f.type, size: f.size };
    renderStatus();
    scheduleProcess();
  };
  reader.onerror = () => setStatus('Impossible de lire le fichier (FileReader).', true);
  reader.readAsDataURL(f);
});

// ===== Events: contrôles ===============================================
['input', 'change'].forEach((ev) => {
  cols?.addEventListener(ev, () => {
    state.cols = parseInt(cols.value, 10);
    colsVal.textContent = cols.value;
    scheduleProcess();
  });
  numColors?.addEventListener(ev, () => {
    state.numColors = parseInt(numColors.value, 10);
    numColorsVal.textContent = numColors.value;
    scheduleProcess();
  });
  cellPx?.addEventListener(ev, () => {
    state.cellPx = parseInt(cellPx.value, 10);
    cellPxVal.textContent = cellPx.value;
    redrawSVG();
  });
  mergeSameColor?.addEventListener(ev, () => {
    state.mergeSameColor = mergeSameColor.checked;
    redrawSVG();
  });
  contrast?.addEventListener(ev, () => {
    state.contrast = parseInt(contrast.value, 10);
    contrastVal.textContent = contrast.value;
    scheduleProcess();
  });
  saturation?.addEventListener(ev, () => {
    state.saturation = parseInt(saturation.value, 10);
    saturationVal.textContent = saturation.value;
    scheduleProcess();
  });
});

exportPNG?.addEventListener('click', openPNGInNewTab);
resetResults?.addEventListener('click', () => {
  state.customResults = state.palette.map((_, i) => i + 2);
  state.customResultsEdited = false; // <-- NOUVEAU
  renderResultsEditor();
  redrawSVG();
});


saveCellText?.addEventListener('click', () => {
  if (state.selectedRegionId == null) return;
  const txt = cellText.value || '';
  if (txt) state.manualTexts.set(state.selectedRegionId, txt);
  else state.manualTexts.delete(state.selectedRegionId);
  redrawSVG();
});
clearCellText?.addEventListener('click', () => {
  cellText.value = '';
  saveCellText.click();
});

// ===== Traitement image & aperçu =======================================
let processTimer = null;
function scheduleProcess() {
  clearTimeout(processTimer);
  processTimer = setTimeout(processImage, 60);
}

async function processImage() {
  if (!state.imageUrl) return;
  setStatus('Traitement…');
  try {
    const img = await loadImage(state.imageUrl);
    const iw = img.naturalWidth || img.width || 0;
    const ih = img.naturalHeight || img.height || 0;
    if (iw === 0 || ih === 0) throw new Error("Dimensions d'image invalides.");

    const ratio = ih / iw || 1;
    const gw = clamp(Math.min(state.cols, iw), 4, Math.max(4, iw));
    const gh = clamp(Math.round(gw * ratio), 4, Math.max(4, ih));
    state.gridWidth = gw;
    state.gridHeight = gh;

    const ctx = work.getContext('2d', { willReadFrequently: true });
    work.width = gw;
    work.height = gh;
    ctx.clearRect(0, 0, gw, gh);
    ctx.drawImage(img, 0, 0, gw, gh);

    let imgData = ctx.getImageData(0, 0, gw, gh);
    imgData = applyContrastSaturation(imgData, state.contrast, state.saturation);
    ctx.putImageData(imgData, 0, 0);

    const points = new Array(gw * gh);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        points[y * gw + x] = [imgData.data[i], imgData.data[i + 1], imgData.data[i + 2]];
      }

    const { centers, labels } = kmeans(points, state.numColors, 24, state.seed);
    state.labels = labels;
    state.palette = centers.map((c) => [
      Math.round(c[0]),
      Math.round(c[1]),
      Math.round(c[2]),
    ]);

    if (!state.customResults.length || state.customResults.length !== state.palette.length) {
      state.customResults = state.palette.map((_, i) => i + 2);
    }

    // Reset édition
    state.selectedColor = null;
    state.selectedRegionId = null;
    state.manualTexts.clear();
    state.customResultsEdited = false;

    // >>> Fusion en rectangles (sur toute la grille)
    rebuildRectangles();

    renderResultsEditor();
    renderPalette();
    renderPixelPreview(gw, gh, labels, state.palette);
    redrawSVG();
    setStatus('');
  } catch (e) {
    console.error(e);
    setStatus(e?.message || "Échec du traitement de l'image.", true);
  }
}

function renderPixelPreview(gw, gh, labels, palette) {
  if (!pixelPreview) return;
  const parent = pixelPreview.parentElement;
  const availW = Math.max(1, parent?.clientWidth || pixelPreview.clientWidth || 320);
  const maxH = 260;
  let scale = Math.floor(Math.min(availW / gw, maxH / gh));
  if (!Number.isFinite(scale) || scale < 1) scale = 1;
  pixelPreview.width = gw * scale;
  pixelPreview.height = gh * scale;
  pixelPreview.style.width = `${gw * scale}px`;
  pixelPreview.style.height = `${gh * scale}px`;
  const ctx = pixelPreview.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const k = labels[y * gw + x];
      const [r, g, b] = palette[k];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
}

window.addEventListener('resize', () => {
  const gw = state.gridWidth || 0,
    gh = state.gridHeight || 0;
  if (gw && gh && state.labels.length && state.palette.length)
    renderPixelPreview(gw, gh, state.labels, state.palette);
});

// Click-away: si on est en mode édition par couleur, un clic hors
// de la grille, de la palette ou de l'éditeur => on quitte le mode.
document.addEventListener('click', (e) => {
  if (state.selectedColor == null) return;

  const isInsidePalette = e.target.closest('#paletteBlock');
  const isInsideGrid    = e.target.closest('#svgContainer');
  const isInsideEditor  = e.target.closest('#cellEditor');

  if (!isInsidePalette && !isInsideGrid && !isInsideEditor) {
    exitEditMode();
  }
}, true); // capture = true pour choper le clic le plus tôt possible

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') exitEditMode();
});
// ===== Résultats par couleur ===========================================
function renderResultsEditor() {
  if (!resultsInline || !resultsList) return;
  if (!state.palette.length) {
    resultsInline.hidden = true;
    resultsList.innerHTML = '';
    return;
  }
  resultsInline.hidden = false;
  resultsList.innerHTML = '';
  state.palette.forEach((c, i) => {
    const row = document.createElement('label');
    row.className = 'resultRow';

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;

    const name = document.createElement('span');
    name.className = 'muted small';
    name.textContent = `Couleur ${i + 1}`;

    const lab = document.createElement('span');
    lab.className = 'muted small';
    lab.textContent = 'Valeur :';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '9999';
    input.value = state.customResults[i] ?? i + 2;
input.addEventListener('input', () => {
  const n = Number(input.value);
  const prev = state.customResults[i] ?? i + 2;
  state.customResults[i] = Number.isFinite(n)
    ? clamp(Math.round(n), 0, 9999)
    : prev;

  // <-- NOUVEAU : si la valeur n'est plus la valeur par défaut, on considère "édité"
  const isDefault = state.customResults[i] === (i + 2);
  if (!isDefault) state.customResultsEdited = true;

  redrawSVG();
});

    row.append(sw, name, lab, input);
    resultsList.append(row);
  });
}

// ===== Palette & sélection de couleur ==================================
function renderPalette() {
  if (!paletteBlock || !paletteList) return;
  if (!state.palette.length) {
    paletteBlock.hidden = true;
    paletteList.innerHTML = '';
    return;
  }
  paletteBlock.hidden = false;
  paletteList.innerHTML = '';
  state.palette.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatchBtn';
    btn.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    btn.setAttribute('aria-label', `Sélectionner la couleur ${i + 1}`);
    btn.setAttribute('aria-pressed', state.selectedColor === i ? 'true' : 'false');
    btn.addEventListener('click', () => {
      state.selectedColor = state.selectedColor === i ? null : i;
      state.selectedRegionId = null;
      cellEditor.hidden = state.selectedColor == null;
      updateCellMeta();
      renderPalette();
      redrawSVG();
    });
    paletteList.append(btn);
  });
}

function exitEditMode() {
  if (state.selectedColor == null) return;
  state.selectedColor = null;
  state.selectedRegionId = null;
  cellEditor.hidden = true;
  updateCellMeta();
  renderPalette(); // met à jour l’état aria-pressed des pastilles
  redrawSVG();     // réaffiche toute la grille
}


function updateCellMeta() {
  if (!cellMeta) return;
  if (state.selectedRegionId == null) {
    cellMeta.textContent =
      state.selectedColor == null
        ? 'Aucune'
        : 'Clique un rectangle de cette couleur dans la grille.';
    cellText.value = '';
    return;
  }
  const rect = state.mergedRects.find(r => r.id === state.selectedRegionId);
  if (!rect) {
    cellMeta.textContent = 'Aucune';
    cellText.value = '';
    return;
  }
  const v = state.customResults[rect.k] ?? 0;
  cellMeta.textContent = `Rectangle (${rect.x + 1}, ${rect.y + 1}) — ${rect.w}×${rect.h} — Couleur ${rect.k + 1} (valeur par défaut: ${v})`;
  cellText.value = state.manualTexts.get(rect.id) || '';
}

// ===== Fusion en rectangles ============================================
// Tuilage glouton : pour chaque cellule non visitée, on étend un rectangle
// de largeur max à droite, puis on empile autant de lignes que possible
// en réduisant la largeur si nécessaire. Résultat : partition en rectangles.
function rebuildRectangles() {
  const W = state.gridWidth, H = state.gridHeight;
  const labels = state.labels;
  const visited = new Uint8Array(W * H);
  const rects = [];
  const map = new Int32Array(W * H);
  map.fill(-1);

  let nextId = 0;

  const runLen = (x0, y0, k) => {
    let x = x0;
    while (x < W) {
      const idx = y0 * W + x;
      if (visited[idx] || labels[idx] !== k) break;
      x++;
    }
    return x - x0;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (visited[idx]) continue;
      const k = labels[idx];

      // largeur initiale sur la ligne courante
      let w = runLen(x, y, k);
      if (w <= 0) continue;

      // empilement vertical avec rétrécissement éventuel
      let h = 1;
      while (y + h < H) {
        const w2 = runLen(x, y + h, k);
        if (w2 === 0) break;
        w = Math.min(w, w2);
        if (w === 0) break;
        // Vérifier que la bande [x, x+w) de la ligne y+h est libre et de la bonne couleur
        let ok = true;
        for (let xx = 0; xx < w; xx++) {
          const i2 = (y + h) * W + (x + xx);
          if (visited[i2] || labels[i2] !== k) { ok = false; break; }
        }
        if (!ok) break;
        h++;
      }

      // marquage et enregistrement du rectangle
      const id = nextId++;
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const i2 = (y + yy) * W + (x + xx);
          visited[i2] = 1;
          map[i2] = id;
        }
      }
      rects.push({ id, x, y, w, h, k });
    }
  }

  state.mergedRects = rects;
  state.regionIdAt = map;
}

// ===== Rendu SVG =======================================================
function redrawSVG() {
  if (!svgContainer) return;
  const W = state.gridWidth,
    H = state.gridHeight;
  const labels = state.labels,
    palette = state.palette;
  if (!W || !H || !labels.length || !palette.length) {
    svgContainer.innerHTML = "<div class='muted'>La grille s'affichera ici.</div>";
    return;
  }

  const cell = clamp(state.cellPx, 16, 200);
  const Wpx = W * cell;
  const Hpx = H * cell;
  const selectedK = state.selectedColor;

  let s = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  s += `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${Wpx} ${Hpx}' width='100%' preserveAspectRatio='xMidYMid meet'>`;
  s += `<rect x='0' y='0' width='${Wpx}' height='${Hpx}' fill='white'/>`;

// --- Fond par rectangle : couleur réelle si affiché, gris foncé si masqué ---
for (const r of state.mergedRects) {
  if (selectedK == null) {
    // Grille vierge (blanc), rien d'affiché niveau couleurs
    s += `<rect x='${r.x * cell}' y='${r.y * cell}' width='${r.w * cell}' height='${r.h * cell}' fill='white'/>`;
  } else {
    if (r.k === selectedK) {
      const [rr, gg, bb] = state.palette[r.k] || [255, 255, 255];
      s += `<rect x='${r.x * cell}' y='${r.y * cell}' width='${r.w * cell}' height='${r.h * cell}' fill='rgb(${rr},${gg},${bb})'/>`;
    } else {
      s += `<rect x='${r.x * cell}' y='${r.y * cell}' width='${r.w * cell}' height='${r.h * cell}' class='cell-dim'/>`;
    }
  }
}

// --- Texte : manuel (par rectangle) sinon valeur de la couleur --------
for (const r of state.mergedRects) {
  if (selectedK != null && r.k !== selectedK) continue;

  // 1) Texte manuel prioritaire
  let raw = state.manualTexts.get(r.id);

  // 2) Sinon, on n'affiche PAS les résultats par couleur tant
  //    qu'on n'a pas édité au moins une valeur côté "résultats".
  if (!raw && state.customResultsEdited) {
    raw = String(state.customResults[r.k] ?? '');
  }

  if (!raw) continue; // <-- rien à afficher -> case vierge

  const rw = r.w * cell, rh = r.h * cell;
  const cx = r.x * cell + rw / 2, cy = r.y * cell + rh / 2;

  const layout = layoutTextInRect(raw, rw, rh, {
    minPx: 10, maxPx: 28, padding: 0.1,
    verticalOnlyIfTaller: true, preferVerticalWhenBetter: true
  });
  const startY = cy - ((layout.lines.length - 1) * layout.lineHeight) / 2;

  if (!layout.vertical) {
    s += `<text x='${cx}' y='${startY}' font-size='${layout.fontPx}' text-anchor='middle' dominant-baseline='alphabetic'>`;
    layout.lines.forEach((line, i) => {
      const dy = i === 0 ? 0 : layout.lineHeight;
      s += `<tspan x='${cx}' dy='${dy}'>${escapeXML(line)}</tspan>`;
    });
    s += `</text>`;
  } else {
    const tx = cx, ty = cy;
    const pad = layout.fontPx * 0.3;          // ton petit padding vertical
    const startYv = startY + pad;

    s += `<g transform='rotate(-90 ${tx} ${ty})'>`;
    s += `<text x='${tx}' y='${startYv}' font-size='${layout.fontPx}' text-anchor='middle' dominant-baseline='alphabetic'>`;
    layout.lines.forEach((line, i) => {
      const dy = i === 0 ? 0 : layout.lineHeight;
      s += `<tspan x='${tx}' dy='${dy}'>${escapeXML(line)}</tspan>`;
    });
    s += `</text></g>`;
  }
}


  // --- Traits : si fusion activée, on trace les rectangles; sinon grille pixel ----
  if (state.mergeSameColor) {
    for (const r of state.mergedRects) {
      // en mode édition, garder tous les traits pour guider la sélection
      s += `<rect x='${r.x * cell}' y='${r.y * cell}' width='${r.w * cell}' height='${r.h * cell}' fill='none' stroke='black' stroke-width='1' shape-rendering='crispEdges'/>`;
    }
  } else {
    for (let y = 0; y <= H; y++)
      s += `<line x1='0' y1='${y * cell}' x2='${Wpx}' y2='${y * cell}' class='gridline'/>`;
    for (let x = 0; x <= W; x++)
      s += `<line x1='${x * cell}' y1='0' x2='${x * cell}' y2='${Hpx}' class='gridline'/>`;
  }

  // --- Surbrillance du rectangle sélectionné ---------------------------
  if (state.selectedRegionId != null) {
    const r = state.mergedRects.find(rr => rr.id === state.selectedRegionId);
    if (r) {
      s += `<rect x='${r.x * cell + 1}' y='${r.y * cell + 1}' width='${r.w * cell - 2}' height='${r.h * cell - 2}' fill='none' class='hl'/>`;
    }
  }

  s += `</svg>`;
  svgContainer.innerHTML = s;

  // Click handler : en mode "Éditer par couleur", sélectionner le RECTANGLE
  const svg = svgContainer.querySelector('svg');
  svg.addEventListener(
    'click',
    (ev) => {
      if (state.selectedColor == null) return; // seulement en mode édition par couleur
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const screenCTM = svg.getScreenCTM();
      if (!screenCTM) return;
      const p = pt.matrixTransform(screenCTM.inverse());
      const gx = clamp(Math.floor(p.x / cell), 0, W - 1);
      const gy = clamp(Math.floor(p.y / cell), 0, H - 1);
      const idx = gy * W + gx;
      const rid = state.regionIdAt[idx];
      if (rid < 0) return;
      const rect = state.mergedRects.find(r => r.id === rid);
      if (!rect) return;
      if (rect.k !== state.selectedColor) return; // on ignore les autres couleurs en édition
      state.selectedRegionId = rid;
      updateCellMeta();
      redrawSVG(); // pour dessiner la surbrillance
    },
    { once: true }
  );
}

function escapeXML(s) {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[ch]);
}

// ===== Export PNG ======================================================
// ===== Export PNG (avec légende sous la grille) ========================
function openPNGInNewTab() {
  const svg = svgContainer?.querySelector('svg');
  if (!svg) return;

  // Taille du SVG (zone grille)
  const vb = svg.getAttribute('viewBox');
  let W = 0, H = 0;
  if (vb) {
    const p = vb.trim().split(/\s+/);
    if (p.length === 4) {
      W = Math.round(parseFloat(p[2]));
      H = Math.round(parseFloat(p[3]));
    }
  }
  if (!W || !H) {
    W = Math.round(parseFloat(svg.getAttribute('width')) || 0);
    H = Math.round(parseFloat(svg.getAttribute('height')) || 0);
  }
  if (!W || !H) {
    alert('Impossible de déterminer la taille du SVG.');
    return;
  }

  // Sérialiser le SVG de la grille
  const xml = new XMLSerializer().serializeToString(svg);
  const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
  const img = new Image();

  img.onload = () => {
    // ---- Préparer les données de légende ----
    // On montre toujours la légende : (couleur -> valeur actuelle)
    const entries = state.palette.map((rgb, i) => ({
      color: rgb || [255, 255, 255],
      value: (state.customResults && Number.isFinite(state.customResults[i]))
        ? String(state.customResults[i])
        : String(i + 2) // valeur par défaut
    }));

    // Mise en page de la légende
    const pad = 18;             // marge extérieure
    const titleH = 22;          // hauteur du titre
    const gapY = 10;            // espacement vertical
    const itemH = 26;           // hauteur d'un item
    const itemW = 160;          // largeur allouée par item (swatch + texte)
    const sw = 18;              // taille swatch
    const gap = 10;             // swatch <-> texte

    const cols = Math.max(1, Math.floor((W - pad * 2) / itemW));
    const rows = Math.ceil(entries.length / cols);
    const legendH = pad + titleH + gapY + (rows * itemH) + pad;

    // Canvas final = grille + légende
    const outCanvas = document.createElement('canvas');
    outCanvas.width = W;
    outCanvas.height = H + legendH;
    const ctx = outCanvas.getContext('2d');

    // Fond blanc
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);

    // Dessiner la grille (image du SVG) en haut
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, W, H);

    // Réactiver l’AA pour le texte de la légende
    ctx.imageSmoothingEnabled = true;

    // Titre de la légende
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Résultats par couleur', pad, H + pad + 16);

    // Items
    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    const baseY = H + pad + titleH + gapY;

    entries.forEach((e, idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const x0 = pad + col * itemW;
      const y0 = baseY + row * itemH;

      // swatch
      ctx.fillStyle = `rgb(${e.color[0]},${e.color[1]},${e.color[2]})`;
      ctx.fillRect(x0, y0 + (itemH - sw) / 2, sw, sw);
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + (itemH - sw) / 2 + 0.5, sw - 1, sw - 1);

      // texte (valeur)
      ctx.fillStyle = '#111827';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.value, x0 + sw + gap, y0 + itemH / 2);
    });

    // Export PNG
    const dataURL = outCanvas.toDataURL('image/png');
    const win = window.open();
    if (win) {
      win.document.write(
        `<!doctype html><html><head><meta charset='utf-8'>
         <title>Export PNG — ${W}×${H + legendH}px</title>
         <style>
           html,body{margin:0;padding:16px;background:#111;color:#eee;font:14px system-ui}
           .info{margin:0 0 8px;color:#aaa}
           img{display:block;image-rendering:pixelated;image-rendering:crisp-edges}
         </style></head><body>
         <p class='info'>${W} × ${H + legendH} px (grille + légende)</p>
         <img src='${dataURL}' width='${W}' height='${H + legendH}' alt='Grille exportée'>
         </body></html>`
      );
      win.document.close();
    }
  };

  img.src = src;
}


// ===== Init ============================================================
setStatus('');
redrawSVG();
