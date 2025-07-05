document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const allDOMElements = {
        imageLoader: document.getElementById('imageLoader'),
        loadButton: document.getElementById('loadButton'),
        saveButton: document.getElementById('saveButton'),
        undoButton: document.getElementById('undoButton'),
        redoButton: document.getElementById('redoButton'),
        historyList: document.getElementById('historyList'),
        selectSubjectButton: document.getElementById('selectSubjectButton'),
        radialMaskButton: document.getElementById('radialMaskButton'),
        maskList: document.getElementById('maskList'),
        showMaskOverlayCheckbox: document.getElementById('showMaskOverlay'),
        maskEditPanel: document.getElementById('mask-edit-panel'),
        deleteMaskButton: document.getElementById('deleteMaskButton'),
        savePresetButton: document.getElementById('savePresetButton'),
        loadPresetButton: document.getElementById('loadPresetButton'),
        presetLoader: document.getElementById('presetLoader'),
        loaderOverlay: document.getElementById('loader-overlay'),
        loaderText: document.getElementById('loader-text'),
        cropButton: document.getElementById('cropButton'),
        rotateLeftButton: document.getElementById('rotateLeftButton'),
        rotateRightButton: document.getElementById('rotateRightButton'),
        flipHorizontalButton: document.getElementById('flipHorizontalButton'),
        flipVerticalButton: document.getElementById('flipVerticalButton'),
        cropControls: document.getElementById('crop-controls'),
        applyCropButton: document.getElementById('applyCropButton'),
        cancelCropButton: document.getElementById('cancelCropButton'),
        ioButtons: document.querySelector('.io-buttons')
    };

    // --- State Management ---
    let originalImage = null;
    let originalImageData = null;
    let historyStack = [];
    let historyIndex = -1;
    let currentTool = null; // 'radial', 'crop', 'curve'
    let isDragging = false;
    let dragHandle = null;
    let radialMaskParams = {};
    let cropBox = {};
    let bodyPixModel = null;
    let toneCurve;

    const getEmptyEdits = () => ({
        exposure: 0, contrast: 0, highlights: 0, shadows: 0,
        temperature: 0, saturation: 0,
        shadowsHue: 0, shadowsSaturation: 0, midtonesHue: 0, midtonesSaturation: 0,
        highlightsHue: 0, highlightsSaturation: 0,
        texture: 0, clarity: 0, dehaze: 0,
        toneCurvePoints: [{x: 0, y: 255}, {x: 255, y: 0}]
    });
    
    // --- Initialization ---
    loadBodyPixModel();
    setupEventListeners();
    updateUI();

    // --- Tone Curve Class ---
    class ToneCurve {
        constructor(containerId, onChange) {
            this.container = document.getElementById(containerId);
            this.onChange = onChange;
            this.points = [{x: 0, y: 255}, {x: 255, y: 0}];
            this.lut = null;
            this.draggingPoint = null;
            this.init();
        }
        init() {
            this.canvas = document.createElement('canvas'); this.canvas.id = 'toneCurveCanvas';
            this.canvas.width = 256; this.canvas.height = 256; this.ctx = this.canvas.getContext('2d');
            const resetButton = document.createElement('button'); resetButton.id = 'resetCurveButton'; resetButton.innerText = 'Reset';
            resetButton.onclick = () => { this.setPoints([{x: 0, y: 255}, {x: 255, y: 0}]); this.onChange(); };
            this.container.innerHTML = ''; this.container.appendChild(this.canvas); this.container.appendChild(resetButton);
            this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
            this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
            this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
            this.canvas.addEventListener('mouseleave', this.onMouseUp.bind(this));
            this.draw(); this.generateLUT();
        }
        setPoints(points) { this.points = JSON.parse(JSON.stringify(points)).sort((a,b)=>a.x-b.x); this.draw(); this.generateLUT(); }
        draw() {
            this.ctx.fillStyle = '#2c2c2c'; this.ctx.fillRect(0, 0, 256, 256);
            this.ctx.strokeStyle = '#444'; this.ctx.lineWidth = 0.5;
            this.ctx.beginPath();
            [64, 128, 192].forEach(p => { this.ctx.moveTo(p, 0); this.ctx.lineTo(p, 256); this.ctx.moveTo(0, p); this.ctx.lineTo(256, p); });
            this.ctx.stroke();
            this.ctx.strokeStyle = '#e0e0e0'; this.ctx.lineWidth = 2;
            this.ctx.beginPath(); this.ctx.moveTo(this.points[0].x, this.points[0].y);
            for(let i = 1; i < this.points.length; i++) { this.ctx.lineTo(this.points[i].x, this.points[i].y); }
            this.ctx.stroke();
            this.ctx.fillStyle = '#00aeff';
            this.points.forEach(p => { this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI); this.ctx.fill(); });
        }
        generateLUT() {
            this.lut = new Uint8ClampedArray(256);
            for (let i = 0; i < 256; i++) {
                let p1_idx = 0;
                while (p1_idx < this.points.length - 2 && this.points[p1_idx+1].x < i) { p1_idx++; }
                const p1 = this.points[p1_idx]; const p2 = this.points[p1_idx + 1];
                const t = (p1.x === p2.x) ? 0 : (i - p1.x) / (p2.x - p1.x);
                const y = 255 - (p1.y + t * (p2.y - p1.y)); this.lut[i] = Math.max(0, Math.min(255, y));
            }
        }
        onMouseDown(e) {
            const x = e.offsetX; const y = e.offsetY; let foundPoint = null;
            for (const point of this.points) { if (Math.abs(point.x - x) < 8 && Math.abs(point.y - y) < 8) { foundPoint = point; break; } }
            if (foundPoint && e.ctrlKey && this.points.length > 2 && (foundPoint.x !== 0 && foundPoint.x !== 255)) {
                this.points = this.points.filter(p => p !== foundPoint); this.draggingPoint = null; this.draw(); this.generateLUT(); this.onChange();
            } else if (foundPoint) { this.draggingPoint = foundPoint; }
            else { const newPoint = { x, y }; this.points.push(newPoint); this.points.sort((a,b)=>a.x-b.x); this.draggingPoint = newPoint; }
            this.draw();
        }
        onMouseMove(e) {
            if (!this.draggingPoint) return;
            if (this.draggingPoint.x !== 0 && this.draggingPoint.x !== 255) { this.draggingPoint.x = Math.max(1, Math.min(254, e.offsetX)); }
            this.draggingPoint.y = Math.max(0, Math.min(255, e.offsetY));
            this.points.sort((a, b) => a.x - b.x); this.draw();
        }
        onMouseUp() { if (this.draggingPoint) { this.draggingPoint = null; this.generateLUT(); this.onChange(); } }
    }

    async function loadBodyPixModel() { try { showLoader('Loading AI Model...'); bodyPixModel = await bodyPix.load(); hideLoader(); } catch (e) { console.error(e); allDOMElements.loaderText.innerText = 'Failed to load AI Model.'; } }

    function setupEventListeners() {
        allDOMElements.loadButton.addEventListener('click', () => allDOMElements.imageLoader.click());
        allDOMElements.imageLoader.addEventListener('change', handleImageLoad);
        allDOMElements.saveButton.addEventListener('click', saveImage);
        allDOMElements.undoButton.addEventListener('click', undo);
        allDOMElements.redoButton.addEventListener('click', redo);
        allDOMElements.selectSubjectButton.addEventListener('click', createSubjectMask);
        allDOMElements.radialMaskButton.addEventListener('click', startRadialMaskTool);
        allDOMElements.showMaskOverlayCheckbox.addEventListener('change', render);
        allDOMElements.deleteMaskButton.addEventListener('click', deleteActiveMask);
        allDOMElements.savePresetButton.addEventListener('click', savePreset);
        allDOMElements.loadPresetButton.addEventListener('click', () => allDOMElements.presetLoader.click());
        allDOMElements.presetLoader.addEventListener('change', loadPreset);
        allDOMElements.cropButton.addEventListener('click', startCropTool);
        allDOMElements.applyCropButton.addEventListener('click', applyCrop);
        allDOMElements.cancelCropButton.addEventListener('click', cancelCrop);
        allDOMElements.rotateLeftButton.addEventListener('click', () => applyRotation(-90));
        allDOMElements.rotateRightButton.addEventListener('click', () => applyRotation(90));
        allDOMElements.flipHorizontalButton.addEventListener('click', () => applyFlip('horizontal'));
        allDOMElements.flipVerticalButton.addEventListener('click', () => applyFlip('vertical'));

        document.querySelectorAll('.slider').forEach(slider => {
            slider.addEventListener('input', handleSliderChange);
            slider.addEventListener('change', (e) => pushHistory('Adjust ' + e.target.id));
        });
        canvas.addEventListener('mousedown', onCanvasMouseDown);
        canvas.addEventListener('mousemove', onCanvasMouseMove);
        canvas.addEventListener('mouseup', onCanvasMouseUp);
        canvas.addEventListener('mouseout', onCanvasMouseUp);

        toneCurve = new ToneCurve('toneCurveContainer', () => {
            if (!originalImage) return;
            const state = historyStack[historyIndex];
            state.globalEdits.toneCurvePoints = toneCurve.points;
            pushHistory('Adjust Tone Curve');
        });
    }

    // --- Image Handling & Transforms ---
    function handleImageLoad(e) { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (event) => { originalImage = new Image(); originalImage.onload = () => commitTransform(originalImage, 'Load Image'); originalImage.src = event.target.result; }; reader.readAsDataURL(file); }
    function commitTransform(image, actionName) {
        originalImage = image; canvas.width = image.width; canvas.height = image.height;
        ctx.drawImage(originalImage, 0, 0); originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        historyStack = []; historyIndex = -1; currentTool = null;
        pushHistory(actionName); updateUI();
    }
    function startCropTool() { if (!originalImage) return; currentTool = 'crop'; cropBox = { x: 0, y: 0, w: canvas.width, h: canvas.height }; updateUI(); render(); }
    function applyCrop() {
        if (!originalImage) return; const tempCanvas = document.createElement('canvas'); tempCanvas.width = cropBox.w; tempCanvas.height = cropBox.h; const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(canvas, cropBox.x, cropBox.y, cropBox.w, cropBox.h, 0, 0, cropBox.w, cropBox.h);
        const newImage = new Image(); newImage.onload = () => commitTransform(newImage, 'Apply Crop'); newImage.src = tempCanvas.toDataURL();
    }
    function cancelCrop() { currentTool = null; render(); updateUI(); }
    function applyRotation(degrees) {
        if (!originalImage) return; const rad = degrees * Math.PI / 180; const w = canvas.width, h = canvas.height; const newW = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)); const newH = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
        const tempCanvas = document.createElement('canvas'); tempCanvas.width = newW; tempCanvas.height = newH; const tempCtx = tempCanvas.getContext('2d');
        tempCtx.translate(newW / 2, newH / 2); tempCtx.rotate(rad); tempCtx.drawImage(canvas, -w / 2, -h / 2);
        const newImage = new Image(); newImage.onload = () => commitTransform(newImage, `Rotate ${degrees}°`); newImage.src = tempCanvas.toDataURL();
    }
    function applyFlip(direction) {
        if (!originalImage) return; const w = canvas.width, h = canvas.height; const tempCanvas = document.createElement('canvas'); tempCanvas.width = w; tempCanvas.height = h; const tempCtx = tempCanvas.getContext('2d');
        if (direction === 'horizontal') { tempCtx.translate(w, 0); tempCtx.scale(-1, 1); } else { tempCtx.translate(0, h); tempCtx.scale(1, -1); }
        tempCtx.drawImage(canvas, 0, 0);
        const newImage = new Image(); newImage.onload = () => commitTransform(newImage, `Flip ${direction}`); newImage.src = tempCanvas.toDataURL();
    }

    // --- History & State Management ---
    function pushHistory(actionName) {
        if (!originalImage) return;
        const currentState = (historyIndex > -1) ? historyStack[historyIndex] : { globalEdits: getEmptyEdits(), masks: [], activeMaskId: null, };
        const newState = JSON.parse(JSON.stringify(currentState));
        
        document.querySelectorAll('.slider').forEach(s => {
            const editKey = s.id.replace('mask-', '');
            if (s.closest('#mask-edit-panel')) {
                if (newState.activeMaskId) { const activeMask = newState.masks.find(m => m.id === newState.activeMaskId); if(activeMask) activeMask.edits[editKey] = parseFloat(s.value); }
            } else { newState.globalEdits[editKey] = parseFloat(s.value); }
        });
        if(toneCurve) newState.globalEdits.toneCurvePoints = toneCurve.points;
        newState.actionName = actionName;

        historyStack = historyStack.slice(0, historyIndex + 1); historyStack.push(newState); historyIndex++;
        render(); updateUI();
    }
    function loadState(index) {
        if (index < 0 || index >= historyStack.length) return;
        historyIndex = index;
        const state = historyStack[historyIndex];
        
        Object.entries(state.globalEdits).forEach(([key, value]) => {
            const slider = document.getElementById(key);
            if(slider && slider.type === 'range') slider.value = value;
        });
        if (toneCurve && state.globalEdits.toneCurvePoints) toneCurve.setPoints(state.globalEdits.toneCurvePoints);

        const activeMask = state.activeMaskId ? state.masks.find(m => m.id === state.activeMaskId) : null;
        document.querySelectorAll('#mask-edit-panel .slider').forEach(s => {
            const editKey = s.id.replace('mask-', '');
            s.value = activeMask ? (activeMask.edits[editKey] || 0) : 0;
        });

        render(); updateUI();
    }
    function undo() { if (historyIndex > 0) loadState(historyIndex - 1); }
    function redo() { if (historyIndex < historyStack.length - 1) loadState(historyIndex + 1); }

    // --- Masking ---
    async function createSubjectMask() { if (!originalImage || !bodyPixModel) return; showLoader('Detecting Subject...'); const seg = await bodyPixModel.segmentPerson(canvas, {flipHorizontal: false, internalResolution: 'medium', segmentationThreshold: 0.7}); const maskData = new Uint8ClampedArray(seg.data.map(p => p * 255)); const newMask = { id: 'mask_' + Date.now(), name: 'Subject 1', type: 'ai', edits: getEmptyEdits(), maskData: Array.from(maskData) }; const state = historyStack[historyIndex]; state.masks.push(newMask); state.activeMaskId = newMask.id; pushHistory('Select Subject'); hideLoader(); }
    function startRadialMaskTool() { if (!originalImage) return; currentTool = 'radial'; canvas.classList.add('drawing'); }
    function deleteActiveMask() { const state = historyStack[historyIndex]; if (!state.activeMaskId) return; state.masks = state.masks.filter(m => m.id !== state.activeMaskId); state.activeMaskId = null; pushHistory('Delete Mask'); }

    // --- Event Handlers for Canvas Tools ---
    function onCanvasMouseDown(e) { if (!originalImage) return; isDragging = true; const [x, y] = getCanvasCoords(e); if (currentTool === 'crop') { dragHandle = getCropHandleAt(x, y); if (!dragHandle) dragHandle = 'move'; canvas.style.cursor = getCursorForCropHandle(dragHandle); } else if (currentTool === 'radial') { radialMaskParams = { startX: x, startY: y, endX: x, endY: y }; } }
    function onCanvasMouseMove(e) { if (!isDragging || !originalImage) return; const [x, y] = getCanvasCoords(e); if (currentTool === 'crop' && dragHandle) { updateCropBox(x, y); render(); } else if (currentTool === 'radial') { radialMaskParams.endX = x; radialMaskParams.endY = y; render(); } }
    function onCanvasMouseUp() { if (!isDragging) return; isDragging = false; canvas.style.cursor = 'default'; if (currentTool === 'radial') { const cx = radialMaskParams.startX; const cy = radialMaskParams.startY; const rx = Math.abs(radialMaskParams.endX - cx); const ry = Math.abs(radialMaskParams.endY - cy); if(rx < 5 || ry < 5) { currentTool = null; render(); return; } const newMask = { id: 'mask_' + Date.now(), name: 'Radial Gradient', type: 'radial', params: { cx, cy, rx, ry }, edits: getEmptyEdits(), maskData: null }; const state = historyStack[historyIndex]; state.masks.push(newMask); state.activeMaskId = newMask.id; radialMaskParams = {}; currentTool = null; pushHistory('Add Radial Mask'); } }
    function handleSliderChange() { if (!originalImage) return; requestAnimationFrame(render); }

    // --- Rendering Pipeline ---
    async function render() {
        if (!originalImageData) return;
        const state = historyStack[historyIndex]; if (!state) return;
        
        ctx.putImageData(originalImageData, 0, 0); // Start with the base image for this transform state

        const workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        applyEditsToData(workingImageData.data, state.globalEdits, null, state.globalEdits.toneCurvePoints);

        for (const mask of state.masks) {
            let maskPixelData = generateMaskPixelData(mask); if (!maskPixelData) continue;
            applyEditsToData(workingImageData.data, mask.edits, maskPixelData, null); // Masks don't have their own curves for now
        }
        ctx.putImageData(workingImageData, 0, 0);

        if (state.activeMaskId && allDOMElements.showMaskOverlayCheckbox.checked) {
            const activeMask = state.masks.find(m => m.id === state.activeMaskId); if (activeMask) { let maskPixelData = generateMaskPixelData(activeMask); const overlayData = new ImageData(canvas.width, canvas.height); for (let i = 0; i < overlayData.data.length; i += 4) { overlayData.data[i] = 255; overlayData.data[i + 3] = maskPixelData[i / 4] * 0.5; } ctx.putImageData(overlayData, 0, 0); }
        }
        if (currentTool === 'crop') drawCropUI();
        if (currentTool === 'radial' && radialMaskParams.startX) drawRadialPreview();
    }

    function applyEditsToData(data, edits, maskData, curvePoints) {
        let curveLUT = null; if(curvePoints) { const tempCurve = new ToneCurve('toneCurveContainer', ()=>{}); tempCurve.setPoints(curvePoints); curveLUT = tempCurve.lut; }
        const { exposure, contrast, highlights, shadows, temperature, saturation, texture, clarity, dehaze, shadowsHue, shadowsSaturation, midtonesHue, midtonesSaturation, highlightsHue, highlightsSaturation } = edits;
        const exposureFactor = Math.pow(2, exposure / 50); const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
        const highlightsFactor = highlights / 100; const shadowsFactor = shadows / 100; const saturationFactor = 1 + (saturation / 100);
        let blurredData = null; if (clarity !== 0) blurredData = applyBoxBlur(data, canvas.width, canvas.height, 5);
        
        for (let i = 0; i < data.length; i += 4) {
            const maskValue = maskData ? maskData[i / 4] / 255 : 1; if (maskValue === 0) continue;
            const originalR = data[i], originalG = data[i+1], originalB = data[i+2];
            let r = originalR, g = originalG, b = originalB;

            if (curveLUT) { r = curveLUT[r]; g = curveLUT[g]; b = curveLUT[b]; }
            r *= exposureFactor; g *= exposureFactor; b *= exposureFactor;
            r = contrastFactor * (r - 128) + 128; g = contrastFactor * (g - 128) + 128; b = contrastFactor * (b - 128) + 128;
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            if(highlightsFactor !== 0) { const hf = (lum/255)**2; r += hf*highlightsFactor*(255-r); g += hf*highlightsFactor*(255-g); b += hf*highlightsFactor*(255-b); }
            if(shadowsFactor !== 0) { const sf = (1-(lum/255))**2; r += sf*shadowsFactor*r; g += sf*shadowsFactor*g; b += sf*shadowsFactor*b; }
            if(dehaze !== 0) { const minC = Math.min(r,g,b); const hazeF = (minC/255); const dA = dehaze/100*(1-hazeF)*20; r+=dA; g+=dA; b+=dA; }
            if(clarity !== 0 && blurredData) { const bLum = 0.2126*blurredData[i]+0.7152*blurredData[i+1]+0.0722*blurredData[i+2]; const lC = lum-bLum; const cA = lC*(clarity/250); r+=cA;g+=cA;b+=cA;}
            
            const lumForGrading = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let hShift=0, sShift=0;
            if(lumForGrading < 85) { const t=lumForGrading/85; hShift=t*midtonesHue+(1-t)*shadowsHue; sShift=t*midtonesSaturation+(1-t)*shadowsSaturation;}
            else if (lumForGrading > 170) { const t=(lumForGrading-170)/85; hShift=(1-t)*midtonesHue+t*highlightsHue; sShift=(1-t)*midtonesSaturation+t*highlightsSaturation;}
            else {hShift=midtonesHue; sShift=midtonesSaturation;}
            if(sShift > 0) { const hsl=rgbToHsl(r,g,b); hsl[0]=(hsl[0]*360+hShift)%360/360; hsl[1]+=sShift/100; const rgb=hslToRgb(hsl[0],hsl[1],hsl[2]); r=rgb[0];g=rgb[1];b=rgb[2];}

            r += temperature; g += temperature * 0.5; b -= temperature;
            const avg = (r + g + b) / 3; r = avg + saturationFactor * (r - avg); g = avg + saturationFactor * (g - avg); b = avg + saturationFactor * (b - avg);
            
            data[i]   = originalR + (r - originalR) * maskValue; data[i+1] = originalG + (g - originalG) * maskValue; data[i+2] = originalB + (b - originalB) * maskValue;
            data[i] = Math.max(0, Math.min(255, data[i])); data[i+1] = Math.max(0, Math.min(255, data[i+1])); data[i+2] = Math.max(0, Math.min(255, data[i+2]));
        }
    }
    
    // --- UI Update & Helpers ---
    function updateUI() {
        allDOMElements.undoButton.disabled = historyIndex <= 0;
        allDOMElements.redoButton.disabled = historyIndex >= historyStack.length - 1;
        const state = historyIndex > -1 ? historyStack[historyIndex] : null;
        allDOMElements.maskList.innerHTML = '';
        if (state) {
            state.masks.forEach(mask => { const li = document.createElement('li'); li.textContent = mask.name; li.className = (mask.id === state.activeMaskId) ? 'active' : ''; li.addEventListener('click', () => { state.activeMaskId = mask.id; loadState(historyIndex); }); allDOMElements.maskList.appendChild(li); });
            allDOMElements.maskEditPanel.classList.toggle('hidden', !state.activeMaskId);
            if(state.activeMaskId) document.getElementById('mask-edit-title').innerText = `Edit: ${state.masks.find(m=>m.id===state.activeMaskId).name}`;
        }
        const inCropMode = currentTool === 'crop'; allDOMElements.cropControls.classList.toggle('hidden', !inCropMode); allDOMElements.ioButtons.classList.toggle('hidden', inCropMode); canvas.classList.toggle('cropping', inCropMode);
        document.querySelectorAll('.tool-button, .slider, #mask-tools button').forEach(el => el.disabled = inCropMode);
        allDOMElements.historyList.innerHTML = '';
        historyStack.forEach((s, i) => { const li = document.createElement('li'); li.textContent = s.actionName; li.className = (i === historyIndex) ? 'active' : ''; li.addEventListener('click', () => loadState(i)); allDOMElements.historyList.appendChild(li); });
        allDOMElements.historyList.scrollTop = allDOMElements.historyList.scrollHeight;
    }
    function generateMaskPixelData(mask) { if (mask.type === 'ai') return new Uint8ClampedArray(mask.maskData); if (mask.type === 'radial') { const { cx, cy, rx, ry } = mask.params; const data = new Uint8ClampedArray(canvas.width * canvas.height); for (let y = 0; y < canvas.height; y++) { for (let x = 0; x < canvas.width; x++) { const index = y * canvas.width + x; const val = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; data[index] = val < 1 ? (1 - Math.sqrt(val)) * 255 : 0; } } return data; } return null; }
    function getCanvasCoords(e) { const rect = canvas.getBoundingClientRect(); return [(e.clientX - rect.left) / rect.width * canvas.width, (e.clientY - rect.top) / rect.height * canvas.height]; }
    function getCropHandleAt(x, y) { const handleSize = 10 / (canvas.getBoundingClientRect().width / canvas.width); const h = {'tl':{x:cropBox.x,y:cropBox.y},'tr':{x:cropBox.x+cropBox.w,y:cropBox.y},'bl':{x:cropBox.x,y:cropBox.y+cropBox.h},'br':{x:cropBox.x+cropBox.w,y:cropBox.y+cropBox.h},'t':{x:cropBox.x+cropBox.w/2,y:cropBox.y},'b':{x:cropBox.x+cropBox.w/2,y:cropBox.y+cropBox.h},'l':{x:cropBox.x,y:cropBox.y+cropBox.h/2},'r':{x:cropBox.x+cropBox.w,y:cropBox.y+cropBox.h/2},}; for(const[n,p]of Object.entries(h)){if(Math.abs(x-p.x)<handleSize&&Math.abs(y-p.y)<handleSize)return n;} return null;}
    function getCursorForCropHandle(handle) { if (handle === 'tl' || handle === 'br') return 'nwse-resize'; if (handle === 'tr' || handle === 'bl') return 'nesw-resize'; if (handle === 't' || handle === 'b') return 'ns-resize'; if (handle === 'l' || handle === 'r') return 'ew-resize'; return 'move';}
    function updateCropBox(x,y){const min=20;const[ox,oy,ow,oh]=[cropBox.x,cropBox.y,cropBox.w,cropBox.h];switch(dragHandle){case'tl':cropBox.x=x;cropBox.y=y;cropBox.w+=ox-x;cropBox.h+=oy-y;break;case'tr':cropBox.y=y;cropBox.w=x-ox;cropBox.h+=oy-y;break;case'bl':cropBox.x=x;cropBox.w+=ox-x;cropBox.h=y-oy;break;case'br':cropBox.w=x-ox;cropBox.h=y-oy;break;case't':cropBox.y=y;cropBox.h+=oy-y;break;case'b':cropBox.h=y-oy;break;case'l':cropBox.x=x;cropBox.w+=ox-x;break;case'r':cropBox.w=x-ox;break;case'move':cropBox.x+=x-(ox+ow/2);cropBox.y+=y-(oy+oh/2);break;}if(cropBox.w<min)cropBox.w=min;if(cropBox.h<min)cropBox.h=min;}
    function drawCropUI() { ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.clearRect(cropBox.x,cropBox.y,cropBox.w,cropBox.h); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth=1; ctx.strokeRect(cropBox.x,cropBox.y,cropBox.w,cropBox.h); ctx.restore(); }
    function drawRadialPreview() { ctx.save(); ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=2; const{startX,startY,endX,endY}=radialMaskParams; const cx=startX,cy=startY;const rx=Math.abs(endX-cx);const ry=Math.abs(endY-cy); ctx.beginPath(); ctx.ellipse(cx,cy,rx,ry,0,0,2*Math.PI); ctx.stroke(); ctx.restore(); }
    function saveImage() { if (!originalImage) return; const link = document.createElement('a'); link.download = 'luma-edited.png'; link.href = canvas.toDataURL('image/png'); link.click(); }
    function savePreset() { if(historyIndex < 0) return; const state = historyStack[historyIndex]; const preset = {globalEdits: state.globalEdits, masks: state.masks.map(m=>({name:m.name,type:m.type,params:m.params,edits:m.edits}))}; const blob=new Blob([JSON.stringify(preset,null,2)],{type:'application/json'}); const link=document.createElement('a'); link.href=URL.createObjectURL(blob); link.download='preset.luma'; link.click();}
    function loadPreset(e) { if(!originalImage) return alert("Load image first"); const file=e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=(event)=>{try{const preset=JSON.parse(event.target.result);const state=historyStack[historyIndex];state.globalEdits=preset.globalEdits;state.masks=preset.masks.map(m=>({...m,id:'mask_'+Date.now()}));state.activeMaskId=null;pushHistory('Load Preset');}catch(e){alert('Invalid preset file.');}}; reader.readAsText(file);}
    function showLoader(text) { allDOMElements.loaderText.innerText = text; allDOMElements.loaderOverlay.classList.remove('hidden'); }
    function hideLoader() { allDOMElements.loaderOverlay.classList.add('hidden'); }
    function applyBoxBlur(srcData, width, height, radius) { const dstData = new Uint8ClampedArray(srcData.length); for (let i = 0; i < srcData.length; i += 4) { let r_sum = 0, g_sum = 0, b_sum = 0, count = 0; const x = (i/4) % width; const y = Math.floor((i/4) / width); for (let dy = -radius; dy <= radius; dy++) { for (let dx = -radius; dx <= radius; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && nx < width && ny >= 0 && ny < height) { const n_idx = (ny * width + nx) * 4; r_sum += srcData[n_idx]; g_sum += srcData[n_idx+1]; b_sum += srcData[n_idx+2]; count++; } } } dstData[i] = r_sum / count; dstData[i+1] = g_sum / count; dstData[i+2] = b_sum / count; dstData[i+3] = 255; } return dstData; }
    function rgbToHsl(r, g, b) { r /= 255, g /= 255, b /= 255; let max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s, l = (max + min) / 2; if (max == min) { h = s = 0; } else { let d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; } h /= 6; } return [h, s, l]; }
    function hslToRgb(h, s, l) { let r, g, b; if (s == 0) { r = g = b = l; } else { function hue2rgb(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1/6) return p + (q - p) * 6 * t; if (t < 1/2) return q; if (t < 2/3) return p + (q - p) * (2/3 - t) * 6; return p; } let q = l < 0.5 ? l * (1 + s) : l + s - l * s; let p = 2 * l - q; r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3); } return [r * 255, g * 255, b * 255]; }
});
