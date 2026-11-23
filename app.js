(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    dropZone: $('dropZone'), empty: $('emptyState'), analyzing: $('analyzing'), step: $('analysisStep'),
    photo: $('photoCanvas'), overlay: $('overlayCanvas'), results: $('results'), actions: $('captureActions'),
    topbar: $('workspaceTopbar'), tooltip: $('grapeTooltip'), camera: $('cameraInput'), upload: $('uploadInput'),
    info: $('infoDialog')
  };
  const state = { detections: [], scale: 1, selected: -1, result: null, sourceName: 'grape-photo' };
  const palette = { high: '#80d36f', mixed: '#e3b55a', low: '#ec8477' };

  $('captureButton').addEventListener('click', () => ui.camera.click());
  $('uploadButton').addEventListener('click', () => ui.upload.click());
  $('newPhotoButton').addEventListener('click', () => ui.upload.click());
  ui.camera.addEventListener('change', handleFileInput);
  ui.upload.addEventListener('change', handleFileInput);
  $('demoButton').addEventListener('click', loadDemo);
  $('infoButton').addEventListener('click', () => ui.info.showModal());
  $('closeDialog').addEventListener('click', () => ui.info.close());
  $('dialogOkay').addEventListener('click', () => ui.info.close());
  ui.info.addEventListener('click', (event) => { if (event.target === ui.info) ui.info.close(); });

  ui.dropZone.addEventListener('dragover', (event) => { event.preventDefault(); ui.dropZone.classList.add('dragging'); });
  ui.dropZone.addEventListener('dragleave', () => ui.dropZone.classList.remove('dragging'));
  ui.dropZone.addEventListener('drop', (event) => {
    event.preventDefault(); ui.dropZone.classList.remove('dragging');
    if (event.dataTransfer.files[0]) processFile(event.dataTransfer.files[0]);
  });
  ui.overlay.addEventListener('click', selectGrape);
  $('detailsButton').addEventListener('click', toggleDetails);
  $('shareButton').addEventListener('click', shareResult);

  function handleFileInput(event) {
    if (event.target.files[0]) processFile(event.target.files[0]);
    event.target.value = '';
  }

  async function processFile(file) {
    if (!file.type.startsWith('image/')) { announce('Bitte wählen Sie eine Bilddatei.'); return; }
    state.sourceName = file.name.replace(/\.[^.]+$/, '') || 'grape-photo';
    try {
      const url = URL.createObjectURL(file);
      const image = await loadImage(url);
      URL.revokeObjectURL(url);
      await analyzeImage(image);
    } catch (error) {
      console.error(error);
      ui.analyzing.hidden = true;
      announce('Dieses Foto konnte nicht geöffnet werden. Bitte versuchen Sie ein anderes Bild.');
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function analyzeImage(image) {
    ui.empty.hidden = true;
    ui.actions.hidden = true;
    ui.analyzing.hidden = false;
    ui.results.hidden = true;
    state.selected = -1;
    ui.tooltip.hidden = true;
    ui.step.textContent = 'Foto wird gelesen…';

    const workWidth = Math.min(820, image.naturalWidth || image.width);
    const scale = workWidth / (image.naturalWidth || image.width);
    const workHeight = Math.round((image.naturalHeight || image.height) * scale);
    ui.photo.width = workWidth;
    ui.photo.height = workHeight;
    ui.overlay.width = workWidth;
    ui.overlay.height = workHeight;
    const context = ui.photo.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, workWidth, workHeight);
    state.scale = workWidth / Math.max(workWidth, workHeight);
    await wait(80);
    ui.step.textContent = 'Traubenfarbene Bereiche werden segmentiert…';
    await wait(40);

    let detections;
    try {
      const backend = await analyzeOnServer(ui.photo);
      detections = backend.berries.map((berry) => {
        const [blue, green, red] = berry.mean_bgr;
        const [hue, saturation, value] = rgbToHsv(red, green, blue);
        return { id: berry.id, x: berry.x, y: berry.y, radius: berry.radius_px, hue, saturation, value, confidence: berry.confidence };
      });
      ui.step.textContent = 'OpenCV-Analyse wird zusammengefasst…';
    } catch (error) {
      console.info('Backend nicht verfügbar; lokale Analyse wird verwendet.', error);
      detections = detectGrapes(context, workWidth, workHeight);
    }
    state.detections = detections.length ? detections : fallbackDetection(context, workWidth, workHeight);
    ui.step.textContent = 'Beeren und Farbe werden ausgewertet…';
    await wait(80);
    state.result = summarize(state.detections, workWidth, workHeight);
    drawOverlay();
    renderResults(state.result);

    ui.dropZone.classList.add('has-image');
    ui.topbar.hidden = false;
    ui.analyzing.hidden = true;
    ui.results.hidden = false;
    ui.actions.hidden = false;
    $('captureButton').innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h4l1.5-2h5L16 7h4v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg> Weitere Analyse';
    ui.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function analyzeOnServer(canvas) {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.9) })
    });
    if (!response.ok) throw new Error(`Backend ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.berries)) throw new Error('Ungültige Backend-Antwort');
    return result;
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0;
    if (delta) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, max ? delta / max : 0, max];
  }

  function grapeLikelihood(r, g, b) {
    const [h, s, v] = rgbToHsv(r, g, b);
    const purple = h > .64 && h < .96 && s > .10;
    const green = h > .11 && h < .40 && s > .18 && v > .24;
    const pink = (h < .09 || h > .96) && s > .12 && v > .2 && b > r * .45;
    if (!purple && !green && !pink) return 0;
    const tone = purple ? 1 : green ? .72 : .64;
    return tone * Math.min(1, s * 2.8) * (v > .11 && v < .98 ? 1 : .45);
  }

  function detectGrapes(context, width, height) {
    const image = context.getImageData(0, 0, width, height).data;
    const stride = Math.max(2, Math.round(Math.min(width, height) / 235));
    const cols = Math.ceil(width / stride), rows = Math.ceil(height / stride);
    const scores = new Float32Array(cols * rows);
    const colors = new Float32Array(cols * rows * 3);
    let occupied = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const px = Math.min(width - 1, x * stride), py = Math.min(height - 1, y * stride);
      const i = (py * width + px) * 4;
      const score = grapeLikelihood(image[i], image[i + 1], image[i + 2]);
      const idx = y * cols + x;
      scores[idx] = score;
      colors[idx * 3] = image[i]; colors[idx * 3 + 1] = image[i + 1]; colors[idx * 3 + 2] = image[i + 2];
      if (score > .24) occupied++;
    }
    if (occupied / scores.length < .018) return [];

    const mask = new Uint8Array(scores.length);
    for (let i = 0; i < scores.length; i++) mask[i] = scores[i] > .23 ? 1 : 0;
    const centers = [];
    const radii = [Math.max(2, Math.round(Math.min(cols, rows) / 24)), Math.max(3, Math.round(Math.min(cols, rows) / 14)), Math.max(5, Math.round(Math.min(cols, rows) / 9))];
    const uniqueRadii = [...new Set(radii)];
    for (const radius of uniqueRadii) {
      const r2 = radius * radius;
      for (let cy = radius; cy < rows - radius; cy += Math.max(1, Math.round(radius / 2))) {
        for (let cx = radius; cx < cols - radius; cx += Math.max(1, Math.round(radius / 2))) {
          let hits = 0, total = 0, sumH = 0, sumS = 0, sumV = 0, edgeHits = 0, edgeTotal = 0;
          for (let oy = -radius; oy <= radius; oy += 2) for (let ox = -radius; ox <= radius; ox += 2) {
            const d2 = ox * ox + oy * oy;
            if (d2 > r2) continue;
            total++;
            const idx = (cy + oy) * cols + cx + ox;
            if (mask[idx]) hits++;
            const [h, s, v] = rgbToHsv(colors[idx * 3], colors[idx * 3 + 1], colors[idx * 3 + 2]);
            sumH += h; sumS += s; sumV += v;
            if (d2 > (radius * .72) ** 2) { edgeTotal++; if (mask[idx]) edgeHits++; }
          }
          const density = hits / total;
          const centerScore = density - Math.abs((hits / total) - ((edgeHits / edgeTotal) || 0)) * .45;
          if (density > .57 && centerScore > .47) centers.push({ x: cx, y: cy, radius, strength: centerScore, h: sumH / total, s: sumS / total, v: sumV / total });
        }
      }
    }

    centers.sort((a, b) => b.strength - a.strength);
    const selected = [];
    for (const candidate of centers) {
      if (selected.some((other) => Math.hypot(candidate.x - other.x, candidate.y - other.y) < Math.max(candidate.radius, other.radius) * 1.18)) continue;
      selected.push(candidate);
      if (selected.length >= 120) break;
    }
    const medianRadius = median(selected.map((d) => d.radius));
    return selected.filter((d) => d.radius > medianRadius * .42).map((d, index) => ({
      id: index + 1, x: d.x * stride, y: d.y * stride, radius: d.radius * stride * .9,
      hue: d.h, saturation: d.s, value: d.v, confidence: Math.round(d.strength * 100)
    })).sort((a, b) => a.y - b.y || a.x - b.x);
  }

  function fallbackDetection(context, width, height) {
    const data = context.getImageData(0, 0, width, height);
    const regions = [];
    const cols = 14, rows = 10;
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
      let score = 0, samples = 0;
      for (let sy = .2; sy < 1; sy += .3) for (let sx = .2; sx < 1; sx += .3) {
        const x = Math.floor((gx + sx) * width / cols), y = Math.floor((gy + sy) * height / rows), i = (y * width + x) * 4;
        score += grapeLikelihood(data.data[i], data.data[i + 1], data.data[i + 2]); samples++;
      }
      if (score / samples > .4) regions.push({ x: (gx + .5) * width / cols, y: (gy + .5) * height / rows, radius: Math.min(width / cols, height / rows) * .7, hue: .78, saturation: .5, value: .45, confidence: 48 });
    }
    return regions;
  }

  function median(numbers) {
    if (!numbers.length) return 1;
    const list = [...numbers].sort((a, b) => a - b), half = Math.floor(list.length / 2);
    return list.length % 2 ? list[half] : (list[half - 1] + list[half]) / 2;
  }

  function summarize(detections, width, height) {
    const count = detections.length;
    const radii = detections.map((d) => d.radius);
    const avgRadius = radii.reduce((a, b) => a + b, 0) / Math.max(1, count);
    const hueDeviation = count ? detections.reduce((sum, d) => sum + Math.abs(circularHue(d.hue) - .78), 0) / count : 1;
    const uniformity = Math.round(Math.max(42, Math.min(97, 96 - hueDeviation * 140 - (deviation(radii) / Math.max(1, avgRadius)) * 23)));
    const averageConfidence = count ? detections.reduce((sum, d) => sum + d.confidence, 0) / count : 35;
    const score = Math.round(Math.min(96, uniformity * .52 + averageConfidence * .48));
    const quality = score >= 78 ? 'Ausgezeichnet' : score >= 62 ? 'Gut' : score >= 47 ? 'Gemischt' : 'Prüfen';
    const mmPerPixel = .24;
    return { count, uniformity, score, quality, diameter: Math.round(avgRadius * 2 * mmPerPixel * 10) / 10, coverage: Math.min(100, Math.round(detections.reduce((s, d) => s + Math.PI * d.radius ** 2, 0) / (width * height) * 100)) };
  }

  function circularHue(hue) { return Math.min(hue, 1 - hue); }
  function deviation(values) {
    if (!values.length) return 0;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
  }

  function drawOverlay() {
    const ctx = ui.overlay.getContext('2d');
    ctx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
    state.detections.forEach((grape, index) => {
      const color = grape.confidence > 72 ? palette.high : grape.confidence > 56 ? palette.mixed : palette.low;
      ctx.beginPath(); ctx.arc(grape.x, grape.y, grape.radius, 0, Math.PI * 2);
      ctx.fillStyle = index === state.selected ? `${color}20` : `${color}0e`; ctx.fill();
      ctx.lineWidth = index === state.selected ? 3 : 1.5; ctx.strokeStyle = color; ctx.stroke();
      if (index === state.selected) {
        ctx.beginPath(); ctx.arc(grape.x, grape.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      }
    });
  }

  function renderResults(result) {
    $('grapeCount').textContent = result.count;
    $('diameterValue').textContent = result.count ? result.diameter : '—';
    $('uniformityValue').textContent = result.uniformity;
    $('qualityValue').textContent = result.quality;
    $('uniformityBar').style.width = `${result.uniformity}%`;
    [...$('qualityDots').children].forEach((dot, i) => dot.classList.toggle('active', i < Math.ceil(result.score / 20)));
    const noFruit = !result.count;
    $('insightTitle').textContent = noFruit ? 'Keine eindeutige Traube gefunden' : result.quality === 'Ausgezeichnet' ? 'Gleichmäßiges Erscheinungsbild' : result.quality === 'Gut' ? 'Ausgewogene Traube' : 'Einige Abweichungen erkannt';
    $('insightText').textContent = noFruit ? 'Versuchen Sie einen engeren Ausschnitt bei diffusem Tageslicht und mit einem kontrastreichen Hintergrund.' : `Erkannt wurden ${result.count} Beeren auf ${result.coverage}% des Bildausschnitts. ${result.quality === 'Ausgezeichnet' || result.quality === 'Gut' ? 'Farb- und Formgleichmäßigkeit sind klare visuelle Hinweise.' : 'Prüfen Sie die wärmeren Konturen auf ungleichmäßige Farbe oder unsichere Grenzen.'} Tippen Sie auf eine markierte Beere, um die Schätzung zu prüfen.`;
    const sorted = [...state.detections].sort((a, b) => b.radius - a.radius);
    const list = $('detailsList'); list.innerHTML = '';
    [
      ['Erkennungssicherheit', `${median(state.detections.map((d) => d.confidence))}% Median`, 'Visuelle Übereinstimmung'],
      ['Relative Größenstreuung', `${Math.round(deviation(state.detections.map((d) => d.radius)) / Math.max(1, result.diameter) * 100)}%`, 'Niedrig ist gleichmäßiger'],
      ['Größte erkannte Beere', sorted[0] ? `${Math.round(sorted[0].radius * 2 * .24)} mm geschätzt` : '—', 'Beere Nr. '+(sorted[0]?.id || '—')],
      ['Farbsättigung', sorted.length ? `${Math.round(sorted.reduce((s, d) => s + d.saturation, 0) / sorted.length * 100)}%` : '—', 'Durchschnitt']
    ].forEach(([name, value, note]) => {
      const row = document.createElement('div'); row.className = 'detail-row';
      [name, note, value].forEach((text, index) => { const item = document.createElement(index === 2 ? 'b' : 'span'); item.textContent = text; row.appendChild(item); }); list.appendChild(row);
    });
  }

  function selectGrape(event) {
    if (!state.detections.length) return;
    const rect = ui.overlay.getBoundingClientRect();
    const visibleScale = Math.min(rect.width / ui.overlay.width, rect.height / ui.overlay.height);
    const offsetX = (rect.width - ui.overlay.width * visibleScale) / 2;
    const offsetY = (rect.height - ui.overlay.height * visibleScale) / 2;
    const x = (event.clientX - rect.left - offsetX) / visibleScale;
    const y = (event.clientY - rect.top - offsetY) / visibleScale;
    let best = -1, distance = Infinity;
    state.detections.forEach((grape, index) => {
      const d = Math.hypot(x - grape.x, y - grape.y);
      if (d < grape.radius * 1.5 && d < distance) { best = index; distance = d; }
    });
    if (best < 0) { state.selected = -1; ui.tooltip.hidden = true; drawOverlay(); return; }
    state.selected = best; drawOverlay();
    const grape = state.detections[best];
    ui.tooltip.innerHTML = `Beere ${grape.id} · ${Math.round(grape.confidence)}% Treffer · ${Math.round(grape.radius * .48)} mm geschätzt`;
    ui.tooltip.style.left = `${offsetX + grape.x * visibleScale}px`;
    ui.tooltip.style.top = `${offsetY + grape.y * visibleScale}px`;
    ui.tooltip.hidden = false;
  }

  function toggleDetails() {
    const list = $('detailsList'), button = $('detailsButton');
    list.hidden = !list.hidden;
    button.setAttribute('aria-expanded', String(!list.hidden));
    button.innerHTML = `${list.hidden ? 'Details ansehen' : 'Details ausblenden'} <span>${list.hidden ? '⌄' : '⌃'}</span>`;
  }

  async function shareResult() {
    if (!state.result) return;
    const text = `TraubenScan Rheinhessen: ${state.result.count} Beeren erkannt, ${state.result.uniformity}% Farbgleichmäßigkeit, ${state.result.quality.toLowerCase()} visuelle Qualität.`;
    try {
      if (navigator.share) await navigator.share({ title: 'Mein TraubenScan-Ergebnis', text });
      else { await navigator.clipboard.writeText(text); announce('Ergebnis in die Zwischenablage kopiert.'); }
    } catch (error) { if (error.name !== 'AbortError') announce('Teilen ist derzeit nicht verfügbar.'); }
  }

  function announce(message) {
    ui.tooltip.textContent = message; ui.tooltip.style.left = '50%'; ui.tooltip.style.top = '50%'; ui.tooltip.hidden = false;
    clearTimeout(announce.timer); announce.timer = setTimeout(() => { ui.tooltip.hidden = true; }, 2600);
  }

  async function loadDemo() {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 680;
    const ctx = canvas.getContext('2d');
    const background = ctx.createRadialGradient(470, 220, 50, 450, 340, 570);
    background.addColorStop(0, '#b8bf9e'); background.addColorStop(1, '#27382b'); ctx.fillStyle = background; ctx.fillRect(0, 0, 900, 680);
    for (let i = 0; i < 180; i++) {
      ctx.fillStyle = `rgba(${80 + Math.random()*45},${110 + Math.random()*45},${65 + Math.random()*40},.12)`;
      ctx.beginPath(); ctx.ellipse(Math.random()*900, Math.random()*680, 20+Math.random()*80, 8+Math.random()*24, Math.random()*3, 0, 7); ctx.fill();
    }
    const berries = [];
    const rows = [4,6,7,7,6,5,3];
    rows.forEach((count, row) => {
      for (let col = 0; col < count; col++) {
        const x = 450 + (col - (count - 1) / 2) * 89 + row * 3 + (Math.random() - .5)*12;
        const y = 115 + row * 71 + (Math.random() - .5)*12;
        const r = 46 + Math.random()*7 + row*.4;
        berries.push({ x, y, r });
      }
    });
    berries.sort((a,b)=>a.y-b.y).forEach(({x,y,r}) => {
      const gradient = ctx.createRadialGradient(x-r*.35, y-r*.4, 4, x, y, r);
      const variant = Math.random();
      gradient.addColorStop(0, variant>.78 ? '#a98b9e' : '#9a829b');
      gradient.addColorStop(.3, variant>.65 ? '#806276' : '#72536e');
      gradient.addColorStop(.78, '#4d3652'); gradient.addColorStop(1, '#302534');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.ellipse(x-r*.32,y-r*.38,r*.18,r*.1,-.7,0,7); ctx.fill();
    });
    ctx.strokeStyle='#657d51';ctx.lineWidth=12;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(450,120);ctx.quadraticCurveTo(425,68,471,28);ctx.stroke();
    ctx.fillStyle='#778e60';ctx.beginPath();ctx.ellipse(505,48,55,23,-.45,0,7);ctx.fill();
    const image = await loadImage(canvas.toDataURL('image/png'));
    state.sourceName = 'demo-bunch';
    await analyzeImage(image);
  }
})();
