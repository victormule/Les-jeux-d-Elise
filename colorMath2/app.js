// app.js — Coloriage magique (fusion par rectangles)
'use strict';

// ===== Helpers généraux =================================================
const qs = (s, el = document) => el.querySelector(s);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const mulberry32 = (a) => () => {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Coupe une chaîne en segments qui tiennent chacun dans maxWidth (px)
function splitByCharsToWidth(str, fontPx, maxWidth) {
  const out = [];
  let buf = '';
  for (const ch of String(str)) {
    const test = buf + ch;
    if (measureTextWidth(fontPx, test) <= maxWidth) {
      buf = test;
    } else {
      if (buf) out.push(buf);
      // Si même un seul caractère dépasse, on le pousse quand même
      if (measureTextWidth(fontPx, ch) > maxWidth) out.push(ch);
      else buf = ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ===== RGB <-> HSL + features HSL circulaires ===========================
// (une seule définition, pas de doublon)

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l]; // h ∈ [0,1]
}

function hslToRgb(h, s, l) {
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Vecteur de features HSL “circulaire” (priorité teinte/saturation)
function hslFeature(r, g, b, wH = 2.6, wS = 1.5, wL = 0.50) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const ang = 2 * Math.PI * h;
  return [Math.cos(ang) * wH, Math.sin(ang) * wH, s * wS, l * wL];
}

// ===== Histogramme de couleurs exactes (pour mode palette exacte) ======
function buildHistogram(imgData) {
  const d = imgData.data;
  const map = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]; if (a < 10) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const key = (r << 16) | (g << 8) | b;
    map.set(key, (map.get(key) || 0) + 1);
  }
  // [{ rgb:[r,g,b], count }, …] trié par fréquence décroissante
  return Array.from(map.entries())
    .map(([key, count]) => ({ rgb: [(key >> 16) & 255, (key >> 8) & 255, key & 255], count }))
    .sort((a, b) => b.count - a.count);
}

// ===== Mesure de texte & mise en page dans un rectangle =================
const _measureCanvas = document.createElement('canvas');
const _mctx = _measureCanvas.getContext('2d');

function setMeasureFont(px) {
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

      // 1) si tout tient sur la ligne actuelle
      if (measureTextWidth(fontPx, tryWithSpace) <= maxWidth) {
        line = tryWithSpace;
        continue;
      }

      // 2) le mot seul tient -> on pousse la ligne et on repart
      if (measureTextWidth(fontPx, word) <= maxWidth) {
        if (line) lines.push(line);
        line = word;
        continue;
      }

      // 3) mot trop long -> wrap caractère par caractère
      const chunks = splitByCharsToWidth(word, fontPx, maxWidth);
      if (line) { lines.push(line); line = ''; }
      for (const chunk of chunks) {
        if (!line) line = chunk;
        else if (measureTextWidth(fontPx, line + chunk) <= maxWidth) line += chunk;
        else { lines.push(line); line = chunk; }
      }
    }

    if (line) lines.push(line);
  }
  return lines;
}


// ===== Helpers Projet (image & signatures) ==============================

// Charge une image à partir d'un dataURL et la met dans state.sourceImage
function loadImageFromDataURL(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { state.sourceImage = img; resolve(); };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// Signature stable pour un rectangle fusionné (couleur + position + taille)
function rectSig(r) {
  return `${r.k}|${r.x},${r.y},${r.w},${r.h}`;
}

// Convertit les Maps (par id) en tableaux indexés par signature (plus robuste)
function mapsBySignature(rects, manualTexts, manualFontPx) {
  const byId = new Map(rects.map(r => [r.id, r]));
  const texts = [];
  const fonts = [];
  for (const [id, val] of manualTexts.entries()) {
    const r = byId.get(id); if (r) texts.push({ sig: rectSig(r), value: val });
  }
  for (const [id, val] of manualFontPx.entries()) {
    const r = byId.get(id); if (r) fonts.push({ sig: rectSig(r), value: val });
  }
  return { texts, fonts };
}

// Re-applique textes/tailles à partir des signatures sur les rectangles actuels
function applyFromSignatures(rects, textsArr, fontsArr, state) {
  const sigToId = new Map(rects.map(r => [rectSig(r), r.id]));
  state.manualTexts.clear();
  state.manualFontPx.clear();
  for (const t of (textsArr || [])) {
    const id = sigToId.get(t.sig);
    if (id != null) state.manualTexts.set(id, t.value);
  }
  for (const f of (fontsArr || [])) {
    const id = sigToId.get(f.sig);
    if (id != null && Number.isFinite(+f.value)) state.manualFontPx.set(id, +f.value);
  }
}
// ===== Sérialisation complète du projet ================================
function serializeProject() {
  const imageDataURL = state.sourceImageDataURL || null; // image source encodée

  const params = {
    cellPx: state.cellPx,
    cols: state.gridWidth,        // nb de colonnes
    numColors: state.numColors,
    contrast: state.contrast,
    saturation: state.saturation,
    mergeSameColor: !!state.mergeSameColor
  };

  const palette = Array.isArray(state.palette) ? state.palette.slice() : [];
  const results = Array.isArray(state.customResults) ? state.customResults.slice() : [];

  const { texts, fonts } = mapsBySignature(state.mergedRects || [], state.manualTexts, state.manualFontPx);

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    imageDataURL,
    params,
    palette,
    results,
    manualTextsBySig: texts,
    manualFontPxBySig: fonts
  };
}

// ===== Réimport d’un projet ============================================
async function deserializeProject(proj) {
  if (!proj || proj.version !== 1) throw new Error('Version de projet incompatible');

  // 1) Image
  if (!proj.imageDataURL) throw new Error("Le projet ne contient pas d'image.");
  state.sourceImageDataURL = proj.imageDataURL;
  await loadImageFromDataURL(state.sourceImageDataURL);

  // 2) Paramètres (puis synchroniser les sliders)
  state.cellPx         = proj.params?.cellPx         ?? state.cellPx;
  state.numColors      = proj.params?.numColors      ?? state.numColors;
  state.contrast       = proj.params?.contrast       ?? state.contrast;
  state.saturation     = proj.params?.saturation     ?? state.saturation;
  state.mergeSameColor = !!proj.params?.mergeSameColor;

  setRange('#cellPx', state.cellPx, '#cellPxVal');
  setRange('#numColors', state.numColors, '#numColorsVal');
  setRange('#contrast', state.contrast, '#contrastVal');
  setRange('#saturation', state.saturation, '#saturationVal');
  const mergeEl = document.querySelector('#mergeSameColor');
  if (mergeEl) mergeEl.checked = state.mergeSameColor;

  // 3) Résultats par couleur (texte)
  state.customResults = Array.isArray(proj.results) ? proj.results.slice() : [];

  // 4) Recalcul de la grille à partir de l’image + paramètres
  await processImage();

  // 5) Recolle les textes & tailles par signatures
  applyFromSignatures(state.mergedRects || [], proj.manualTextsBySig, proj.manualFontPxBySig, state);

  // UI finale
  renderResultsEditor?.();
  redrawSVG?.();
}

// petit helper pour synchroniser un slider et son label
function setRange(sel, v, outSel) {
  const el = document.querySelector(sel);
  const out = outSel ? document.querySelector(outSel) : null;
  if (el) el.value = String(v);
  if (out) out.textContent = String(v);
}


// Essaie de caser le texte dans (rw x rh) en horizontal; sinon en vertical
// Essaie de caser le texte dans (rw x rh) : compare H vs V et choisit le meilleur.
// La rotation verticale n'est autorisée que si le rectangle est plus haut que large.
function layoutTextInRect(
  text, rw, rh,
  { minPx = 10, maxPx = 28, padding = 0.1 } = {}
) {
  const padX = rw * padding;
  const padY = rh * padding;
  const maxW = Math.max(0, rw - 2 * padX); // largeur dispo (après padding)
  const maxH = Math.max(0, rh - 2 * padY); // hauteur dispo (après padding)

  const isVerticalRect = rh > rw;

  // --------- helpers internes ----------
  const tryHorizontalMultiline = () => {
    for (let fs = maxPx; fs >= minPx; fs--) {
      const lineHeight = Math.ceil(fs * 1.15);
      const lines = wrapWordsToWidth(text, fs, maxW); // gère aussi les mots longs
      const totalH = lines.length * lineHeight;
      if (totalH <= maxH) {
        return { vertical: false, fontPx: fs, lineHeight, lines, padX, padY };
      }
    }
    return null;
  };

  const tryVerticalSingleLine = () => {
    // Rotation -90° : la "longueur" de la ligne se projette sur la hauteur (maxH),
    // et l'épaisseur de la ligne (sa hauteur de police) doit tenir dans la largeur (maxW).
    for (let fs = maxPx; fs >= minPx; fs--) {
      const textWidth = measureTextWidth(fs, text); // largeur non-rotée
      const lineHeight = Math.ceil(fs * 1.1);       // épaisseur de la ligne
      if (textWidth <= maxH && lineHeight <= maxW) {
        return { vertical: true, fontPx: fs, lineHeight, lines: [text], padX, padY };
      }
    }
    return null;
  };

  const tryVerticalMultiline = () => {
    // En vertical, on wrappe par rapport à maxH (qui joue le rôle de largeur après rotation),
    // et la pile de lignes doit tenir dans maxW (épaisseur cumulée).
    for (let fs = maxPx; fs >= minPx; fs--) {
      const lineHeight = Math.ceil(fs * 1.1);
      const lines = wrapWordsToWidth(text, fs, Math.max(0, maxH)); // wrap mots & char
      const totalThickness = lines.length * lineHeight; // se projette sur maxW
      if (totalThickness <= maxW) {
        return { vertical: true, fontPx: fs, lineHeight, lines, padX, padY };
      }
    }
    // Ultime secours : forcer minPx et tronquer
    const fs = minPx;
    const lineHeight = Math.ceil(fs * 1.1);
    let lines = wrapWordsToWidth(text, fs, Math.max(0, maxH));
    const maxLines = Math.max(1, Math.floor(maxW / lineHeight));
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
    return { vertical: true, fontPx: fs, lineHeight, lines, padX, padY };
  };

  // --------- stratégie selon la forme du rectangle ----------
  if (isVerticalRect) {
    // 1) VERTICAL 1 ligne (prioritaire)
    const v1 = tryVerticalSingleLine();
    if (v1) return v1;

    // 2) HORIZONTAL multi-lignes (plus lisible que vertical wrap si possible)
    const h = tryHorizontalMultiline();
    if (h) return h;

    // 3) Dernier recours : VERTICAL multi-lignes
    return tryVerticalMultiline();
  } else {
    // Rectangle plutôt horizontal : on reste horizontal d'abord
    const h = tryHorizontalMultiline();
    if (h) return h;

    // secours : vertical multi-lignes
    return tryVerticalMultiline();
  }
}


function kmeans(points, k, maxIter=24, seedVal=1, minSep=0.22){
  if(!points.length) return { centers:[], labels:[] };
  const d = points[0].length;              // dimension auto (ici 4)
  k = Math.min(Math.max(1,k), points.length);
  const rand = mulberry32(seedVal);

  // --- k-means++ init (centres bien répartis) --------------------------
  const centers = [];
  const first = points[Math.floor(rand()*points.length)];
  centers.push(first.slice());

  const dist2pt = (p, c) => {
    let s=0; for(let j=0;j<d;j++){ const dv=p[j]-c[j]; s+=dv*dv; } return s;
  };

  while(centers.length<k){
    // D^2 vers centre le plus proche
    const D2 = points.map(p=>{
      let m=Infinity;
      for(let c=0;c<centers.length;c++){
        const v=dist2pt(p, centers[c]); if(v<m) m=v;
      }
      return m;
    });
    // tirage proportionnel à D^2
    let sum = 0; for(const v of D2) sum+=v;
    let r = rand()*sum;
    let idx = 0;
    for(let i=0;i<D2.length;i++){ r-=D2[i]; if(r<=0){ idx=i; break; } }
    centers.push(points[idx].slice());
  }

  // petite répulsion si deux centres sont trop proches
  const minSep2 = minSep*minSep;
  function reseedCloseCenters(){
    for(let a=0;a<centers.length;a++){
      for(let b=a+1;b<centers.length;b++){
        let s=0; for(let j=0;j<d;j++){ const dv=centers[a][j]-centers[b][j]; s+=dv*dv; }
        if(s<minSep2){
          // re-seed b au point le plus loin de tout centre
          let bestI=0,bestD=-1;
          for(let i=0;i<points.length;i++){
            // distance au plus proche centre (après avoir écarté "a")
            let m=Infinity;
            for(let c=0;c<centers.length;c++){
              const v=dist2pt(points[i], centers[c]);
              if(v<m) m=v;
            }
            if(m>bestD){ bestD=m; bestI=i; }
          }
          centers[b]=points[bestI].slice();
        }
      }
    }
  }
  reseedCloseCenters();

  // --- itérations -------------------------------------------------------
  const labels = new Array(points.length).fill(0);
  for(let it=0; it<maxIter; it++){
    let changed=false;
    // assignation
    for(let i=0;i<points.length;i++){
      let best=0, bd=Infinity;
      for(let c=0;c<centers.length;c++){
        const v=dist2pt(points[i], centers[c]);
        if(v<bd){ bd=v; best=c; }
      }
      if(labels[i]!==best){ labels[i]=best; changed=true; }
    }
    // recompute
    const sums = Array.from({length:k}, ()=>new Array(d+1).fill(0));
    for(let i=0;i<points.length;i++){
      const c=labels[i], p=points[i];
      for(let j=0;j<d;j++) sums[c][j]+=p[j];
      sums[c][d]++;
    }
    for(let c=0;c<k;c++){
      const cnt=sums[c][d];
      if(cnt>0){
        for(let j=0;j<d;j++) centers[c][j]=sums[c][j]/cnt;
      }
    }
    reseedCloseCenters();
    if(!changed) break;
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
const work = qs('#work');
const fontPxInput = qs('#cellFontPx');
const resetCellFont = qs('#resetCellFont');
const zoomInBtn = qs('#zoomIn');
const zoomOutBtn = qs('#zoomOut');
const zoomResetBtn = qs('#zoomReset');
const zoomLabel = qs('#zoomLabel');
const exportProjectBtn   = qs('#exportProject');
const importProjectInput = qs('#importProjectInput');


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
  manualFontPx: new Map(), // rectId -> nombre (px); absent = auto
zoom: 1,          // facteur de zoom (1 = 100%)
minZoom: 0.5,     // 50%
maxZoom: 6,       // 600%
zoomStep: 0.25,   // pas de zoom

};
// Un seul handler de clic SVG, persistant
let svgClickHandler = null;

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
    'image/png','image/jpeg','image/webp','image/gif','image/bmp',
  ]).has(f.type);
  if (!ok) {
    setStatus(`Format non supporté (${f.type || 'inconnu'}). Utilise PNG/JPEG/WEBP/GIF/BMP.`, true);
    return;
  }

  // (facultatif mais sympa) : maj de l’infos fichier affichée
  state.imageInfo = { name: f.name, type: f.type, size: f.size };
  renderStatus?.();

  const reader = new FileReader();
  reader.onload = async (evt) => {
    state.sourceImageDataURL = evt.target.result;        // dataURL de l’image
    const img = new Image();
    img.onload = async () => {
      state.sourceImage = img;                           // image en mémoire
      await processImage();                              // -> utilise sourceImage
      renderResultsEditor?.();
      redrawSVG?.();
    };
    img.src = state.sourceImageDataURL;
  };
  reader.readAsDataURL(f); // <--- IMPORTANT : f (pas "file")
});


// ====== Projet : exporter / importer ===================================
exportProjectBtn?.addEventListener('click', () => {
  try {
    const data = JSON.stringify(serializeProject(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `coloriage-projet-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
    a.href = url; a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    alert('Impossible d’exporter le projet.');
  }
});

importProjectInput?.addEventListener('change', async () => {
  const file = importProjectInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const proj = JSON.parse(text);
    await deserializeProject(proj);
  } catch (e) {
    console.error(e);
    alert('Fichier de projet invalide.');
  } finally {
    importProjectInput.value = '';
  }
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
  state.customResults = state.palette.map(() => ''); // <-- vide
  state.customResultsEdited = false; // <-- NOUVEAU
  renderResultsEditor();
  redrawSVG();
});


fontPxInput?.addEventListener('input', () => {
  if (state.selectedRegionId == null) return;
  const v = parseInt(fontPxInput.value, 10);
  if (Number.isFinite(v)) {
    const px = clamp(v, 8, 48);
    state.manualFontPx.set(state.selectedRegionId, px);
  } else {
    state.manualFontPx.delete(state.selectedRegionId); // auto
  }
  redrawSVG();
});

// Auto-sauvegarde du texte de la cellule
cellText?.addEventListener('input', () => {
  if (state.selectedRegionId == null) return;
  const txt = cellText.value;
  if (txt && txt.trim().length) {
    state.manualTexts.set(state.selectedRegionId, txt);
  } else {
    state.manualTexts.delete(state.selectedRegionId); // si vide -> on supprime
  }
  redrawSVG();
});


resetCellFont?.addEventListener('click', () => {
  if (state.selectedRegionId == null) return;
  state.manualFontPx.delete(state.selectedRegionId);
  fontPxInput.value = '';
  redrawSVG();
});

function setZoom(z) {
  state.zoom = clamp(z, state.minZoom, state.maxZoom);
  zoomLabel && (zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`);
  // Pas besoin de recalculer le SVG — on ajuste sa taille juste après redraw
  redrawSVG();
}
zoomInBtn?.addEventListener('click', () => setZoom(state.zoom + state.zoomStep));
zoomOutBtn?.addEventListener('click', () => setZoom(state.zoom - state.zoomStep));
zoomResetBtn?.addEventListener('click', () => setZoom(1));


// ===== Traitement image & aperçu =======================================
let processTimer = null;
function scheduleProcess() {
  clearTimeout(processTimer);
  processTimer = setTimeout(processImage, 60);
}

async function processImage() {
  setStatus('Traitement…');

  try {
    // 1) Récupérer l'image : prioriser l'image déjà chargée en mémoire
    let img = state.sourceImage || null;

    // Si pas d'image en mémoire mais une URL existe (ancien flux), on la charge
    if (!img && state.imageUrl) {
      img = await loadImage(state.imageUrl);
      state.sourceImage = img; // mise en cache
      // Si c'est un dataURL, pense à le garder
      if (!state.sourceImageDataURL && typeof state.imageUrl === 'string' && state.imageUrl.startsWith('data:')) {
        state.sourceImageDataURL = state.imageUrl;
      }
    }

    // Rien à traiter si aucune image
    if (!img) { setStatus('Charge une image pour commencer.'); return; }

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

    // K = entre 2 et 12 (toujours max 12)
// K demandé par l'UI, borné à 12
// K demandé par l'UI, borné à 12
const K = clamp(state.numColors, 2, 12);

// 1) Palette exacte si l'image n'a pas plus de K couleurs uniques
const uniq = buildHistogram(imgData); // trié par fréquence
if (uniq.length > 0 && uniq.length <= K) {
  // --- utiliser EXACTEMENT les couleurs de l'image ---
  state.palette = uniq.map(u => u.rgb);

  // assigner les labels par couleur exacte (rapide et sans perte)
  const keyToIdx = new Map();
  uniq.forEach((u, idx) => {
    const k = (u.rgb[0] << 16) | (u.rgb[1] << 8) | u.rgb[2];
    keyToIdx.set(k, idx);
  });

  const labelsArr = new Uint16Array(gw * gh);
  const d = imgData.data;
  for (let p = 0, px = 0; p < d.length; p += 4, px++) {
    const k = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
    labelsArr[px] = keyToIdx.get(k) ?? 0; // sécurité
  }
  state.labels = labelsArr;

} else {
  // 2) Sinon, k-means++ en HSL 4D (teinte/sat prioritaires)
  const points = new Array(gw * gh);
  const d = imgData.data;
  for (let p = 0, px = 0; p < d.length; p += 4, px++) {
    points[px] = hslFeature(d[p], d[p + 1], d[p + 2], 2.6, 1.5, 0.50);
  }

  const { centers, labels } = kmeans(points, K, 24, state.seed || 1, 0.22);
  state.labels = labels;

  // convertir centres -> HSL -> RGB (avec légère “vividisation”)
  state.palette = centers.map((c) => {
    const ch = c[0] / 2.6, sh = c[1] / 2.6; // / wH
    let h = Math.atan2(sh, ch); if (h < 0) h += 2 * Math.PI; h /= (2 * Math.PI);
    const s = clamp(c[2] / 1.5, 0, 1);      // / wS
    let   l = clamp(c[3] / 0.50, 0, 1);     // / wL

    const s2 = Math.min(1, s < 0.10 ? s : Math.max(s, 0.36) * 1.08);
    const l2 = (s < 0.10) ? l : clamp(l * 0.97 + 0.02, 0, 1);

    const [R, G, B] = hslToRgb(h, s2, l2);
    return [R, G, B];
  });
}


    if (!state.customResults.length || state.customResults.length !== state.palette.length) {
      state.customResults = state.palette.map(() => '');
    }

    // Reset édition
// Reset édition
state.selectedColor = null;
state.selectedRegionId = null;
state.manualTexts.clear();
state.customResultsEdited = false;
state.manualFontPx.clear();

    // >>> Fusion en rectangles (sur toute la grille)
    rebuildRectangles();

    renderResultsEditor();
    renderPalette();
    renderPixelPreview(gw, gh, state.labels, state.palette);
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
    input.type = 'text';
    input.value = state.customResults[i] ?? i + 2;
    input.placeholder = '…';
input.addEventListener('input', () => {
  state.customResults[i] = input.value;  // <-- stocke tel quel (string)
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
  const v = state.customResults[rect.k] ?? '';
cellMeta.textContent =
  `Rectangle (${rect.x + 1}, ${rect.y + 1}) — ${rect.w}×${rect.h} — Couleur ${rect.k + 1}` +
  (v ? ` (valeur par défaut: ${v})` : '');

  cellText.value = state.manualTexts.get(rect.id) || '';
  const key = rect.id;
cellText.value = state.manualTexts.get(key) || '';

const fpx = state.manualFontPx.get(key);
fontPxInput.value = (typeof fpx === 'number' && Number.isFinite(fpx)) ? String(fpx) : '';
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

// --- Texte : uniquement le texte MANUEL par rectangle ------------------
for (const r of state.mergedRects) {
  if (selectedK != null && r.k !== selectedK) continue;

  // ❌ plus de fallback vers state.customResults
  const raw = state.manualTexts.get(r.id) || '';
  if (!raw) continue;

  const rw = r.w * cell, rh = r.h * cell;
  const cx = r.x * cell + rw / 2, cy = r.y * cell + rh / 2;

const overridePx = state.manualFontPx.get(r.id);
const layout = layoutTextInRect(raw, rw, rh, {
  minPx: (typeof overridePx === 'number') ? overridePx : 10,
  maxPx: (typeof overridePx === 'number') ? overridePx : 28,
  padding: 0.1
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
    const pad = layout.fontPx * 0.3;
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

  // === Injection dans un wrapper scrollable dimensionné au zoom ===
  const wrapW = Math.round(Wpx * state.zoom);
  const wrapH = Math.round(Hpx * state.zoom);

  // Le SVG lui-même garde sa taille "native" (Wpx x Hpx), on l'étire via le wrapper
  // en lui donnant width/height = taille zoomée.
  const html =
    `<div class="svgInner" style="width:${wrapW}px;height:${wrapH}px">` +
      // on donne au SVG une taille CSS = zoomée (pas 100%), le parent scrollera
      s.replace(
        "<svg ",
        `<svg style="width:${wrapW}px;height:${wrapH}px" `
      ) +
    `</div>`;

  svgContainer.innerHTML = html;

  const svg = svgContainer.querySelector('svg');






svgClickHandler = (ev) => {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const screenCTM = svg.getScreenCTM();
  if (!screenCTM) return;

  const p = pt.matrixTransform(screenCTM.inverse());
  const cell = clamp(state.cellPx, 16, 200);
  const W = state.gridWidth, H = state.gridHeight;

  const gx = clamp(Math.floor(p.x / cell), 0, W - 1);
  const gy = clamp(Math.floor(p.y / cell), 0, H - 1);
  const idx = gy * W + gx;
  const rid = state.regionIdAt[idx];
  if (rid < 0) return;

  const rect = state.mergedRects.find(r => r.id === rid);
  if (!rect) return;

  // Si on est déjà en mode édition d'une couleur ET que la cellule cliquée
  // n'est pas de cette couleur, on ignore (comportement actuel)
  if (state.selectedColor != null && rect.k !== state.selectedColor) {
    return;
  }

  // Si on n'était PAS en mode édition, on y entre automatiquement
  if (state.selectedColor == null) {
    state.selectedColor = rect.k;
    cellEditor.hidden = false;      // affiche le panneau d'édition
    renderPalette();                // met à jour l'état des pastilles
  }

  // Sélectionner le rectangle
  state.selectedRegionId = rid;
  updateCellMeta();
  redrawSVG(); // pour dessiner la surbrillance

  // Confort : focus sur le champ texte
  setTimeout(() => {
    const input = document.getElementById('cellText');
    if (input) input.focus({ preventScroll: false });
  }, 0);
};

svg.addEventListener('click', svgClickHandler);
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
  value: String(state.customResults?.[i] ?? '')  // <-- texte libre, peut être vide
}));


    // Mise en page de la légende
    const pad = 18;             // marge extérieure
    const titleH = 22;          // hauteur du titre
    const gapY = 12;            // espacement vertical
    const itemH = 26;           // hauteur d'un item
    const itemW = 160;          // largeur allouée par item (swatch + texte)
    const sw = 28;              // taille swatch
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