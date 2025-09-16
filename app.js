'use strict'
/*
  Coloriage Magique — app.js (version avec conversions & temps enrichis)
  ✓ Aperçu PIXELLISÉ net (responsive)
  ✓ Grille SVG responsive
  ✓ Résultats par couleur sous la grille
  ✓ Export PNG 1:1
  ✓ K-means, contraste/saturation, fusion cellules
  ✓ Banques d’énoncés riches (add/sub/mult/div + conversions + temps)
*/

/*********************************
 * Helpers
 *********************************/
const qs = (s, el=document) => el.querySelector(s)
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const MAX_FONT_SIZE = 14

const mulberry32 = (a) => () => { let t = (a += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

/*********************************
 * K-means simple (RGB)
 *********************************/
function kmeans(points, k, maxIter = 24, seedVal = 1) {
  if (!points.length) return { centers: [], labels: [] }
  k = clamp(k, 1, points.length)
  const rand = mulberry32(seedVal)
  const centers = []
  const used = new Set()
  while (centers.length < k) { const idx = Math.floor(rand() * points.length); if (!used.has(idx)) { used.add(idx); centers.push(points[idx].slice()) } }
  const labels = new Array(points.length).fill(0)
  const dist2 = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2
  for (let it=0; it<maxIter; it++) {
    let changed = false
    for (let i=0; i<points.length; i++) {
      let best=0, bestd=Infinity
      for (let c=0; c<centers.length; c++) { const d2 = dist2(points[i], centers[c]); if (d2 < bestd) { bestd=d2; best=c } }
      if (labels[i] !== best) { labels[i]=best; changed=true }
    }
    const sums = Array.from({length:k}, () => [0,0,0,0])
    for (let i=0; i<points.length; i++) { const c=labels[i], p=points[i]; sums[c][0]+=p[0]; sums[c][1]+=p[1]; sums[c][2]+=p[2]; sums[c][3]++ }
    for (let c=0; c<k; c++) if (sums[c][3]>0) centers[c] = [ sums[c][0]/sums[c][3], sums[c][1]/sums[c][3], sums[c][2]/sums[c][3] ]
    if (!changed) break
  }
  return { centers, labels }
}

/*********************************
 * Fusion rectangles (même label)
 *********************************/
function mergeRectangles(labels, W, H) {
  const rects=[]
  const visited = new Uint8Array(W*H)
  const at = (x,y)=> labels[y*W + x]
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    const idx = y*W + x
    if (visited[idx]) continue
    const k = at(x,y)
    let w=1; while (x+w<W && !visited[y*W+(x+w)] && at(x+w,y)===k) w++
    let h=1, ok=true
    while (y+h<H && ok) {
      for (let xx=0; xx<w; xx++) if (visited[(y+h)*W + (x+xx)] || at(x+xx, y+h)!==k) { ok=false; break }
      if (ok) h++
    }
    for (let yy=0; yy<h; yy++) for (let xx=0; xx<w; xx++) visited[(y+yy)*W + (x+xx)] = 1
    rects.push({ x, y, w, h, k })
  }
  return rects
}

/*********************************
 * Image utils (contraste / saturation / chargement)
 *********************************/
function applyContrastSaturation(imgData, contrastVal, saturationVal) {
  const data = imgData.data
  const C = clamp(contrastVal, -100, 100)
  const cf = (259 * (C + 255)) / (255 * (259 - C))
  const S = clamp(saturationVal, -100, 100)
  const sf = 1 + S / 100
  for (let i=0; i<data.length; i+=4) {
    let r = cf * (data[i] - 128) + 128
    let g = cf * (data[i+1] - 128) + 128
    let b = cf * (data[i+2] - 128) + 128
    const luma = 0.2126*r + 0.7152*g + 0.0722*b
    r = luma + (r - luma) * sf
    g = luma + (g - luma) * sf
    b = luma + (b - luma) * sf
    data[i]   = clamp(Math.round(r), 0, 255)
    data[i+1] = clamp(Math.round(g), 0, 255)
    data[i+2] = clamp(Math.round(b), 0, 255)
  }
  return imgData
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image(); img.decoding = 'async'
    img.onload = async () => {
      try { if (typeof img.decode === 'function') await img.decode(); if ((img.naturalWidth||img.width)===0) return reject(new Error('Image sans dimensions.')); resolve(img) }
      catch(e) { if ((img.naturalWidth||img.width)>0) resolve(img); else reject(new Error("Échec du décodage de l'image.")) }
    }
    img.onerror = () => reject(new Error("Impossible de charger l'image (fichier illisible)."))
    img.src = url
  })
}

/*********************************
 * Opérations (génération + layout)
 *********************************/
function layoutExpression(expr, rw, rh) {
  const pad = Math.floor(0.08 * Math.min(rw, rh))
  const availW = Math.max(1, rw - 2*pad)
  const availH = Math.max(1, rh - 2*pad)
  const estWidth = (text, fs) => Math.ceil((text.length || 1) * fs * 0.6)
  const lineHeight = (fs) => Math.round(fs * 1.2)
  const fs0 = Math.min(MAX_FONT_SIZE, Math.max(6, Math.floor(Math.min(availH*0.42, (availW/Math.max(1,expr.length))/0.6))))
  if (fs0 >= 10 && estWidth(expr, fs0) <= availW) return { mode:'h', lines:[expr], font:fs0, pad }
  const tokens = expr.split(/\s+/).filter(Boolean)
  const isOp = (t) => t==='+' || t==='-' || t==='×' || t==='÷'
  for (let fs=Math.min(MAX_FONT_SIZE, Math.max(6, Math.floor(availH*0.42))); fs>=6; fs--) {
    const lines=[]; let current=''
    for (let i=0; i<tokens.length; i++) {
      const t=tokens[i]; const cand = current ? current + ' ' + t : t
      if (estWidth(cand, fs) <= availW) current=cand
      else { if (current) lines.push(current); if (isOp(t)) { lines.push(t); current='' } else { current=t; if (estWidth(current, fs) > availW) { current=''; break } } }
    }
    if (current) lines.push(current)
    if (!lines.length) continue
    const totalH = lines.length * lineHeight(fs)
    if (totalH <= availH) return { mode:'v', lines, font:fs, pad }
  }
  return { mode:'none', lines:[], font:0, pad }
}

/*********************************
 * Banque d’énoncés pour un résultat donné
 *********************************/
function exprBankForResult(target, mode, rng, difficulty='facile'){
  if (!mode) return []
  const list=[]
  const pushUnique = (s) => { if (s && !list.includes(s)) list.push(s) }

  // small utils (format décimal FR)
  const fmtFr = (n, maxDec=2) => {
    const f = Number.isInteger(n) ? String(n) : Number(n.toFixed(maxDec)).toString()
    const [a,b] = f.split('.')
    return b ? `${a},${b.replace(/0+$/,'')}` : a
  }
  const between = (n, a, b) => n>=a && n<=b

  // --- Modes classiques
  const add2=()=>{ for(let a=0;a<=target;a++){ const b=target-a; if(b>=0) pushUnique(`${a} + ${b}`) } }
  const sub2=()=>{ for(let a=target;a<=target+40;a++){ const b=a-target; if(b>=0) pushUnique(`${a} - ${b}`) } }
  const mult2=()=>{ for(let a=1;a<=20;a++){ if(target%a===0){ const b=target/a; if(b>=1&&b<=20) pushUnique(`${a} × ${b}`) } } }
  const div2 =()=>{ for(let b=1;b<=20;b++){ const a=target*b; if(a<=800) pushUnique(`${a} ÷ ${b}`) } }

  if (["add","addsub","mix"].includes(mode)) add2()
  if (["addsub","mix"].includes(mode)) sub2()
  if (["mult","multdiv","mix"].includes(mode)) mult2()
  if (["multdiv","mix"].includes(mode)) div2()

  const maxN = difficulty==='facile'?0:(difficulty==='moyen'?12:20)
  if (maxN>0){
    if (["add","addsub","mix"].includes(mode)){
      for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++){ const c=target-a-b; if(c>=0&&c<=maxN) pushUnique(`${a} + ${b} + ${c}`) }
      if (difficulty==='difficile'){
        for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++){ const c=a+b-target; if(c>=0&&c<=maxN) pushUnique(`${a} + ${b} - ${c}`) }
      }
    }
    if (["mult","multdiv","mix"].includes(mode)){
      const lim=Math.max(12,Math.min(20,maxN))
      for(let a=1;a<=lim;a++) for(let b=1;b<=lim;b++){ const prod=a*b; const cAdd=target-prod; if(cAdd>=0&&cAdd<=maxN) pushUnique(`${a} × ${b} + ${cAdd}`); const cSub=prod-target; if(cSub>=0&&cSub<=maxN) pushUnique(`${a} × ${b} - ${cSub}`) }
    }
    if (difficulty==='difficile' && ["mult","multdiv","mix"].includes(mode)){
      for(let a=1;a<=12;a++) for(let b=1;b<=12;b++) for(let c=1;c<=12;c++){ if(a*b % c === 0 && (a*b)/c === target) pushUnique(`(${a} × ${b}) ÷ ${c}`) }
    }
    if (difficulty==='difficile'){
      if (["add","addsub","mix"].includes(mode)){
        for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++) for(let c=0;c<=maxN;c++){ const d=target-a-b-c; if(d>=0&&d<=maxN) pushUnique(`${a} + ${b} + ${c} + ${d}`) }
        for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++) for(let c=0;c<=maxN;c++){ const d=a+b+c-target; if(d>=0&&d<=maxN) pushUnique(`${a} + ${b} + ${c} - ${d}`) }
      }
      if (["mult","multdiv","mix"].includes(mode)){
        const lim=12
        for(let a=1;a<=lim;a++) for(let b=1;b<=lim;b++) for(let c=0;c<=maxN;c++){
          const prod=a*b
          const dAdd=target-prod-c; if(dAdd>=0&&dAdd<=maxN) pushUnique(`${a} × ${b} + ${c} + ${dAdd}`)
          const dSub=prod+c-target; if(dSub>=0&&dSub<=maxN) pushUnique(`${a} × ${b} + ${c} - ${dSub}`)
          const dSub2=prod-c-target; if(dSub2>=0&&dSub2<=maxN) pushUnique(`${a} × ${b} - ${c} - ${dSub2}`)
        }
        for(let a=1;a<=lim;a++) for(let b=1;b<=lim;b++) for(let c=1;c<=lim;c++){
          if(a*b % c === 0){
            const base=(a*b)/c
            const d=target-base
            if(d>=0&&d<=maxN) pushUnique(`(${a} × ${b}) ÷ ${c} + ${d}`)
          }
        }
      }
    }
  }

  /************* MODE CONVERSIONS (unités différentes, pas de composantes 0, décimaux possibles dans la question) *************/
  if (mode === 'unites') {
    // Longueurs: mm, cm, m, km
    // Masses: g, kg
    // Volumes: mL, L
    // Règles:
    // - L'unité demandée (après "=? ...") est différente des unités présentes dans l'énoncé
    // - On évite 0 composant
    // - On autorise des valeurs décimales dans l'énoncé (formatées en FR: virgule)

    // --- Longueurs vers mm (réponse en mm) : question sans mm
    // m + cm -> ? mm
    {
      const aMax = Math.floor(target/1000)
      for (let a=1; a<=aMax; a++) {
        const rest = target - 1000*a
        if (rest>=10 && rest%10===0) {
          const b = rest/10
          if (b>=1) pushUnique(`${a} m ${b} cm = ? mm`)
        }
      }
      // cm décimal -> ? mm (ex: 12,3 cm = ? mm)
      if (target>=1) {
        for (let d=1; d<=9; d++) { // 1 décimale
          if ((target - d) % 10 === 0) {
            const cm = (target - d)/10 + d/10
            if (cm>0) pushUnique(`${fmtFr(cm)} cm = ? mm`)
          }
        }
      }
      // m décimal -> ? mm (ex: 1,234 m = ? mm)
      if (target%1000===0) {
        const m = target/1000
        if (m>=1) pushUnique(`${fmtFr(m)} m = ? mm`)
      }
    }

    // --- Longueurs vers cm (réponse en cm) : question sans cm
    // m + mm -> ? cm
    {
      const aMax = Math.floor(target/100)
      for (let a=1; a<=aMax; a++) {
        const mm = 10*(target - 100*a)
        if (mm>=10) pushUnique(`${a} m ${mm} mm = ? cm`)
      }
      // km + m -> ? cm (si multiple de 100)
      if (target%100===0) {
        const totM = target/100
        if (totM>=2) {
          const a = Math.max(1, Math.floor(totM/2000))
          const b = totM - 1000*a
          if (a>=1 && b>=1) pushUnique(`${a} km ${b} m = ? cm`)
        }
      }
      // m décimal -> ? cm
      if (target%100===0) {
        const m = target/100
        if (m>0) pushUnique(`${fmtFr(m)} m = ? cm`)
      }
    }

    // --- Longueurs vers m (réponse en m) : question sans m
    // km + cm -> ? m
    {
      const aMax = Math.floor(target/1000)
      for (let a=1; a<=aMax; a++) {
        const cm = 100*(target - 1000*a)
        if (cm>=100) pushUnique(`${a} km ${cm} cm = ? m`)
      }
      // cm + mm -> ? m (évite 0)
      for (let mm=10; mm<=990; mm+=10) {
        const cm = target - mm/10
        if (cm>=1) { pushUnique(`${cm} cm ${mm} mm = ? m`); break }
      }
      // km décimal -> ? m
      if (target%1000===0) {
        const km = target/1000
        if (km>0) pushUnique(`${fmtFr(km)} km = ? m`)
      }
    }

    // --- Masses vers g (réponse en g) : question sans g seul
    // kg + g -> ? g
    {
      if (target>1) {
        const a = Math.floor(Math.max(1, (target-1)/1000))
        const b = target - 1000*a
        if (a>=1 && b>=1) pushUnique(`${a} kg ${b} g = ? g`)
      }
      // kg décimal -> ? g
      if (target%1000===0) {
        const kg = target/1000
        if (kg>0) pushUnique(`${fmtFr(kg)} kg = ? g`)
      }
    }

    // --- Volumes vers mL (réponse en mL) : question sans mL seul
    // L + mL -> ? mL
    {
      if (target>1) {
        const a = Math.floor(Math.max(1, (target-1)/1000))
        const b = target - 1000*a
        if (a>=1 && b>=1) pushUnique(`${a} L ${b} mL = ? mL`)
      }
      // L décimal -> ? mL
      if (target%1000===0) {
        const L = target/1000
        if (L>0) pushUnique(`${fmtFr(L)} L = ? mL`)
      }
    }

    // --- Distances vers m (réponse en m) : km + m (variantes)
    {
      if (target>1000) {
        const a = Math.floor((target-1)/1000)
        const b = target - 1000*a
        if (a>=1 && b>=1) pushUnique(`${a} km ${b} m = ? m`)
      }
    }
  }

  /************* MODE TEMPS (unités question ≠ unité réponse, pas de “× 60”, j/h/min/s, pas de 0) *************/
  if (mode === 'temps') {
    // cibles (=target) : valeur numérique attendue dans l’unité demandée

    // Réponse en secondes -> question sans "seconde" seule (au moins 2 unités)
    // j h min -> ? s
    {
      const S = target
      // On fabrique j/h/min >=1 et s absents dans l'énoncé
      // S = 86400*j + 3600*h + 60*m
      // Cherche j,h,m >=1
      for (let j=1; j<=Math.floor(S/86400); j++) {
        const remJ = S - 86400*j
        for (let h=1; h<=Math.floor(remJ/3600); h++) {
          const remH = remJ - 3600*h
          if (remH>=60 && remH%60===0) {
            const m = remH/60
            if (m>=1) pushUnique(`${j} j ${h} h ${m} min = ? s`)
          }
        }
      }
      // variante h + min (sans j) -> ? s
      for (let h=1; h<=Math.floor(S/3600); h++) {
        const remH = S - 3600*h
        if (remH>=60 && remH%60===0) {
          const m = remH/60
          if (m>=1) pushUnique(`${h} h ${m} min = ? s`)
        }
      }
      // min seul (sans h) -> ? s (éviter 0)
      if (S%60===0 && S>=120) {
        const m = S/60
        pushUnique(`${m} min = ? s`)
      }
    }

    // Réponse en minutes -> question sans "minute" seule
    // j h s -> ? min  (on inclut s multiple de 60 pour rester entier)
    {
      const M = target
      // j + h + s
      for (let j=1; j<=Math.floor(M/1440); j++) {
        const remJ = M - 1440*j
        for (let h=1; h<=Math.floor(remJ/60); h++) {
          const remH = M - 1440*j - 60*h
          // remH = s/60 -> s multiple de 60 et >= 60
          if (remH>=1) {
            const s = remH * 60
            pushUnique(`${j} j ${h} h ${s} s = ? min`)
          }
        }
      }
      // h + s -> ? min
      if (M>=2) {
        const h = Math.max(1, Math.floor(M/2)) // garde au moins 1 minute pour s
        const rem = M - h
        const s = rem * 60
        if (h>=1 && rem>=1) pushUnique(`${h} h ${s} s = ? min`)
      }
      // j + h -> ? min
      if (M>=1500) {
        const j = 1
        const h = M/60 - 24
        if (Number.isInteger(h) && h>=1) pushUnique(`${j} j ${h} h = ? min`)
      }
      // s seul -> ? min (si divisible 60 et >= 120 s)
      if (M>=2) pushUnique(`${M*60} s = ? min`)
    }

    // Réponse en heures -> question sans "heure" seule
    // j min s -> ? h (on choisit total secondes divisible par 3600)
    {
      const H = target
      const totalS = H * 3600
      // j + min (au moins 1 de chaque)
      for (let j=1; j<=Math.floor(totalS/86400); j++) {
        const remJ = totalS - 86400*j
        if (remJ>=60 && remJ%60===0) {
          const m = remJ/60
          if (m>=1) pushUnique(`${j} j ${m} min = ? h`)
        }
      }
      // min + s -> ? h
      // 60*min + s = totalS ; min>=1, s in [1..3599]
      if (totalS>3600) {
        const min = Math.max(1, Math.floor((totalS-1)/60) - 10)
        const s = totalS - 60*min
        if (min>=1 && between(s,1,3599)) pushUnique(`${min} min ${s} s = ? h`)
      }
      // j + s -> ? h (s multiple de 3600 pour rester entier)
      if (H>=25) {
        const j = 1
        const s = (H-24)*3600
        if (s>=3600) pushUnique(`${j} j ${s} s = ? h`)
      }
    }

    // Réponse en jours -> question sans "jour" seul
    // h min s -> ? j (total secondes divisible par 86400)
    {
      const J = target
      const totalS = J * 86400
      // h + min (au moins 1 de chaque)
      for (let h=1; h<=Math.floor(totalS/3600)-1; h++) {
        const remH = totalS - 3600*h
        if (remH>=60 && remH%60===0) {
          const m = remH/60
          if (m>=1) pushUnique(`${h} h ${m} min = ? j`)
        }
      }
      // min + s -> ? j (s multiple de 60)
      if (totalS>=60*2) {
        const min = Math.max(1, Math.floor(totalS/120))
        const s = totalS - 60*min
        if (s>=60) pushUnique(`${min} min ${s} s = ? j`)
      }
      // h + s -> ? j (s multiple de 3600)
      if (J>=1) {
        const h = 24
        const s = totalS - 3600*h
        if (s>=3600) pushUnique(`${h} h ${s} s = ? j`)
      }
    }
  }

  // Mélange de la liste
  for (let i=list.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [list[i],list[j]]=[list[j],list[i]] }
  return list
}

/*********************************
 * DOM & état
 *********************************/
const fileInput = qs('#fileInput')
const fileInfo = qs('#fileInfo')
const pixelPreview = qs('#pixelPreview')
const cols = qs('#cols'), colsVal = qs('#colsVal')
const numColors = qs('#numColors'), numColorsVal = qs('#numColorsVal')
const opsMode = qs('#opsMode')
const difficulty = qs('#difficulty')
const cellPx = qs('#cellPx'), cellPxVal = qs('#cellPxVal')
const mergeSameColor = qs('#mergeSameColor')
const contrast = qs('#contrast'), contrastVal = qs('#contrastVal')
const saturation = qs('#saturation'), saturationVal = qs('#saturationVal')
const showOps = qs('#showOps')
const exportPNG = qs('#exportPNG')
const statusEl = qs('#status')
const work = qs('#work')
const svgContainer = qs('#svgContainer')
const resultsInline = qs('#resultsInline')
const resultsList = qs('#resultsList')
const resetResults = qs('#resetResults')

const state = {
  imageUrl: null,
  imageInfo: null,
  cols: parseInt(cols?.value || '40', 10),
  numColors: parseInt(numColors?.value || '6', 10),
  opsMode: opsMode?.value || 'addsub',
  difficulty: difficulty?.value || 'facile',
  seed: 1234,
  cellPx: parseInt(cellPx?.value || '36', 10),
  mergeSameColor: !!mergeSameColor?.checked,
  contrast: parseInt(contrast?.value || '0', 10),
  saturation: parseInt(saturation?.value || '0', 10),
  showOps: !!showOps?.checked,
  gridWidth: 0,
  gridHeight: 0,
  labels: [],
  palette: [],
  customResults: [],
}

/*********************************
 * UI bindings
 *********************************/
function setStatus(text, isError=false){ if (!statusEl) return; statusEl.textContent = text; statusEl.style.color = isError? '#b91c1c' : '#b45309' }
function renderStatus(){ if (!fileInfo) return; const i=state.imageInfo; fileInfo.textContent = i ? `Sélection : ${i.name || '-'} (${i.type || '-'}${i.size ? ', '+Math.round(i.size/1024)+' Ko' : ''})` : '' }

fileInput?.addEventListener('change', (e) => {
  const f = e.currentTarget.files && e.currentTarget.files[0]; if (!f) return
  const ok = new Set(["image/png","image/jpeg","image/webp","image/gif","image/bmp"]).has(f.type)
  if (!ok) { setStatus(`Format non supporté (${f.type||'inconnu'}). Utilise PNG/JPEG/WEBP/GIF/BMP.`, true); return }
  const reader = new FileReader()
  reader.onload = () => { state.imageUrl = String(reader.result); state.imageInfo = { name:f.name, type:f.type, size:f.size }; renderStatus(); scheduleProcess() }
  reader.onerror = () => setStatus('Impossible de lire le fichier (FileReader).', true)
  reader.readAsDataURL(f)
})

;['input','change'].forEach(ev => {
  cols?.addEventListener(ev, () => { state.cols = parseInt(cols.value,10); colsVal.textContent = cols.value; scheduleProcess() })
  numColors?.addEventListener(ev, () => { state.numColors = parseInt(numColors.value,10); numColorsVal.textContent = numColors.value; scheduleProcess() })
  opsMode?.addEventListener(ev, () => { state.opsMode = opsMode.value; redrawSVG() })
  difficulty?.addEventListener(ev, () => { state.difficulty = difficulty.value; redrawSVG() })
  cellPx?.addEventListener(ev, () => { state.cellPx = parseInt(cellPx.value,10); cellPxVal.textContent = cellPx.value; redrawSVG() })
  mergeSameColor?.addEventListener(ev, () => { state.mergeSameColor = mergeSameColor.checked; redrawSVG() })
  contrast?.addEventListener(ev, () => { state.contrast = parseInt(contrast.value,10); contrastVal.textContent = contrast.value; scheduleProcess() })
  saturation?.addEventListener(ev, () => { state.saturation = parseInt(saturation.value,10); saturationVal.textContent = saturation.value; scheduleProcess() })
  showOps?.addEventListener(ev, () => { state.showOps = showOps.checked; redrawSVG() })
})

exportPNG?.addEventListener('click', openPNGInNewTab)
resetResults?.addEventListener('click', () => { state.customResults = state.palette.map((_,i)=> i+2); renderResultsEditor(); redrawSVG() })

/*********************************
 * Traitement + aperçu pixellisé
 *********************************/
let processTimer=null
function scheduleProcess(){ clearTimeout(processTimer); processTimer = setTimeout(processImage, 60) }

async function processImage(){
  if (!state.imageUrl) return
  setStatus('Traitement…')
  try {
    const img = await loadImage(state.imageUrl)
    const iw = img.naturalWidth || img.width || 0
    const ih = img.naturalHeight || img.height || 0
    if (iw===0 || ih===0) throw new Error("Dimensions d'image invalides.")

    const ratio = ih/iw || 1
    const gw = clamp(Math.min(state.cols, iw), 4, Math.max(4, iw))
    const gh = clamp(Math.round(gw*ratio), 4, Math.max(4, ih))
    state.gridWidth = gw; state.gridHeight = gh

    const ctx = work.getContext('2d', { willReadFrequently: true })
    work.width = gw; work.height = gh
    ctx.clearRect(0,0,gw,gh)
    ctx.drawImage(img, 0, 0, gw, gh)

    let imgData = ctx.getImageData(0,0,gw,gh)
    imgData = applyContrastSaturation(imgData, state.contrast, state.saturation)
    ctx.putImageData(imgData, 0, 0)

    const points = new Array(gw*gh)
    for (let y=0; y<gh; y++) for (let x=0; x<gw; x++) { const i=(y*gw+x)*4; points[y*gw+x] = [imgData.data[i], imgData.data[i+1], imgData.data[i+2]] }

    const { centers, labels } = kmeans(points, state.numColors, 24, state.seed)
    state.labels = labels
    state.palette = centers.map(c => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])])

    if (!state.customResults.length || state.customResults.length !== state.palette.length) {
      state.customResults = state.palette.map((_, i) => i + 2)
    }

    renderResultsEditor()
    renderPixelPreview(gw, gh, labels, state.palette)
    redrawSVG()
    setStatus('')
  } catch(e) {
    console.error(e); setStatus(e?.message || "Échec du traitement de l'image.", true)
  }
}

function renderPixelPreview(gw, gh, labels, palette) {
  if (!pixelPreview) return
  const parent = pixelPreview.parentElement
  const availW = Math.max(1, parent?.clientWidth || pixelPreview.clientWidth || 320)
  const maxH = 260
  let scale = Math.floor(Math.min(availW / gw, maxH / gh))
  if (!Number.isFinite(scale) || scale < 1) scale = 1
  pixelPreview.width = gw * scale
  pixelPreview.height = gh * scale
  pixelPreview.style.width = `${gw * scale}px`
  pixelPreview.style.height = `${gh * scale}px`
  const ctx = pixelPreview.getContext('2d')
  ctx.imageSmoothingEnabled = false
  for (let y=0; y<gh; y++) for (let x=0; x<gw; x++) {
    const k = labels[y*gw + x]
    const [r,g,b] = palette[k]
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(x*scale, y*scale, scale, scale)
  }
}

window.addEventListener('resize', () => {
  const gw = state.gridWidth || 0, gh = state.gridHeight || 0
  if (gw && gh && state.labels.length && state.palette.length) renderPixelPreview(gw, gh, state.labels, state.palette)
})

/*********************************
 * Résultats (éditeur sous la grille)
 *********************************/
function renderResultsEditor(){
  if (!resultsInline || !resultsList) return
  if (!state.palette.length) { resultsInline.style.display = 'none'; resultsList.innerHTML=''; return }
  resultsInline.style.display = ''
  resultsList.innerHTML = ''
  state.palette.forEach((c,i)=>{
    const row = document.createElement('label'); row.className='resultRow'
    const sw = document.createElement('span'); sw.className='swatch'; sw.style.background=`rgb(${c[0]},${c[1]},${c[2]})`
    const name = document.createElement('span'); name.className='muted small'; name.textContent = `Couleur ${i+1}`
    const lab = document.createElement('span'); lab.className='muted small'; lab.textContent = 'Résultat :'
    const input = document.createElement('input'); input.type='number'; input.min='0'; input.max='9999'; input.value = state.customResults[i] ?? (i+2)
    input.addEventListener('input', ()=>{ const n=Number(input.value); state.customResults[i] = Number.isFinite(n) ? clamp(Math.round(n),0,9999) : (state.customResults[i] ?? i+2); redrawSVG() })
    row.append(sw, name, lab, input); resultsList.append(row)
  })
}

/*********************************
 * SVG (grille) — responsive, net
 *********************************/
function redrawSVG(){
  if (!svgContainer) return
  const W = state.gridWidth, H = state.gridHeight
  const labels = state.labels, palette = state.palette
  if (!W || !H || !labels.length || !palette.length) { svgContainer.innerHTML = '<div class="muted">La grille s\'affichera ici.</div>'; return }

  const cell = clamp(state.cellPx, 16, 200)
  const Wpx = W * cell
  const Hpx = H * cell

  const rng = mulberry32(state.seed)
  const numberColorMap = palette.map((color,i)=> ({ value: Math.max(0, Math.floor(state.customResults[i] ?? (i+2))), color }))
  const exprBank = {}
  if (state.showOps) for (const e of numberColorMap) exprBank[e.value] = exprBankForResult(e.value, state.opsMode, rng, state.difficulty)

  const rects = state.mergeSameColor ? mergeRectangles(labels, W, H) : labels.map((k,i)=>({ x:i%W, y:Math.floor(i/W), w:1, h:1, k }))

  let s = `<?xml version="1.0" encoding="UTF-8"?>\n`
  s += `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${Wpx} ${Hpx}' width='100%' preserveAspectRatio='xMidYMid meet'>`
  s += `<rect x='0' y='0' width='${Wpx}' height='${Hpx}' fill='white'/>`

  for (const r of rects){
    const cx=r.x*cell, cy=r.y*cell, rw=r.w*cell, rh=r.h*cell
    s += `<rect x='${cx}' y='${cy}' width='${rw}' height='${rh}' fill='none' stroke='black' stroke-width='1' shape-rendering='crispEdges'/>`
    if (state.showOps){
      const val = numberColorMap[r.k]?.value ?? 0
      const exprs = exprBank[val] || [String(val)]
      const expr = exprs[(r.x + r.y + r.k) % exprs.length]
      const L = layoutExpression(expr, rw, rh)
      if (L.mode==='h'){
        s += `<text x='${cx + rw/2}' y='${cy + rh/2}' font-family='monospace' font-size='${L.font}' text-anchor='middle' dominant-baseline='middle'>${expr}</text>`
      } else if (L.mode==='v'){
        const lh = Math.round(L.font * 1.2)
        const totalH = lh * L.lines.length
        let y0 = cy + (rh - totalH) / 2 + L.font * 0.85
        for (let i=0; i<L.lines.length; i++) {
          const ly = y0 + i*lh
          s += `<text x='${cx + rw/2}' y='${ly}' font-family='monospace' font-size='${L.font}' text-anchor='middle' dominant-baseline='middle'>${L.lines[i]}</text>`
        }
      }
    }
  }

  s += `</svg>`
  svgContainer.innerHTML = s
}

/*********************************
 * Export PNG NET (1:1)
 *********************************/
function openPNGInNewTab(){
  const svg = svgContainer?.querySelector('svg'); if(!svg) return
  const vb = svg.getAttribute('viewBox')
  let W=0, H=0
  if (vb) { const p = vb.trim().split(/\s+/); if (p.length===4){ W=Math.round(parseFloat(p[2])); H=Math.round(parseFloat(p[3])); } }
  if (!W || !H) { W = Math.round(parseFloat(svg.getAttribute('width')) || 0); H = Math.round(parseFloat(svg.getAttribute('height')) || 0) }
  if (!W || !H) { alert('Impossible de déterminer la taille du SVG.'); return }

  const xml = new XMLSerializer().serializeToString(svg)
  const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)))
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = W; canvas.height = H
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,W,H)
    ctx.drawImage(img, 0, 0, W, H)
    const dataURL = canvas.toDataURL('image/png')
    const win = window.open(); if (win) {
      win.document.write(`<!doctype html><html><head><meta charset='utf-8'><title>Export PNG — ${W}×${H}px</title><style>html,body{margin:0;padding:16px;background:#111;color:#eee;font:14px system-ui}.info{margin:0 0 8px;color:#aaa}img{display:block;image-rendering:pixelated;image-rendering:crisp-edges}</style></head><body><p class='info'>${W} × ${H} px (échelle 1:1)</p><img src='${dataURL}' width='${W}' height='${H}' alt='Grille exportée'></body></html>`)
      win.document.close()
    }
  }
  img.src = src
}

/*********************************
 * Bootstrap
 *********************************/

renderStatus()
redrawSVG()
