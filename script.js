document.addEventListener('DOMContentLoaded', () => {
    // =================================================================================
    // 1. DOM Element References
    // =================================================================================
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const dom = {
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
        maskEditTitle: document.getElementById('mask-edit-title'),
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
        ioButtons: document.querySelector('.io-buttons'),
        allToolButtons: document.querySelectorAll('.tool-button, #mask-tools button'),
        allSliders: document.querySelectorAll('.slider')
    };

    // =================================================================================
    // 2. State Management Variables
    // =================================================================================
    let originalImage = null, originalImageData = null, historyStack = [], historyIndex = -1;
    let currentTool = null, isDragging = false, dragHandle = null, dragStart = {};
    let radialMaskParams = {}, cropBox = {}, bodyPixModel = null, toneCurve;
    let blurredDataCache = { id: null, data: null }; // Cache for clarity/texture blur

    const getEmptyEdits = () => ({
        exposure: 0, contrast: 0, highlights: 0, shadows: 0,
        temperature: 0, saturation: 0,
        shadowsHue: 0, shadowsSaturation: 0, midtonesHue: 0, midtonesSaturation: 0, highlightsHue: 0, highlightsSaturation: 0,
        texture: 0, clarity: 0, dehaze: 0,
        toneCurvePoints: [{x: 0, y: 255}, {x: 255, y: 0}]
    });

    // =================================================================================
    // 3. Tone Curve Class (Self-Contained Module)
    // =================================================================================
    class ToneCurve {
        constructor(containerId,onChange){this.container=document.getElementById(containerId);this.onChange=onChange;this.points=[{x:0,y:255},{x:255,y:0}];this.lut=null;this.draggingPoint=null;this.init();}
        init(){this.canvas=document.createElement('canvas');this.canvas.id='toneCurveCanvas';this.canvas.width=256;this.canvas.height=256;this.ctx=this.canvas.getContext('2d');const r=document.createElement('button');r.id='resetCurveButton';r.innerText='Reset';r.onclick=()=>{this.setPoints([{x:0,y:255},{x:255,y:0}]);this.onChange(true);};this.container.innerHTML='';this.container.appendChild(this.canvas);this.container.appendChild(r);this.canvas.addEventListener('mousedown',this.onMouseDown.bind(this));this.canvas.addEventListener('mousemove',this.onMouseMove.bind(this));this.canvas.addEventListener('mouseup',this.onMouseUp.bind(this));this.canvas.addEventListener('mouseleave',this.onMouseUp.bind(this));this.draw();this.generateLUT();}
        setPoints(p){this.points=JSON.parse(JSON.stringify(p)).sort((a,b)=>a.x-b.x);this.draw();this.generateLUT();}
        draw(){this.ctx.fillStyle='#2c2c2c';this.ctx.fillRect(0,0,256,256);this.ctx.strokeStyle='#444';this.ctx.lineWidth=0.5;this.ctx.beginPath();[64,128,192].forEach(p=>{this.ctx.moveTo(p,0);this.ctx.lineTo(p,256);this.ctx.moveTo(0,p);this.ctx.lineTo(256,p);});this.ctx.stroke();this.ctx.strokeStyle='#e0e0e0';this.ctx.lineWidth=2;this.ctx.beginPath();this.ctx.moveTo(this.points[0].x,this.points[0].y);for(let i=1;i<this.points.length;i++){this.ctx.lineTo(this.points[i].x,this.points[i].y);}this.ctx.stroke();this.ctx.fillStyle='#00aeff';this.points.forEach(p=>{this.ctx.beginPath();this.ctx.arc(p.x,p.y,4,0,2*Math.PI);this.ctx.fill();});}
        generateLUT(){this.lut=new Uint8ClampedArray(256);for(let i=0;i<256;i++){let p1_idx=0;while(p1_idx<this.points.length-2&&this.points[p1_idx+1].x<i){p1_idx++;}const p1=this.points[p1_idx];const p2=this.points[p1_idx+1];const t=(p1.x===p2.x)?0:(i-p1.x)/(p2.x-p1.x);const y=255-(p1.y+t*(p2.y-p1.y));this.lut[i]=Math.max(0,Math.min(255,y));}}
        onMouseDown(e){const x=e.offsetX;const y=e.offsetY;let f=null;for(const p of this.points){if(Math.hypot(p.x-x,p.y-y)<8){f=p;break;}}if(f&&e.ctrlKey&&this.points.length>2&&(f.x!==0&&f.x!==255)){this.points=this.points.filter(p=>p!==f);this.draggingPoint=null;this.draw();this.generateLUT();this.onChange(true);}else if(f){this.draggingPoint=f;}else{const nP={x,y};this.points.push(nP);this.points.sort((a,b)=>a.x-b.x);this.draggingPoint=nP;}this.draw();}
        onMouseMove(e){if(!this.draggingPoint)return;if(this.draggingPoint.x!==0&&this.draggingPoint.x!==255){this.draggingPoint.x=Math.max(1,Math.min(254,e.offsetX));}this.draggingPoint.y=Math.max(0,Math.min(255,e.offsetY));this.points.sort((a,b)=>a.x-b.x);this.draw();this.onChange(false);}
        onMouseUp(){if(this.draggingPoint){this.draggingPoint=null;this.generateLUT();this.onChange(true);}}
    }
    
    // =================================================================================
    // 4. Initialization
    // =================================================================================
    async function init() {
        setupEventListeners();
        toneCurve = new ToneCurve('toneCurveContainer', (commit) => { if (originalImage && commit) pushHistory('Adjust Tone Curve'); else if(originalImage) render(); });
        await loadBodyPixModel();
        updateUI();
    }
    init();

    async function loadBodyPixModel() { try { showLoader('Loading AI Model...'); bodyPixModel = await bodyPix.load({architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2}); hideLoader(); } catch (e) { console.error("Failed to load BodyPix model:", e); dom.loaderText.innerText = 'Failed to load AI Model.'; } }

    function setupEventListeners() {
        dom.loadButton.addEventListener('click', () => dom.imageLoader.click());
        dom.imageLoader.addEventListener('change', handleImageLoad);
        dom.saveButton.addEventListener('click', saveImage);
        dom.undoButton.addEventListener('click', undo);
        dom.redoButton.addEventListener('click', redo);
        dom.selectSubjectButton.addEventListener('click', createSubjectMask);
        dom.radialMaskButton.addEventListener('click', startRadialMaskTool);
        dom.showMaskOverlayCheckbox.addEventListener('change', render);
        dom.deleteMaskButton.addEventListener('click', deleteActiveMask);
        dom.savePresetButton.addEventListener('click', savePreset);
        dom.loadPresetButton.addEventListener('click', () => dom.presetLoader.click());
        dom.presetLoader.addEventListener('change', loadPreset);
        dom.cropButton.addEventListener('click', startCropTool);
        dom.applyCropButton.addEventListener('click', applyCrop);
        dom.cancelCropButton.addEventListener('click', cancelCrop);
        dom.rotateLeftButton.addEventListener('click', () => applyRotation(-90));
        dom.rotateRightButton.addEventListener('click', () => applyRotation(90));
        dom.flipHorizontalButton.addEventListener('click', () => applyFlip('horizontal'));
        dom.flipVerticalButton.addEventListener('click', () => applyFlip('vertical'));
        dom.allSliders.forEach(slider => { slider.addEventListener('input', handleSliderInput); slider.addEventListener('change', handleSliderChange); });
        canvas.addEventListener('mousedown', onCanvasMouseDown); canvas.addEventListener('mousemove', onCanvasMouseMove); canvas.addEventListener('mouseup', onCanvasMouseUp); canvas.addEventListener('mouseleave', onCanvasMouseUp);
    }
    
    // =================================================================================
    // 5. Image Handling & Destructive Transforms
    // =================================================================================
    function handleImageLoad(e) { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = (ev) => { originalImage = new Image(); originalImage.onload = () => commitTransform(originalImage, 'Load Image'); originalImage.src = ev.target.result; }; r.readAsDataURL(f); }
    function commitTransform(img, name) { originalImage = img; canvas.width = img.width; canvas.height = img.height; ctx.drawImage(img, 0, 0); originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height); historyStack = []; historyIndex = -1; currentTool = null; pushHistory(name, true); updateUI(); }
    function startCropTool() { if (!originalImage) return; currentTool = 'crop'; cropBox = { x: 0, y: 0, w: canvas.width, h: canvas.height }; updateUI(); render(); }
    function applyCrop() { if (!originalImage) return; const c = document.createElement('canvas'); c.width = cropBox.w; c.height = cropBox.h; const tempCtx = c.getContext('2d'); tempCtx.drawImage(canvas, cropBox.x, cropBox.y, cropBox.w, cropBox.h, 0, 0, cropBox.w, cropBox.h); const img = new Image(); img.onload = () => commitTransform(img, 'Apply Crop'); img.src = c.toDataURL(); }
    function cancelCrop() { currentTool = null; render(); updateUI(); }
    function applyRotation(deg) { if (!originalImage) return; const rad = deg * Math.PI / 180; const w = canvas.width, h = canvas.height; const nW = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)); const nH = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)); const c = document.createElement('canvas'); c.width = nW; c.height = nH; const tCtx = c.getContext('2d'); tCtx.translate(nW / 2, nH / 2); tCtx.rotate(rad); tCtx.drawImage(canvas, -w / 2, -h / 2); const img = new Image(); img.onload = () => commitTransform(img, `Rotate ${deg}°`); img.src = c.toDataURL(); }
    function applyFlip(dir) { if (!originalImage) return; const w = canvas.width, h = canvas.height; const c = document.createElement('canvas'); c.width = w; c.height = h; const tCtx = c.getContext('2d'); if (dir === 'horizontal') { tCtx.translate(w, 0); tCtx.scale(-1, 1); } else { tCtx.translate(0, h); tCtx.scale(1, -1); } tCtx.drawImage(canvas, 0, 0); const img = new Image(); img.onload = () => commitTransform(img, `Flip ${dir}`); img.src = c.toDataURL(); }

    // =================================================================================
    // 6. History & State Management
    // =================================================================================
    function pushHistory(actionName, isBaseState = false) {
        if (!originalImage) return;
        const currentState = (historyIndex > -1 && !isBaseState) ? historyStack[historyIndex] : { globalEdits: getEmptyEdits(), masks: [], activeMaskId: null };
        const newState = JSON.parse(JSON.stringify(currentState));
        
        // Update state from UI elements
        dom.allSliders.forEach(s => { const key = s.id.replace('mask-', ''); if (s.closest('#mask-edit-panel')) { if (newState.activeMaskId) { const mask = newState.masks.find(m => m.id === newState.activeMaskId); if (mask) mask.edits[key] = parseFloat(s.value); } } else { newState.globalEdits[key] = parseFloat(s.value); } });
        if(toneCurve) newState.globalEdits.toneCurvePoints = toneCurve.points;
        newState.actionName = actionName;

        historyStack = historyStack.slice(0, historyIndex + 1); historyStack.push(newState); historyIndex++;
        render(); updateUI();
    }
    function loadState(index) {
        if (index < 0 || index >= historyStack.length) return; historyIndex = index; const state = historyStack[historyIndex];
        Object.entries(state.globalEdits).forEach(([key, value]) => { const s = document.getElementById(key); if(s && s.type === 'range') s.value = value; });
        if (toneCurve && state.globalEdits.toneCurvePoints) toneCurve.setPoints(state.globalEdits.toneCurvePoints);
        const activeMask = state.activeMaskId ? state.masks.find(m => m.id === state.activeMaskId) : null;
        document.querySelectorAll('#mask-edit-panel .slider').forEach(s => { const key = s.id.replace('mask-', ''); s.value = activeMask ? (activeMask.edits[key] || 0) : 0; });
        render(); updateUI();
    }
    function undo() { if (historyIndex > 0) loadState(historyIndex - 1); }
    function redo() { if (historyIndex < historyStack.length - 1) loadState(historyIndex + 1); }

    // =================================================================================
    // 7. Masking Logic
    // =================================================================================
    async function createSubjectMask() { if (!originalImage || !bodyPixModel) return; showLoader('Detecting Subject...'); const seg = await bodyPixModel.segmentPerson(canvas, { flipHorizontal: false, internalResolution: 'medium', segmentationThreshold: 0.7 }); const maskData = new Uint8ClampedArray(seg.data.map(p => p * 255)); const mask = { id: 'mask_' + Date.now(), name: 'Subject '+(historyStack[historyIndex].masks.length+1), type: 'ai', edits: getEmptyEdits(), maskData: Array.from(maskData) }; const state = historyStack[historyIndex]; state.masks.push(mask); state.activeMaskId = mask.id; pushHistory('Select Subject'); hideLoader(); }
    function startRadialMaskTool() { if (!originalImage) return; currentTool = 'radial'; canvas.classList.add('drawing'); }
    function deleteActiveMask() { const state = historyStack[historyIndex]; if (!state.activeMaskId) return; state.masks = state.masks.filter(m => m.id !== state.activeMaskId); state.activeMaskId = null; pushHistory('Delete Mask'); }

    // =================================================================================
    // 8. Canvas & Slider Event Handlers
    // =================================================================================
    function onCanvasMouseDown(e) { if (!originalImage || !currentTool) return; isDragging = true; dragStart = getCanvasCoords(e); if (currentTool === 'crop') { dragHandle = getCropHandleAt(dragStart.x, dragStart.y) || 'move'; canvas.style.cursor = getCursorForCropHandle(dragHandle); } else if (currentTool === 'radial') { radialMaskParams = { startX: dragStart.x, startY: dragStart.y, endX: dragStart.x, endY: dragStart.y }; } }
    function onCanvasMouseMove(e) { if (!isDragging) return; const currentPos = getCanvasCoords(e); if (currentTool === 'crop') { updateCropBox(currentPos); render(); } else if (currentTool === 'radial') { radialMaskParams.endX = currentPos.x; radialMaskParams.endY = currentPos.y; render(); } }
    function onCanvasMouseUp() { if (!isDragging) return; isDragging = false; canvas.style.cursor = 'default'; if (currentTool === 'radial') { const {startX, startY, endX, endY} = radialMaskParams; const rx = Math.abs(endX - startX), ry = Math.abs(endY - startY); if(rx < 5 && ry < 5) { currentTool = null; render(); return; } const mask = { id: 'mask_'+Date.now(), name: `Radial ${historyStack[historyIndex].masks.length+1}`, type: 'radial', params: { cx: startX, cy: startY, rx, ry }, edits: getEmptyEdits() }; const state = historyStack[historyIndex]; state.masks.push(mask); state.activeMaskId = mask.id; pushHistory('Add Radial Mask'); } currentTool = null; dragHandle = null; }
    function handleSliderInput() { if (originalImage) requestAnimationFrame(render); }
    function handleSliderChange(e) { if (originalImage) pushHistory('Adjust ' + e.target.id); }

    // =================================================================================
    // 9. Core Rendering Pipeline
    // =================================================================================
    function render() {
        if (!originalImageData || historyIndex < 0) return;
        const state = historyStack[historyIndex]; if (!state) return;
        ctx.putImageData(originalImageData, 0, 0); const workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const clarity = state.globalEdits.clarity, texture = state.globalEdits.texture; const blurId = `${clarity}_${texture}`;
        if ((clarity !== 0 || texture !== 0) && blurredDataCache.id !== blurId) { blurredDataCache = { id: blurId, data: applyBoxBlur(workingImageData.data, canvas.width, canvas.height, 5) }; }
        applyEditsToData(workingImageData.data, state.globalEdits, null, toneCurve.lut);
        for (const mask of state.masks) { let maskPixelData = generateMaskPixelData(mask); if (maskPixelData) applyEditsToData(workingImageData.data, mask.edits, maskPixelData, null); }
        ctx.putImageData(workingImageData, 0, 0);
        if (state.activeMaskId && dom.showMaskOverlayCheckbox.checked) { const mask = state.masks.find(m => m.id === state.activeMaskId); if (mask) { let maskData = generateMaskPixelData(mask); const oD = new ImageData(canvas.width, canvas.height); for (let i = 0; i < oD.data.length; i += 4) { oD.data[i] = 255; oD.data[i+3] = maskData[i/4] * 0.5; } ctx.putImageData(oD, 0, 0); } }
        if (currentTool === 'crop') drawCropUI(); if (currentTool === 'radial' && isDragging) drawRadialPreview();
    }
    function applyEditsToData(data,edits,maskData,curveLUT){const{exposure,contrast,highlights,shadows,temperature,saturation,texture,clarity,dehaze,shadowsHue,shadowsSaturation,midtonesHue,midtonesSaturation,highlightsHue,highlightsSaturation}=edits;const eF=Math.pow(2,exposure/50);const cF=(259*(contrast+255))/(255*(259-contrast));const hF=highlights/100;const sF=shadows/100;const satF=1+(saturation/100);for(let i=0;i<data.length;i+=4){const mV=maskData?maskData[i/4]/255:1;if(mV===0)continue;const oR=data[i],oG=data[i+1],oB=data[i+2];let r=oR,g=oG,b=oB;if(curveLUT){r=curveLUT[r];g=curveLUT[g];b=curveLUT[b];}r*=eF;g*=eF;b*=eF;r=cF*(r-128)+128;g=cF*(g-128)+128;b=cF*(b-128)+128;const lum=0.2126*r+0.7152*g+0.0722*b;if(hF!==0){const hf=(lum/255)**2;r+=hf*hF*(255-r);g+=hf*hF*(255-g);b+=hf*hF*(255-b);}if(sF!==0){const sf=(1-(lum/255))**2;r+=sf*sF*r;g+=sf*sF*g;b+=sf*sF*b;}if(dehaze!==0){const mC=Math.min(r,g,b);const hf=(mC/255);const dA=dehaze/100*(1-hf)*20;r+=dA;g+=dA;b+=dA;}if(clarity!==0&&blurredDataCache.data){const bL=0.2126*blurredDataCache.data[i]+0.7152*blurredDataCache.data[i+1]+0.0722*blurredDataCache.data[i+2];const lC=lum-bL;const cA=lC*(clarity/250);r+=cA;g+=cA;b+=cA;}const lG=0.2126*r+0.7152*g+0.0722*b;let hS=0,sS=0;if(lG<85){const t=lG/85;hS=t*midtonesHue+(1-t)*shadowsHue;sS=t*midtonesSaturation+(1-t)*shadowsSaturation;}else if(lG>170){const t=(lG-170)/85;hS=(1-t)*midtonesHue+t*highlightsHue;sS=(1-t)*midtonesSaturation+t*highlightsSaturation;}else{hS=midtonesHue;sS=midtonesSaturation;}if(sS>0){const hsl=rgbToHsl(r,g,b);hsl[0]=(hsl[0]*360+hS)%360/360;hsl[1]+=sS/100;const rgb=hslToRgb(hsl[0],hsl[1],hsl[2]);r=rgb[0];g=rgb[1];b=rgb[2];}r+=temperature;g+=temperature*0.5;b-=temperature;const avg=(r+g+b)/3;r=avg+satF*(r-avg);g=avg+satF*(g-avg);b=avg+satF*(b-avg);data[i]=oR+(r-oR)*mV;data[i+1]=oG+(g-oG)*mV;data[i+2]=oB+(b-oB)*mV;data[i]=Math.max(0,Math.min(255,data[i]));data[i+1]=Math.max(0,Math.min(255,data[i+1]));data[i+2]=Math.max(0,Math.min(255,data[i+2]));}}
    
    // =================================================================================
    // 10. UI Update & Helper Functions
    // =================================================================================
    function updateUI(){dom.undoButton.disabled=historyIndex<=0;dom.redoButton.disabled=historyIndex>=historyStack.length-1;const state=historyIndex>-1?historyStack[historyIndex]:null;dom.maskList.innerHTML='';if(state){state.masks.forEach(m=>{const li=document.createElement('li');li.textContent=m.name;li.className=m.id===state.activeMaskId?'active':'';li.onclick=()=>{if(currentTool)return;state.activeMaskId=m.id;loadState(historyIndex);};dom.maskList.appendChild(li);});dom.maskEditPanel.classList.toggle('hidden',!state.activeMaskId);if(state.activeMaskId)dom.maskEditTitle.innerText=`Edit: ${state.masks.find(m=>m.id===state.activeMaskId).name}`;else{document.querySelectorAll('#mask-edit-panel .slider').forEach(sl=>sl.value=0);}}const iCM=currentTool==='crop';dom.cropControls.classList.toggle('hidden',!iCM);dom.ioButtons.classList.toggle('hidden',iCM);canvas.classList.toggle('cropping',iCM);dom.allToolButtons.forEach(el=>el.disabled=iCM||!originalImage);dom.allSliders.forEach(el=>el.disabled=iCM||!originalImage);dom.historyList.innerHTML='';historyStack.forEach((st,i)=>{const li=document.createElement('li');li.textContent=st.actionName;li.className=i===historyIndex?'active':'';li.onclick=()=>loadState(i);dom.historyList.appendChild(li);});dom.historyList.scrollTop=dom.historyList.scrollHeight;}
    function generateMaskPixelData(m){if(m.type==='ai')return new Uint8ClampedArray(m.maskData);if(m.type==='radial'){const{cx,cy,rx,ry}=m.params;const d=new Uint8ClampedArray(canvas.width*canvas.height);for(let y=0;y<canvas.height;y++){for(let x=0;x<canvas.width;x++){const i=y*canvas.width+x;const v=((x-cx)/rx)**2+((y-cy)/ry)**2;d[i]=v<1?(1-Math.sqrt(v))*255:0;}}return d;}return null;}
    function getCanvasCoords(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*canvas.width,y:(e.clientY-r.top)/r.height*canvas.height};}
    function getCropHandleAt(x,y){const s=10/(canvas.getBoundingClientRect().width/canvas.width);const h={tl:{x:cropBox.x,y:cropBox.y},tr:{x:cropBox.x+cropBox.w,y:cropBox.y},bl:{x:cropBox.x,y:cropBox.y+cropBox.h},br:{x:cropBox.x+cropBox.w,y:cropBox.y+cropBox.h},t:{x:cropBox.x+cropBox.w/2,y:cropBox.y},b:{x:cropBox.x+cropBox.w/2,y:cropBox.y+cropBox.h},l:{x:cropBox.x,y:cropBox.y+cropBox.h/2},r:{x:cropBox.x+cropBox.w,y:cropBox.y+cropBox.h/2},};for(const[n,p]of Object.entries(h)){if(Math.hypot(x-p.x,y-p.y)<s)return n;}return null;}
    function getCursorForCropHandle(h){if(h==='tl'||h==='br')return'nwse-resize';if(h==='tr'||h==='bl')return'nesw-resize';if(h==='t'||h==='b')return'ns-resize';if(h==='l'||h==='r')return'ew-resize';return'move';}
    function updateCropBox(pos){const min=20;const dx=pos.x-dragStart.x;const dy=pos.y-dragStart.y;if(dragHandle==='move'){cropBox.x+=dx;cropBox.y+=dy;}if(dragHandle.includes('l')){cropBox.x+=dx;cropBox.w-=dx;}if(dragHandle.includes('r')){cropBox.w+=dx;}if(dragHandle.includes('t')){cropBox.y+=dy;cropBox.h-=dy;}if(dragHandle.includes('b')){cropBox.h+=dy;}if(cropBox.w<min){if(dragHandle.includes('l'))cropBox.x-=min-cropBox.w;cropBox.w=min;}if(cropBox.h<min){if(dragHandle.includes('t'))cropBox.y-=min-cropBox.h;cropBox.h=min;}dragStart=pos;}
    function drawCropUI(){ctx.save();ctx.fillStyle='rgba(0,0,0,0.5)';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.clearRect(cropBox.x,cropBox.y,cropBox.w,cropBox.h);ctx.strokeStyle='rgba(255,255,255,0.8)';ctx.lineWidth=1;ctx.strokeRect(cropBox.x,cropBox.y,cropBox.w,cropBox.h);ctx.restore();}
    function drawRadialPreview(){ctx.save();ctx.strokeStyle='rgba(255,255,255,0.8)';ctx.lineWidth=2;const{startX,startY,endX,endY}=radialMaskParams;ctx.beginPath();ctx.ellipse(startX,startY,Math.abs(endX-startX),Math.abs(endY-startY),0,0,2*Math.PI);ctx.stroke();ctx.restore();}
    function saveImage(){if(!originalImage)return;const l=document.createElement('a');l.download='luma-edited.png';l.href=canvas.toDataURL('image/png');l.click();}
    function savePreset(){if(historyIndex<0)return;const s=historyStack[historyIndex];const p={globalEdits:s.globalEdits,masks:s.masks.map(m=>({name:m.name,type:m.type,params:m.params,edits:m.edits}))};const b=new Blob([JSON.stringify(p,null,2)],{type:'application/json'});const l=document.createElement('a');l.href=URL.createObjectURL(b);l.download='preset.luma';l.click();}
    function loadPreset(e){if(!originalImage)return alert("Load image first");const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=(ev)=>{try{const p=JSON.parse(ev.target.result);const s=historyStack[historyIndex];s.globalEdits=p.globalEdits;s.masks=p.masks.map(m=>({...m,id:'mask_'+Date.now()}));s.activeMaskId=null;pushHistory('Load Preset');}catch(e){alert('Invalid preset file.');}};r.readAsText(f);}
    function showLoader(t){dom.loaderText.innerText=t;dom.loaderOverlay.classList.remove('hidden');}
    function hideLoader(){dom.loaderOverlay.classList.add('hidden');}
    function applyBoxBlur(src,w,h,r){const dst=new Uint8ClampedArray(src.length);for(let i=0;i<src.length;i+=4){let rs=0,gs=0,bs=0,c=0;const x=(i/4)%w,y=Math.floor((i/4)/w);for(let dy=-r;dy<=r;dy++){for(let dx=-r;dx<=r;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&nx<w&&ny>=0&&ny<h){const ni=(ny*w+nx)*4;rs+=src[ni];gs+=src[ni+1];bs+=src[ni+2];c++;}}}dst[i]=rs/c;dst[i+1]=gs/c;dst[i+2]=bs/c;dst[i+3]=255;}return dst;}
    function rgbToHsl(r,g,b){r/=255,g/=255,b/=255;let max=Math.max(r,g,b),min=Math.min(r,g,b);let h,s,l=(max+min)/2;if(max==min){h=s=0;}else{let d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}h/=6;}return[h,s,l];}
    function hslToRgb(h,s,l){let r,g,b;if(s==0){r=g=b=l;}else{function hue2rgb(p,q,t){if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;}let q=l<0.5?l*(1+s):l+s-l*s;let p=2*l-q;r=hue2rgb(p,q,h+1/3);g=hue2rgb(p,q,h);b=hue2rgb(p,q,h-1/3);}return[r*255,g*255,b*255];}
});
