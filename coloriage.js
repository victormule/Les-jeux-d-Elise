'use strict'
/*
  Coloriage Magique — app.js
  ✓ Police min 11 + wrap forcé (mots puis caractères)
  ✓ Conversions : sliders % ? m / ? L / ? g (équilibrage pondéré)
  ✓ Temps : équilibre ? s / ? min / ? h / ? j
  ✓ Conversions/Temps : toujours "= ? unité" (espaces sécables)
  ✓ Aucune composante = 0 dans Conversions/Temps
  ✓ Arithmétique : jamais "= ?"
  ✓ Reste identique (aperçu pixelisé, export PNG, fusion cellules…)
*/

/*********************************
 * Helpers
 *********************************/
const qs = (s, el=document) => el.querySelector(s)
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const MAX_FONT_SIZE = 14
const MIN_FONT_SIZE = 11    // *** nouvelle contrainte ***
const GLUE = ' '            // espaces sécables autour de "= ? unité"

const mulberry32 = (a) => () => {
  let t = (a += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/*********************************
 * K-means simple (RGB)
 *********************************/
function kmeans(points, k, maxIter = 24, seedVal = 1) {
  if (!points.length) return { centers: [], labels: [] }
  k = clamp(k, 1, points.length)
  const rand = mulberry32(seedVal)
  const centers = []
  const used = new Set()
  while (centers.length < k) {
    const idx = Math.floor(rand() * points.length)
    if (!used.has(idx)) { used.add(idx); centers.push(points[idx].slice()) }
  }
  const labels = new Array(points.length).fill(0)
  const dist2 = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2
  for (let it=0; it<maxIter; it++) {
    let changed = false
    for (let i=0; i<points.length; i++) {
      let best=0, bestd=Infinity
      for (let c=0; c<centers.length; c++) {
        const d2 = dist2(points[i], centers[c])
        if (d2 < bestd) { bestd=d2; best=c }
      }
      if (labels[i] !== best) { labels[i]=best; changed=true }
    }
    const sums = Array.from({length:k}, () => [0,0,0,0])
    for (let i=0; i<points.length; i++) {
      const c=labels[i], p=points[i]
      sums[c][0]+=p[0]; sums[c][1]+=p[1]; sums[c][2]+=p[2]; sums[c][3]++
    }
    for (let c=0; c<k; c++)
      if (sums[c][3]>0) centers[c] = [
        sums[c][0]/sums[c][3], sums[c][1]/sums[c][3], sums[c][2]/sums[c][3]
      ]
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
      for (let xx=0; xx<w; xx++)
        if (visited[(y+h)*W + (x+xx)] || at(x+xx, y+h)!==k) { ok=false; break }
      if (ok) h++
    }
    for (let yy=0; yy<h; yy++)
      for (let xx=0; xx<w; xx++)
        visited[(y+yy)*W + (x+xx)] = 1
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
      try {
        if (typeof img.decode === 'function') await img.decode()
        if ((img.naturalWidth||img.width)===0)
          return reject(new Error('Image sans dimensions.'))
        resolve(img)
      } catch(e) {
        if ((img.naturalWidth||img.width)>0) resolve(img)
        else reject(new Error("Échec du décodage de l'image."))
      }
    }
    img.onerror = () => reject(new Error("Impossible de charger l'image (fichier illisible)."))
    img.src = url
  })
}

/*********************************
 * Layout du texte (min 11, wrap forcé)
 *********************************/
function layoutExpression(expr, rw, rh) {
  const pad = Math.floor(0.08 * Math.min(rw, rh))
  const availW = Math.max(1, rw - 2*pad)
  const availH = Math.max(1, rh - 2*pad)
  const estWidth = (text, fs) => Math.ceil((text.length || 1) * fs * 0.6)
  const lineHeight = (fs) => Math.round(fs * 1.2)

  // Détecter un suffixe "= ? unité" (espaces sécables)
  const m = expr.match(/(.*?)(?:=\s*\?\s*(\S+))$/)
  const hasSuffix = !!m
  const head = hasSuffix ? m[1].trim() : expr
  const suffixToken = hasSuffix ? `=${GLUE}?${GLUE}${m[2]}` : null

  // 1) Essai 1 ligne (jamais < 11)
  for (let fs=Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.floor(Math.min(availH*0.42, availW/0.6)))); fs>=MIN_FONT_SIZE; fs--) {
    const one = hasSuffix ? `${head} ${suffixToken}` : head
    if (estWidth(one, fs) <= availW) return { mode:'h', lines:[one], font:fs, pad }
  }

  // 2) Multi-lignes par mots (jamais < 11)
  const tokens = head.split(/[ \t]+/).filter(Boolean)
  for (let fs=Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.floor(availH*0.42))); fs>=MIN_FONT_SIZE; fs--) {
    const lines=[]; let current=''
    const fits = (txt) => estWidth(txt, fs) <= availW
    for (let i=0; i<tokens.length; i++) {
      const t=tokens[i]; const cand = current ? current + ' ' + t : t
      if (fits(cand)) current=cand
      else { if (current) lines.push(current); if (!fits(t)) { lines.length=0; current=''; break } current=t }
    }
    if (current) lines.push(current)
    if (!lines.length) continue

    let linesWithSuffix = lines
    const totalHBase = lines.length * lineHeight(fs)
    if (hasSuffix) {
      const totalH = (lines.length + 1) * lineHeight(fs)
      if (totalH <= availH) {
        linesWithSuffix = [...lines, suffixToken]
        return { mode:'v', lines: linesWithSuffix, font:fs, pad }
      }
    } else if (totalHBase <= availH) {
      return { mode:'v', lines, font:fs, pad }
    }
  }

  // 3) Dernier recours : wrap caractère par caractère à 11 (pour éviter tout débordement)
  const fs = MIN_FONT_SIZE
  const lh = lineHeight(fs)
  const maxLines = Math.max(1, Math.floor(availH / lh))
  const text = head
  const hardLines = []
  let cur = ''
  for (let i=0; i<text.length; i++) {
    const cand = cur + text[i]
    if (estWidth(cand, fs) <= availW) cur = cand
    else { hardLines.push(cur); cur = text[i]; if (hardLines.length >= maxLines-1) break }
  }
  if (cur && hardLines.length < maxLines) hardLines.push(cur)
  const finalLines = [...hardLines]
  if (hasSuffix && finalLines.length < maxLines) finalLines.push(suffixToken)
  return { mode:'v', lines: finalLines, font:fs, pad }
}

/*********************************
 * Répartition pondérée
 *********************************/
function weightedInterleave(buckets, weights) {
  // weights: tableau positif, normalisé en interne
  const B = buckets.map(b => b.slice()) // copies
  const w = weights.slice()
  const totalW = w.reduce((a,b)=>a+b,0) || 1
  for (let i=0;i<w.length;i++) w[i] = w[i]/totalW

  const used = new Array(B.length).fill(0)
  const out = []

  // Tant qu’il reste des éléments
  while (B.some(b => b.length)) {
    // Choisir le bucket i qui minimise used[i]/w[i] (progression relative)
    let best = -1, bestScore = Infinity
    for (let i=0;i<B.length;i++) {
      if (!B[i].length) continue
      const score = used[i] / (w[i] || 1e-9)
      if (score < bestScore) { bestScore = score; best = i }
    }
    if (best === -1) break
    out.push(B[best].shift())
    used[best]++
  }
  return out
}

/*********************************
 * Banque d’énoncés
 *********************************/
function exprBankForResult(targetRaw, mode, rng, difficulty='facile'){
  if (!mode) return []

  // Helpers
  const list=[]
  const fmtFr = (n, maxDec=3) => {
    if (!Number.isFinite(n)) return String(n)
    const s = Number.isInteger(n) ? String(n) : Number(n.toFixed(maxDec)).toString()
    const [a,b] = s.split('.')
    return b ? `${a},${b.replace(/0+$/,'')}` : a
  }
  const banZeroComp = (s) => /\b0\s*(km|m|cm|mm|kg|g|L|mL|h|min|s|j)\b/.test(s)
  const addExpr = (s) => {
    if (!s) return
    if (banZeroComp(s)) return
    if (mode === 'unites' || mode === 'temps') s = s.replace(/=\s*\?\s*([^\s]+)/, `= ? $1`)
    else if (/=\s*\?/.test(s)) return // pas de "= ?" en arithmétique
    if (!list.includes(s)) list.push(s)
  }
  const shuffleInPlace = (arr) => { for (let i=arr.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]] } }

  /************* ARITHMÉTIQUE (inchangé, sans "= ?") *************/
  const target = targetRaw
  const add2=()=>{ for(let a=0;a<=target;a++){ const b=target-a; if(b>=0) addExpr(`${a} + ${b}`) } }
  const sub2=()=>{ for(let a=target;a<=target+40;a++){ const b=a-target; if(b>=0) addExpr(`${a} - ${b}`) } }
  const mult2=()=>{ for(let a=1;a<=20;a++){ if(target%a===0){ const b=target/a; if(b>=1&&b<=20) addExpr(`${a} × ${b}`) } } }
  const div2 =()=>{ for(let b=1;b<=20;b++){ const a=target*b; if(a<=800) addExpr(`${a} ÷ ${b}`) } }

  if (["add","addsub","mix"].includes(mode)) add2()
  if (["addsub","mix"].includes(mode)) sub2()
  if (["mult","multdiv","mix"].includes(mode)) mult2()
  if (["multdiv","mix"].includes(mode)) div2()

  const maxN = difficulty==='facile'?0:(difficulty==='moyen'?12:20)
  if (maxN>0){
    if (["add","addsub","mix"].includes(mode)){
      for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++){ const c=target-a-b; if(c>=0&&c<=maxN) addExpr(`${a} + ${b} + ${c}`) }
      if (difficulty==='difficile'){
        for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++){ const c=a+b-target; if(c>=0&&c<=maxN) addExpr(`${a} + ${b} - ${c}`) }
      }
    }
    if (["mult","multdiv","mix"].includes(mode)){
      const lim=Math.max(12,Math.min(20,maxN))
      for(let a=1;a<=lim;a++) for(let b=1;b<=lim;b++){ const prod=a*b; const cAdd=target-prod; if(cAdd>=0&&cAdd<=maxN) addExpr(`${a} × ${b} + ${cAdd}`); const cSub=prod-target; if(cSub>=0&&cSub<=maxN) addExpr(`${a} × ${b} - ${cSub}`) }
    }
    if (difficulty==='difficile' && ["mult","multdiv","mix"].includes(mode)){
      for(let a=1;a<=12;a++) for(let b=1;b<=12;b++) for(let c=1;c<=12;c++){ if(a*b % c === 0 && (a*b)/c === target) addExpr(`(${a} × ${b}) ÷ ${c}`) }
    }
    if (difficulty==='difficile'){
      if (["add","addsub","mix"].includes(mode)){
        for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++) for(let c=0;c<=maxN;c++){ const d=target-a-b-c; if(d>=0&&d<=maxN) addExpr(`${a} + ${b} + ${c} + ${d}`) }
        for(let a=0;a<=maxN;a++) for(let b=0;b<=maxN;b++) for(let c=0;c<=maxN;c++){ const d=a+b+c-target; if(d>=0&&d<=maxN) addExpr(`${a} + ${b} + ${c} - ${d}`) }
      }
      if (["mult","multdiv","mix"].includes(mode)){
        const lim=12
        for(let a=1;a<=lim;a++) for(let b=1;b<=lim;b++) for(let c=0;c<=maxN;c++){
          const prod=a*b
          const dAdd=target-prod-c; if(dAdd>=0&&dAdd<=maxN) addExpr(`${a} × ${b} + ${c} + ${dAdd}`)
          const dSub=prod+c-target; if(dSub>=0&&dSub<=maxN) addExpr(`${a} × ${b} + ${c} - ${dSub}`)
          const dSub2=prod-c-target; if(dSub2>=0&&dSub2<=maxN) addExpr(`${a} × ${b} - ${c} - ${dSub2}`)
        }
        for(let a=1;a<=lim;a++) for(let b=1;b<=lim;b++) for(let c=1;c<=lim;c++){
          if(a*b % c === 0){
            const base=(a*b)/c
            const d=target-base
            if(d>=0&&d<=maxN) addExpr(`(${a} × ${b}) ÷ ${c} + ${d}`)
          }
        }
      }
    }
  }

  /************* CONVERSIONS — équilibre pondéré ? m / ? L / ? g *************/
  if (mode === 'unites') {
    const Tm = Number(targetRaw)         // résultat en mètres (peut être décimal)
    const TL = Number(targetRaw)         // résultat en litres (peut être décimal)
    const Tg = Math.round(Number(targetRaw)) // résultat en grammes (on force entier propre pour g)

    const Qm = []  // -> ? m
    const QL = []  // -> ? L
    const Qg = []  // -> ? g

    // === -> ? m (question sans "m")
    for (let mm=10; mm<=990; mm+=10){
      const cm = Math.round(Tm*100 - mm/10)
      if (cm>=1) Qm.push(`${cm} cm ${mm} mm = ? m`)
      if (Qm.length>=18) break
    }
    if (Tm>0) Qm.push(`${Math.round(Tm*1000)} mm = ? m`)
    if (Tm>0) Qm.push(`${(Tm/1000).toString().replace('.',',')} km = ? m`)

    // === -> ? L (question sans "L")
    if (TL>0) {
      QL.push(`${Math.round(TL*1000)} mL = ? L`)
      const a = Math.max(1, Math.floor(TL*1000/2))
      const b = Math.round(TL*1000 - a)
      if (a>=1 && b>=1) QL.push(`${a} mL ${b} mL = ? L`)
      if (!Number.isInteger(TL)) QL.push(`${TL.toString().replace('.',',')} L = ? mL`) // variante inverse (réponse mL) – on reste sur ? L ici, donc on évite cette ligne; laissée en réserve
    }

    // === -> ? g (question sans "g")
    if (Tg>0) {
      Qg.push(`${(Tg/1000).toString().replace('.',',')} kg = ? g`)
      if (Tg>=1000) {
        const kgInt = Math.floor(Tg/1000)
        const kgDec = (Tg/1000) - kgInt
        if (kgDec>0) Qg.push(`${(kgInt+kgDec).toString().replace('.',',')} kg = ? g`)
      }
    }

    // Pondération depuis l'état (sliders)
    const mix = (typeof state !== 'undefined' && state.unitesMix)
      ? state.unitesMix
      : { m: 33, L: 34, g: 33 }
    const weights = [Math.max(0, mix.m), Math.max(0, mix.L), Math.max(0, mix.g)]
    const balanced = weightedInterleave([Qm, QL, Qg], weights)
    return balanced.filter(Boolean)
  }

  /************* TEMPS — équilibre ? s / ? min / ? h / ? j *************/
  if (mode === 'temps') {
    const qs=[] , qmin=[] , qh=[] , qj=[]

    // ? s
    {
      const S = Math.round(Number(targetRaw))
      for (let h=1; h<=Math.floor(S/3600); h++){
        const rem = S - 3600*h
        if (rem>=60 && rem%60===0){ const m = rem/60; if (m>=1) qs.push(`${h} h ${m} min = ? s`) }
        if (qs.length>=10) break
      }
      for (let j=1; j<=Math.floor(S/86400); j++){
        const rJ = S - 86400*j
        for (let h=1; h<=Math.floor(rJ/3600); h++){
          const rem = rJ - 3600*h
          if (rem>=60 && rem%60===0){ const m = rem/60; if (m>=1) { qs.push(`${j} j ${h} h ${m} min = ? s`); break } }
        }
        if (qs.length>=16) break
      }
      if (S%60===0 && S>=120) qs.push(`${S/60} min = ? s`)
    }

    // ? min
    {
      const M = Math.round(Number(targetRaw))
      for (let h=1; h<=Math.floor(M/2); h++){
        const rem = M - h
        if (rem>=1) qmin.push(`${h} h ${rem*60} s = ? min`)
        if (qmin.length>=12) break
      }
      for (let j=1; j<=Math.floor(M/1440); j++){
        const rJ = M - 1440*j
        for (let h=1; h<=Math.floor(rJ/60); h++){
          const rem = rJ - 60*h
          if (rem>=1) { qmin.push(`${j} j ${h} h ${rem*60} s = ? min`); break }
        }
        if (qmin.length>=16) break
      }
      qmin.push(`${M*60} s = ? min`)
    }

    // ? h
    {
      const H = Math.round(Number(targetRaw))
      const totS = H*3600
      if (totS>3600){
        const min = Math.max(1, Math.floor((totS-1)/60) - 10)
        const s = totS - 60*min
        if (min>=1 && s>=1 && s<3600) qh.push(`${min} min ${s} s = ? h`)
      }
      for (let j=1; j<=Math.floor(totS/86400); j++){
        const rem = totS - 86400*j
        if (rem>=60 && rem%60===0){ const m = rem/60; if (m>=1) qh.push(`${j} j ${m} min = ? h`) }
        if (qh.length>=16) break
      }
    }

    // ? j
    {
      const J = Math.round(Number(targetRaw))
      const totS = J*86400
      for (let h=1; h<=Math.floor(totS/3600)-1; h++){
        const rem = totS - 3600*h
        if (rem>=60 && rem%60===0){ const m = rem/60; if (m>=1) { qj.push(`${h} h ${m} min = ? j`); if (qj.length>=12) break } }
      }
      if (totS>=120){
        const min = Math.max(1, Math.floor(totS/120))
        const s = totS - 60*min
        if (s>=60) qj.push(`${min} min ${s} s = ? j`)
      }
    }

    // Répartition équilibrée simple (1:1:1:1)
    const all = weightedInterleave([qs, qmin, qh, qj], [1,1,1,1])
    return all.filter(Boolean)
  }

  // Arithmétique : mélange pour variété
  shuffleInPlace(list)
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

// *** nouveau : conteneur des sliders unites (créé dynamiquement) ***
let unitesPanel = null

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
  // mix % conversions (affiché seulement en mode "unites")
  unitesMix: { m: 33, L: 34, g: 33 },
}

/*********************************
 * UI: panneau sliders pour "unites"
 *********************************/
function ensureUnitesPanel() {
  if (unitesPanel) return unitesPanel
  const after = opsMode?.closest('label') || opsMode || document.body
  const wrap = document.createElement('div')
  wrap.id = 'unitesMixPanel'
  wrap.style.marginTop = '8px'
  wrap.style.padding = '8px'
  wrap.style.border = '1px dashed #ddd'
  wrap.style.borderRadius = '8px'
  wrap.style.display = 'none' // visible seulement en mode "unites"
  wrap.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">Répartition Conversions : <span id="mixTotal">(= 100%)</span></div>
    <div class="mixRow" style="display:flex;align-items:center;gap:8px;margin:6px 0">
      <span style="width:80px">? m</span>
      <input id="mixM" type="range" min="0" max="100" step="1" value="${state.unitesMix.m}" style="flex:1">
      <output id="mixMVal" style="width:38px;text-align:right">${state.unitesMix.m}%</output>
    </div>
    <div class="mixRow" style="display:flex;align-items:center;gap:8px;margin:6px 0">
      <span style="width:80px">? L</span>
      <input id="mixL" type="range" min="0" max="100" step="1" value="${state.unitesMix.L}" style="flex:1">
      <output id="mixLVal" style="width:38px;text-align:right">${state.unitesMix.L}%</output>
    </div>
    <div class="mixRow" style="display:flex;align-items:center;gap:8px;margin:6px 0">
      <span style="width:80px">? g</span>
      <input id="mixG" type="range" min="0" max="100" step="1" value="${state.unitesMix.g}" style="flex:1">
      <output id="mixGVal" style="width:38px;text-align:right">${state.unitesMix.g}%</output>
    </div>
    <div class="muted small">Astuce : je garde la somme = 100% en ajustant automatiquement les autres curseurs.</div>
  `
  after.parentElement?.insertBefore(wrap, after.nextSibling)
  unitesPanel = wrap

  const mixM = qs('#mixM', wrap), mixMVal = qs('#mixMVal', wrap)
  const mixL = qs('#mixL', wrap), mixLVal = qs('#mixLVal', wrap)
  const mixG = qs('#mixG', wrap), mixGVal = qs('#mixGVal', wrap)
  const recalc = (edited) => {
    // Conserver somme = 100% en répartissant le delta sur les deux autres proportionnellement
    let m = Number(mixM.value), L = Number(mixL.value), g = Number(mixG.value)
    let sum = m + L + g
    if (sum === 100) {
      state.unitesMix = { m, L, g }
    } else {
      const others = edited === 'm' ? ['L','g'] : edited === 'L' ? ['m','g'] : ['m','L']
      const restOld = others[0]==='m'? m : others[0]==='L'? L : g
      const restOld2 = others[1]==='m'? m : others[1]==='L'? L : g
      const editedVal = edited==='m'? m : edited==='L'? L : g
      const remain = 100 - editedVal
      const oldSumOthers = restOld + restOld2 || 1
      const v1 = Math.round(remain * (restOld / oldSumOthers))
      const v2 = remain - v1
      if (others[0] === 'm') m = v1
      else if (others[0] === 'L') L = v1
      else g = v1
      if (others[1] === 'm') m = v2
      else if (others[1] === 'L') L = v2
      else g = v2
      state.unitesMix = { m, L, g }
      mixM.value = String(m); mixL.value = String(L); mixG.value = String(g)
    }
    mixMVal.textContent = `${state.unitesMix.m}%`
    mixLVal.textContent = `${state.unitesMix.L}%`
    mixGVal.textContent = `${state.unitesMix.g}%`
    redrawSVG()
  }
  mixM.addEventListener('input', () => recalc('m'))
  mixL.addEventListener('input', () => recalc('L'))
  mixG.addEventListener('input', () => recalc('g'))

  return wrap
}

function toggleUnitesPanel() {
  const panel = ensureUnitesPanel()
  panel.style.display = (state.opsMode === 'unites') ? '' : 'none'
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
  opsMode?.addEventListener(ev, () => { state.opsMode = opsMode.value; toggleUnitesPanel(); redrawSVG() })
  difficulty?.addEventListener(ev, () => { state.difficulty = difficulty.value; redrawSVG() })
  cellPx?.addEventListener(ev, () => { state.cellPx = parseInt(cellPx.value,10); cellPxVal.textContent = cellPx.value; redrawSVG() })
  mergeSameColor?.addEventListener(ev, () => { state.mergeSameColor = mergeSameColor.checked; redrawSVG() })
  contrast?.addEventListener(ev, () => { state.contrast = parseInt(contrast.value,10); contrastVal.textContent = contrast.value; scheduleProcess() })
  saturation?.addEventListener(ev, () => { state.saturation = parseInt(saturation.value,10); saturationVal.textContent = saturation.value; scheduleProcess() })
  showOps?.addEventListener(ev, () => { state.showOps = showOps.checked; redrawSVG() })
})

exportPNG?.addEventListener('click', openPNGInNewTab)
resetResults?.addEventListener('click', () => {
  state.customResults = state.palette.map((_,i)=> i+2)
  renderResultsEditor(); redrawSVG()
})

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
    const input = document.createElement('input'); input.type='number'; input.min='1'; input.max='9999'; input.step='0.1'
    const wanted = state.customResults[i] ?? (i+2)
    input.value = Math.max(1, Number(wanted))
    input.addEventListener('input', ()=>{
      let n = Number(input.value)
      if (!Number.isFinite(n)) n = 1
      n = clamp(n, 1, 9999)
      state.customResults[i] = n
      input.value = String(n)
      redrawSVG()
    })
    row.append(sw, name, lab, input); resultsList.append(row)
  })
}

/*********************************
 * SVG (grille)
 *********************************/
function redrawSVG(){
  if (!svgContainer) return
  const W = state.gridWidth, H = state.gridHeight
  const labels = state.labels, palette = state.palette
  if (!W || !H || !labels.length || !palette.length) { svgContainer.innerHTML = '<div class="muted">La grille s\'affichera ici.</div>'; toggleUnitesPanel(); return }

  const cell = clamp(state.cellPx, 16, 200)
  const Wpx = W * cell
  const Hpx = H * cell

  const rng = mulberry32(state.seed)
  const numberColorMap = palette.map((color,i)=> ({
    value: Math.max(1, Number(state.customResults[i] ?? (i+2))), // pas de 0
    color
  }))

  const exprBank = {}
  if (state.showOps) {
    for (const e of numberColorMap) {
      const v = e.value
      const arr = exprBankForResult(v, state.opsMode, rng, state.difficulty) || []
      if ((!arr.length) && (state.opsMode==='unites' || state.opsMode==='temps')) {
        // Fallback minimal lisible
        if (state.opsMode==='unites') exprBank[v] = [`${v*100} cm = ? m`]
        else exprBank[v] = [`${v} min = ? s`]
      } else exprBank[v] = arr
    }
  }

  const rects = state.mergeSameColor ? mergeRectangles(labels, W, H) : labels.map((k,i)=>({ x:i%W, y:Math.floor(i/W), w:1, h:1, k }))

  let s = `<?xml version="1.0" encoding="UTF-8"?>\n`
  s += `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${Wpx} ${Hpx}' width='100%' preserveAspectRatio='xMidYMid meet'>`
  s += `<rect x='0' y='0' width='${Wpx}' height='${Hpx}' fill='white'/>`

  for (const r of rects){
    const cx=r.x*cell, cy=r.y*cell, rw=r.w*cell, rh=r.h*cell
    s += `<rect x='${cx}' y='${cy}' width='${rw}' height='${rh}' fill='none' stroke='black' stroke-width='1' shape-rendering='crispEdges'/>`
    if (state.showOps){
      const val = numberColorMap[r.k]?.value ?? 1
      let exprs = exprBank[val] || []
      if (!exprs.length) {
        if (state.opsMode==='unites' || state.opsMode==='temps') exprs = [`= ?`]
        else exprs = [`${Math.max(0, Math.round(val)-1)} + 1`]
      }
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
  toggleUnitesPanel()
}

/*********************************
 * Export PNG NET (1:1)
 *********************************/
function openPNGInNewTab() {
  const svg = svgContainer?.querySelector('svg');
  if (!svg) return;

  // Taille du SVG
  const vb = svg.getAttribute('viewBox');
  let W = 0, H = 0;
  if (vb) {
    const p = vb.trim().split(/\s+/);
    if (p.length === 4) { W = Math.round(parseFloat(p[2])); H = Math.round(parseFloat(p[3])); }
  }
  if (!W || !H) {
    W = Math.round(parseFloat(svg.getAttribute('width')) || 0);
    H = Math.round(parseFloat(svg.getAttribute('height')) || 0);
  }
  if (!W || !H) { alert("Impossible de déterminer la taille du SVG."); return; }

  // SVG -> Image
  const xml = new XMLSerializer().serializeToString(svg);
  const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
  const img = new Image();

  img.onload = () => {
    // --- Paramètres de rendu de la légende ---
    const pad = 16;    // marges
    const sw  = 18;    // carré
    const gap = 10;    // espacement horizontal
    const titleFs = 18;
    const rowFs   = 14;

    const palette = Array.isArray(state.palette) ? state.palette : [];
    const results = Array.isArray(state.customResults) ? state.customResults : [];
    const rowsCount = Math.min(palette.length, results.length);

    // Calcul largeur totale de la ligne légende
    const ctxTmp = document.createElement('canvas').getContext('2d');
    ctxTmp.font = `${rowFs}px system-ui, sans-serif`;

    let legendWidth = 0;
    for (let i = 0; i < rowsCount; i++) {
      const valRaw = Math.max(1, Number(results[i] ?? (i + 2)));
      const val = Number.isFinite(valRaw) ? String(valRaw) : '';
      legendWidth += sw + gap + ctxTmp.measureText('=').width + gap + ctxTmp.measureText(val).width + 2*gap;
    }

    const legendHeight = rowsCount > 0 ? pad + titleFs + 10 + sw + pad : 0;

    // Canvas final
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(W, legendWidth + pad*2);
    canvas.height = H + legendHeight;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Fond blanc
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grille centrée en haut
    ctx.drawImage(img, Math.floor((canvas.width - W) / 2), 0, W, H);

    // Légende en ligne
    if (rowsCount > 0) {
      const legendY0 = H + pad;
      ctx.fillStyle = '#000';
      ctx.font = `${titleFs}px system-ui, sans-serif`;
      ctx.fillText('Résultats par couleur', pad, legendY0 + titleFs);

      let x = pad;
      const ySw = legendY0 + titleFs + 10;

      ctx.font = `${rowFs}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';

      for (let i = 0; i < rowsCount; i++) {
        const [r, g, b] = palette[i];
        const valRaw = Math.max(1, Number(results[i] ?? (i + 2)));
        const val = Number.isFinite(valRaw) ? String(valRaw) : '';

        const cy = ySw + sw / 2;

        // carré couleur
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, cy - sw / 2, sw, sw);
        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.strokeRect(x + 0.5, cy - sw / 2 + 0.5, sw - 1, sw - 1);
        x += sw + gap;

        // "="
        ctx.fillStyle = '#000';
        ctx.fillText('=', x, cy);
        x += ctx.measureText('=').width + gap;

        // valeur
        ctx.font = `bold ${rowFs}px system-ui, sans-serif`;
        ctx.fillText(val, x, cy);
        ctx.font = `${rowFs}px system-ui, sans-serif`;
        x += ctx.measureText(val).width + 2*gap;
      }
    }

    const dataURL = canvas.toDataURL('image/png');

    // Ouvre l’image finale (grille + légende en ligne)
    const win = window.open();
    if (win) {
      win.document.write(`<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Export PNG — ${canvas.width}×${canvas.height}px</title>
  <link rel="stylesheet" href="style.css">
</head>
<body class="export-root">
  <p class="export-info">${canvas.width} × ${canvas.height} px (échelle 1:1)</p>
  <img class="export-image" src="${dataURL}" width="${canvas.width}" height="${canvas.height}" alt="Grille exportée">
</body></html>`);
      win.document.close();
    }
  };

  img.src = src;
}


/*********************************
 * Bootstrap
 *********************************/
renderStatus()
toggleUnitesPanel()
redrawSVG()
