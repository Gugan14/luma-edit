document.addEventListener('DOMContentLoaded', () => {
    // =================================================================================
    // 1. STATE MANAGEMENT & DOM REFERENCES
    // =================================================================================
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const dom = {}; // Populated in init()

    let originalImage = null, originalImageData = null, historyStack = [], historyIndex = -1;
    let currentTool = null, isDragging = false, dragHandle = null, dragStartCoords = {};
    let cropBox = {}, bodyPixModel = null, toneCurve;
    let blurCache = { clarity: null, texture: null, id: '' };

    // =================================================================================
    // 2. INITIALIZATION & SETUP
    // =================================================================================
    async function init() {
        // Cache all DOM elements by their ID for easy, performant access
        document.querySelectorAll('[id]').forEach(el => dom[el.id] = el);
        dom.allSliders = document.querySelectorAll('.slider');
        dom.allToolButtons = document.querySelectorAll('.tool-button, #mask-tools button');
        dom.ioButtons = document.querySelector('.io-buttons');

        setupEventListeners();
        toneCurve = new ToneCurve('toneCurveContainer', (commitChange) => {
            if (originalImage) {
                render(); // Live preview while dragging
                if (commitChange) pushHistory('Adjust Tone Curve'); // Commit to history on release
            }
        });
        await loadBodyPixModel();
        updateUI();
    }
    init();

    async function loadBodyPixModel() {
        try {
            showLoader('Loading AI Model...');
            bodyPixModel = await bodyPix.load({ architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2 });
            hideLoader();
        } catch (e) {
            console.error("Critical: BodyPix model failed to load.", e);
            dom.loaderText.innerText = 'AI Model Failed. Refresh Page.';
        }
    }

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

        dom.allSliders.forEach(slider => {
            slider.addEventListener('input', handleSliderInput);
            slider.addEventListener('change', handleSliderChange);
        });

        canvas.addEventListener('mousedown', onCanvasMouseDown);
        canvas.addEventListener('mousemove', onCanvasMouseMove);
        canvas.addEventListener('mouseup', onCanvasMouseUp);
        canvas.addEventListener('mouseleave', onCanvasMouseUp);
    }

    // =================================================================================
    // 3. CORE RENDERING PIPELINE
    // =================================================================================
    function render() {
        if (!originalImageData || historyIndex < 0) return;
        const state = historyStack[historyIndex];
        if (!state) return;

        ctx.putImageData(originalImageData, 0, 0);
        const workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const gEdits = state.globalEdits;

        // Efficiently calculate blurs ONLY when values change.
        const blurId = `c${gEdits.clarity}t${gEdits.texture}`;
        if (blurCache.id !== blurId) {
            blurCache.clarity = (gEdits.clarity !== 0) ? applyBoxBlur(workingImageData.data, canvas.width, canvas.height, 5) : null;
            blurCache.texture = (gEdits.texture !== 0) ? applyBoxBlur(workingImageData.data, canvas.width, canvas.height, 1) : null;
            blurCache.id = blurId;
        }

        // Apply global edits first, then layer each mask's edits on top
        applyEditsToData(workingImageData.data, gEdits, null, toneCurve.lut);
        for (const mask of state.masks) {
            const maskPixelData = generateMaskPixelData(mask);
            if (maskPixelData) applyEditsToData(workingImageData.data, mask.edits, maskPixelData, null);
        }
        ctx.putImageData(workingImageData, 0, 0);

        // Draw UI overlays on top of the final rendered image
        if (state.activeMaskId && dom.showMaskOverlayCheckbox.checked) drawMaskOverlay(state);
        if (currentTool === 'crop') drawCropUI();
        if (currentTool === 'radial' && isDragging) drawRadialPreview();
    }

    // =================================================================================
    // 4. NON-DESTRUCTIVE EDIT LOGIC (The Algorithms)
    // =================================================================================
    function applyEditsToData(data, edits, maskData, curveLUT) {
        const { exposure, contrast, highlights, shadows, temperature, saturation, texture, clarity, dehaze, shadowsHue, shadowsSaturation, midtonesHue, midtonesSaturation, highlightsHue, highlightsSaturation } = edits;
        const eF=Math.pow(2,exposure/50),cF=(259*(contrast+255))/(255*(259-contrast)),hF=highlights/100,sF=shadows/100,satF=1+(saturation/100);
        
        for (let i = 0; i < data.length; i += 4) {
            const mV = maskData ? maskData[i/4] / 255 : 1;
            if (mV === 0) continue;
            
            const oR=data[i], oG=data[i+1], oB=data[i+2];
            let r=oR, g=oG, b=oB;

            // 1. Tone Curve (applied first for max control)
            if (curveLUT) { r=curveLUT[r]; g=curveLUT[g]; b=curveLUT[b]; }

            // 2. Core Light Adjustments
            r*=eF;g*=eF;b*=eF; r=cF*(r-128)+128;g=cF*(g-128)+128;b=cF*(b-128)+128;
            let lum=0.2126*r+0.7152*g+0.0722*b;
            if(hF!==0){const hf=(lum/255)**2;r+=hf*hF*(255-r);g+=hf*hF*(255-g);b+=hf*hF*(255-b);}
            if(sF!==0){const sf=(1-(lum/255))**2;r+=sf*sF*r;g+=sf*sF*g;b+=sf*sF*b;}
            
            // 3. Effects (Dehaze, Clarity, Texture)
            if(dehaze!==0){const mC=Math.min(r,g,b);const hf=(mC/255);const dA=dehaze/100*(1-hf)*20;r+=dA;g+=dA;b+=dA;}
            // Unsharp Masking for Clarity/Texture. Applied only to global edits for performance.
            if (!maskData) {
                if(clarity!==0 && blurCache.clarity){const bR=blurCache.clarity[i],bG=blurCache.clarity[i+1],bB=blurCache.clarity[i+2];r+=(r-bR)*clarity*0.015;g+=(g-bG)*clarity*0.015;b+=(b-bB)*clarity*0.015;}
                if(texture!==0 && blurCache.texture){const bR=blurCache.texture[i],bG=blurCache.texture[i+1],bB=blurCache.texture[i+2];r+=(r-bR)*texture*0.025;g+=(g-bG)*texture*0.025;b+=(b-bB)*texture*0.025;}
            }

            // 4. Color Adjustments (Grading, Temp, Saturation)
            const lG=0.2126*r+0.7152*g+0.0722*b;let hS=0,sS=0;
            if(lG<85){const t=lG/85;hS=t*midtonesHue+(1-t)*shadowsHue;sS=t*midtonesSaturation+(1-t)*shadowsSaturation;}
            else if(lG>170){const t=(lG-170)/85;hS=(1-t)*midtonesHue+t*highlightsHue;sS=(1-t)*midtonesSaturation+t*highlightsSaturation;}
            else{hS=midtonesHue;sS=midtonesSaturation;}
            if(sS>0){const hsl=rgbToHsl(r,g,b);hsl[0]=(hsl[0]*360+hS)%360/360;hsl[1]+=sS/100;const rgb=hslToRgb(hsl[0],hsl[1],hsl[2]);r=rgb[0];g=rgb[1];b=rgb[2];}
            r+=temperature;g+=temperature*0.5;b-=temperature;
            const avg=(r+g+b)/3;r=avg+satF*(r-avg);g=avg+satF*(g-avg);b=avg+satF*(b-avg);

            // 5. Final Blend & Clamp
            data[i]=oR+(r-oR)*mV;data[i+1]=oG+(g-oG)*mV;data[i+2]=oB+(b-oB)*mV;
            data[i]=Math.max(0,Math.min(255,data[i]));data[i+1]=Math.max(0,Math.min(255,data[i+1]));data[i+2]=Math.max(0,Math.min(255,data[i+2]));
        }
    }
    
    // =================================================================================
    // 5. DESTRUCTIVE EDIT LOGIC (Transforms)
    // =================================================================================
    function commitTransform(img, name) { originalImage=img;canvas.width=img.width;canvas.height=img.height;ctx.drawImage(img,0,0);originalImageData=ctx.getImageData(0,0,canvas.width,canvas.height);historyStack=[];historyIndex=-1;currentTool=null;blurCache={clarity:null,texture:null,id:''};pushHistory(name,true);updateUI();}
    function applyRotation(deg) { if(!originalImage)return;const rad=deg*Math.PI/180;const w=canvas.width,h=canvas.height;const nW=Math.round(Math.abs(w*Math.cos(rad))+Math.abs(h*Math.sin(rad)));const nH=Math.round(Math.abs(w*Math.sin(rad))+Math.abs(h*Math.cos(rad)));const c=document.createElement('canvas');c.width=nW;c.height=nH;const tCtx=c.getContext('2d');tCtx.translate(nW/2,nH/2);tCtx.rotate(rad);tCtx.drawImage(canvas,-w/2,-h/2);const img=new Image();img.onload=()=>commitTransform(img,`Rotate ${deg}°`);img.src=c.toDataURL();}
    function applyFlip(dir) { if(!originalImage)return;const w=canvas.width,h=canvas.height;const c=document.createElement('canvas');c.width=w;c.height=h;const tCtx=c.getContext('2d');if(dir==='horizontal'){tCtx.translate(w,0);tCtx.scale(-1,1);}else{tCtx.translate(0,h);tCtx.scale(1,-1);}tCtx.drawImage(canvas,0,0);const img=new Image();img.onload=()=>commitTransform(img,`Flip ${dir}`);img.src=c.toDataURL();}
    
    // =================================================================================
    // 6. MASKING LOGIC
    // =================================================================================
    async function createSubjectMask() { if(!originalImage||!bodyPixModel)return;showLoader('Detecting Subject...');try{const seg=await bodyPixModel.segmentPerson(canvas,{flipHorizontal:false,internalResolution:'medium',segmentationThreshold:0.7});if(seg.data.every(p=>p===0)){alert("No person detected in the image.");hideLoader();return;}const maskData=new Uint8ClampedArray(seg.data.map(p=>p*255));const mask={id:'mask_'+Date.now(),name:`Subject ${historyStack[historyIndex].masks.length+1}`,type:'ai',edits:getEmptyEdits(),maskData:Array.from(maskData)};const state=historyStack[historyIndex];state.masks.push(mask);state.activeMaskId=mask.id;pushHistory('Select Subject');}catch(e){console.error("Masking failed:",e);alert("An error occurred during subject detection.");}finally{hideLoader();}}
    function startRadialMaskTool() { if(!originalImage)return;currentTool='radial';canvas.classList.add('drawing');}
    function deleteActiveMask() {const state=historyStack[historyIndex];if(!state.activeMaskId)return;state.masks=state.masks.filter(m=>m.id!==state.activeMaskId);state.activeMaskId=null;pushHistory('Delete Mask');}

    // =================================================================================
    // 7. HISTORY & STATE
    // =================================================================================
    function getEmptyEdits(){return{exposure:0,contrast:0,highlights:0,shadows:0,temperature:0,saturation:0,shadowsHue:0,shadowsSaturation:0,midtonesHue:0,midtonesSaturation:0,highlightsHue:0,highlightsSaturation:0,texture:0,clarity:0,dehaze:0,toneCurvePoints:[{x:0,y:255},{x:255,y:0}]};}
    function pushHistory(actionName,isBaseState=false){if(!originalImage)return;const currentState=(historyIndex>-1&&!isBaseState)?historyStack[historyIndex]:{globalEdits:getEmptyEdits(),masks:[],activeMaskId:null};const newState=JSON.parse(JSON.stringify(currentState));dom.allSliders.forEach(s=>{const key=s.id.replace('mask-','');if(s.closest('#mask-edit-panel')){if(newState.activeMaskId){const mask=newState.masks.find(m=>m.id===newState.activeMaskId);if(mask)mask.edits[key]=parseFloat(s.value);}}else{newState.globalEdits[key]=parseFloat(s.value);}});if(toneCurve)newState.globalEdits.toneCurvePoints=toneCurve.points;newState.actionName=actionName;historyStack=historyStack.slice(0,historyIndex+1);historyStack.push(newState);historyIndex++;render();updateUI();}
    function loadState(index){if(index<0||index>=historyStack.length)return;historyIndex=index;const state=historyStack[historyIndex];Object.entries(state.globalEdits).forEach(([key,value])=>{const s=document.getElementById(key);if(s&&s.type==='range')s.value=value;});if(toneCurve&&state.globalEdits.toneCurvePoints)toneCurve.setPoints(state.globalEdits.toneCurvePoints);const activeMask=state.activeMaskId?state.masks.find(m=>m.id===state.activeMaskId):null;document.querySelectorAll('#mask-edit-panel .slider').forEach(s=>{const key=s.id.replace('mask-','');s.value=activeMask?(activeMask.edits[key]||0):0;});render();updateUI();}
    function undo(){if(historyIndex>0)loadState(historyIndex-1);}
    function redo(){if(historyIndex<historyStack.length-1)loadState(historyIndex+1);}

    // =================================================================================
    // 8. EVENT HANDLERS
    // =================================================================================
    function onCanvasMouseDown(e){if(!originalImage||!currentTool)return;isDragging=true;dragStartCoords=getCanvasCoords(e);if(currentTool==='crop'){dragHandle=getCropHandleAt(dragStartCoords.x,dragStartCoords.y)||'move';canvas.style.cursor=getCursorForCropHandle(dragHandle);}}
    function onCanvasMouseMove(e){if(!isDragging)return;const currentCoords=getCanvasCoords(e);if(currentTool==='crop'){updateCropBox(currentCoords,dragStartCoords);dragStartCoords=currentCoords;render();}else if(currentTool==='radial'){radialMaskParams={startX:dragStartCoords.x,startY:dragStartCoords.y,endX:currentCoords.x,endY:currentCoords.y};render();}}
    function onCanvasMouseUp(e){if(!isDragging)return;isDragging=false;canvas.style.cursor='default';if(currentTool==='radial'){const{startX,startY,endX,endY}=radialMaskParams;const rx=Math.abs(endX-startX),ry=Math.abs(endY-startY);currentTool=null;canvas.classList.remove('drawing');if(rx>5||ry>5){const mask={id:'mask_'+Date.now(),name:`Radial ${historyStack[historyIndex].masks.length+1}`,type:'radial',params:{cx:startX,cy:startY,rx,ry},edits:getEmptyEdits()};const state=historyStack[historyIndex];state.masks.push(mask);state.activeMaskId=mask.id;pushHistory('Add Radial Mask');}else{render();}}else if(currentTool==='crop'){dragHandle=null;}}
    function handleSliderInput(){if(originalImage)requestAnimationFrame(render);}
    function handleSliderChange(e){if(originalImage){if(e.target.id==='clarity'||e.target.id==='texture')blurCache={clarity:null,texture:null,id:''};pushHistory('Adjust '+e.target.id);}}

    // =================================================================================
    // 9. UI & HELPER FUNCTIONS
    // =================================================================================
    function updateCropBox(currentPos,startPos){const dx=currentPos.x-startPos.x;const dy=currentPos.y-startPos.y;if(dragHandle==='move'){cropBox.x+=dx;cropBox.y+=dy;}else{if(dragHandle.includes('l')){cropBox.x+=dx;cropBox.w-=dx;}if(dragHandle.includes('r')){cropBox.w+=dx;}if(dragHandle.includes('t')){cropBox.y+=dy;cropBox.h-=dy;}if(dragHandle.includes('b')){cropBox.h+=dy;}}const minSize=20;if(cropBox.w<minSize){if(dragHandle.includes('l'))cropBox.x-=(minSize-cropBox.w);cropBox.w=minSize;}if(cropBox.h<minSize){if(dragHandle.includes('t'))cropBox.y-=(minSize-cropBox.h);cropBox.h=minSize;}}
    function updateUI(){dom.undoButton.disabled=historyIndex<=0;dom.redoButton.disabled=historyIndex>=historyStack.length-1;const s=historyIndex>-1?historyStack[historyIndex]:null;dom.maskList.innerHTML='';if(s){s.masks.forEach(m=>{const li=document.createElement('li');li.textContent=m.name;li.className=m.id===s.activeMaskId?'active':'';li.onclick=()=>{if(currentTool)return;s.activeMaskId=m.id===s.activeMaskId?null:m.id;loadState(historyIndex);};dom.maskList.appendChild(li);});dom.maskEditPanel.classList.toggle('hidden',!s.activeMaskId);if(s.activeMaskId)dom.maskEditTitle.innerText=`Edit: ${s.masks.find(m=>m.id===s.activeMaskId).name}`;else{document.querySelectorAll('#mask-edit-panel .slider').forEach(sl=>sl.value=0);}}const iCM=currentTool==='crop';dom.cropControls.classList.toggle('hidden',!iCM);dom.ioButtons.classList.toggle('hidden',iCM);canvas.classList.toggle('cropping',iCM);dom.allToolButtons.forEach(el=>{el.disabled=el.id!=='cropButton'&&(iCM||!originalImage);});dom.allSliders.forEach(el=>el.disabled=iCM||!originalImage);dom.historyList.innerHTML='';historyStack.forEach((st,i)=>{const li=document.createElement('li');li.textContent=st.actionName;li.className=i===historyIndex?'active':'';li.onclick=()=>loadState(i);dom.historyList.appendChild(li);});dom.historyList.scrollTop=dom.historyList.scrollHeight;}
    function generateMaskPixelData(m){if(m.type==='ai')return new Uint8ClampedArray(m.maskData);if(m.type==='radial'){const{cx,cy,rx,ry}=m.params;const d=new Uint8ClampedArray(canvas.width*canvas.height);for(let y=0;y<canvas.height;y++){for(let x=0;x<canvas.width;x++){const i=y*canvas.width+x;const v=((x-cx)/rx)**2+((y-cy)/ry)**2;d[i]=v<1?(1-Math.sqrt(v))*255:0;}}return d;}return null;}
    function getCanvasCoords(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*canvas.width,y:(e.clientY-r.top)/r.height*canvas.height};}
    function getCropHandleAt(x,y){const s=10/(canvas.getBoundingClientRect().width/canvas.width);const h={tl:{x:cropBox.x,y:cropBox.y},tr:{x:cropBox.x+cropBox.w,y:cropBox.y},bl:{x:cropBox.x,y:cropBox.y+cropBox.h},br:{x:cropBox.x+cropBox.w,y:cropBox.y+cropBox.h},t:{x:cropBox.x+cropBox.w/2,y:cropBox.y},b:{x:cropBox.x+cropBox.w/2,y:cropBox.y+cropBox.h},l:{x:cropBox.x,y:cropBox.y+cropBox.h/2},r:{x:cropBox.x+cropBox.w,y:cropBox.y+cropBox.h/2},};for(const[n,p]of Object.entries(h)){if(Math.hypot(x-p.x,y-p.y)<s)return n;}return null;}
    function getCursorForCropHandle(h){if(h==='tl'||h==='br')return'nwse-resize';if(h==='tr'||h==='bl')return'nesw-resize';if(h==='t'||h==='b')return'ns-resize';if(h==='l'||h==='r')return'ew-resize';return'move';}
    function drawCropUI(){ctx.save();ctx.fillStyle='rgba(0,0,0,0.5)';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.clearRect(cropBox.x,cropBox.y,cropBox.w,cropBox.h);ctx.strokeStyle='rgba(255,255,255,0.8)';ctx.lineWidth=1;ctx.strokeRect(cropBox.x,cropBox.y,cropBox.w,cropBox.h);ctx.restore();}
    function drawRadialPreview(){ctx.save();ctx.strokeStyle='rgba(255,255,255,0.8)';ctx.lineWidth=2;const{startX,startY,endX,endY}=radialMaskParams;ctx.beginPath();ctx.ellipse(startX,startY,Math.abs(endX-startX),Math.abs(endY-startY),0,0,2*Math.PI);ctx.stroke();ctx.restore();}
    function drawMaskOverlay(state){const mask=state.masks.find(m=>m.id===state.activeMaskId);if(mask){let maskData=generateMaskPixelData(mask);const oD=new ImageData(canvas.width,canvas.height);for(let i=0;i<oD.data.length;i+=4){oD.data[i]=255;oD.data[i+3]=maskData[i/4]*0.5;}ctx.putImageData(oD,0,0);}}
    function saveImage(){if(!originalImage)return;const l=document.createElement('a');l.download='luma-edited.png';l.href=canvas.toDataURL('image/png');l.click();}
    function savePreset(){if(historyIndex<0)return;const s=historyStack[historyIndex];const p={globalEdits:s.globalEdits,masks:s.masks.map(m=>({name:m.name,type:m.type,params:m.params,edits:m.edits}))};const b=new Blob([JSON.stringify(p,null,2)],{type:'application/json'});const l=document.createElement('a');l.href=URL.createObjectURL(b);l.download='preset.luma';l.click();}
    function loadPreset(e){if(!originalImage)return alert("Load image first");const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=(ev)=>{try{const p=JSON.parse(ev.target.result);const s=historyStack[historyIndex];s.globalEdits=p.globalEdits;s.masks=p.masks.map(m=>({...m,id:'mask_'+Date.now()}));s.activeMaskId=null;pushHistory('Load Preset');}catch(e){alert('Invalid preset file.');}};r.readAsText(f);}
    function showLoader(t){dom.loaderText.innerText=t;dom.loaderOverlay.classList.remove('hidden');}
    function hideLoader(){dom.loaderOverlay.classList.add('hidden');}
    function applyBoxBlur(src,w,h,r){const dst=new Uint8ClampedArray(src.length);for(let i=0;i<src.length;i+=4){let rs=0,gs=0,bs=0,c=0;const x=(i/4)%w,y=Math.floor((i/4)/w);for(let dy=-r;dy<=r;dy++){for(let dx=-r;dx<=r;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&nx<w&&ny>=0&&ny<h){const ni=(ny*w+nx)*4;rs+=src[ni];gs+=src[ni+1];bs+=src[ni+2];c++;}}}dst[i]=rs/c;dst[i+1]=gs/c;dst[i+2]=bs/c;dst[i+3]=255;}return dst;}
    function rgbToHsl(r,g,b){r/=255,g/=255,b/=255;let max=Math.max(r,g,b),min=Math.min(r,g,b);let h,s,l=(max+min)/2;if(max==min){h=s=0;}else{let d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}h/=6;}return[h,s,l];}
    function hslToRgb(h,s,l){let r,g,b;if(s==0){r=g=b=l;}else{function hue2rgb(p,q,t){if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;}let q=l<0.5?l*(1+s):l+s-l*s;let p=2*l-q;r=hue2rgb(p,q,h+1/3);g=hue2rgb(p,q,h);b=hue2rgb(p,q,h-1/3);}return[r*255,g*255,b*255];}

    // =================================================================================
    // 10. TONE CURVE CLASS (Self-Contained Module)
    // =================================================================================
    class ToneCurve{constructor(containerId,onChange){this.container=document.getElementById(containerId);this.onChange=onChange;this.points=[{x:0,y:255},{x:255,y:0}];this.lut=null;this.draggingPoint=null;this.init();}init(){this.canvas=document.createElement('canvas');this.canvas.id='toneCurveCanvas';this.canvas.width=256;this.canvas.height=256;this.ctx=this.canvas.getContext('2d');const r=document.createElement('button');r.id='resetCurveButton';r.innerText='Reset';r.onclick=()=>{this.setPoints([{x:0,y:255},{x:255,y:0}]);this.onChange(true);};this.container.innerHTML='';this.container.appendChild(this.canvas);this.container.appendChild(r);this.canvas.addEventListener('mousedown',this.onMouseDown.bind(this));this.canvas.addEventListener('mousemove',this.onMouseMove.bind(this));this.canvas.addEventListener('mouseup',this.onMouseUp.bind(this));this.canvas.addEventListener('mouseleave',this.onMouseUp.bind(this));this.draw();this.generateLUT();}setPoints(p){this.points=JSON.parse(JSON.stringify(p)).sort((a,b)=>a.x-b.x);this.draw();this.generateLUT();}draw(){this.ctx.fillStyle='#2c2c2c';this.ctx.fillRect(0,0,256,256);this.ctx.strokeStyle='#444';this.ctx.lineWidth=0.5;this.ctx.beginPath();[64,128,192].forEach(p=>{this.ctx.moveTo(p,0);this.ctx.lineTo(p,256);this.ctx.moveTo(0,p);this.ctx.lineTo(256,p);});this.ctx.stroke();this.ctx.strokeStyle='#e0e0e0';this.ctx.lineWidth=2;this.ctx.beginPath();this.ctx.moveTo(this.points[0].x,this.points[0].y);for(let i=1;i<this.points.length;i++){this.ctx.lineTo(this.points[i].x,this.points[i].y);}this.ctx.stroke();this.ctx.fillStyle='#00aeff';this.points.forEach(p=>{this.ctx.beginPath();this.ctx.arc(p.x,p.y,4,0,2*Math.PI);this.ctx.fill();});}generateLUT(){this.lut=new Uint8ClampedArray(256);for(let i=0;i<256;i++){let p1_idx=0;while(p1_idx<this.points.length-2&&this.points[p1_idx+1].x<i){p1_idx++;}const p1=this.points[p1_idx];const p2=this.points[p1_idx+1];const t=(p1.x===p2.x)?0:(i-p1.x)/(p2.x-p1.x);const y=255-(p1.y+t*(p2.y-p1.y));this.lut[i]=Math.max(0,Math.min(255,y));}}onMouseDown(e){const x=e.offsetX;const y=e.offsetY;let f=null;for(const p of this.points){if(Math.hypot(p.x-x,p.y-y)<8){f=p;break;}}if(f&&e.ctrlKey&&this.points.length>2&&(f.x!==0&&f.x!==255)){this.points=this.points.filter(p=>p!==f);this.draggingPoint=null;this.draw();this.generateLUT();this.onChange(true);}else if(f){this.draggingPoint=f;}else{const nP={x,y};this.points.push(nP);this.points.sort((a,b)=>a.x-b.x);this.draggingPoint=nP;}this.draw();}onMouseMove(e){if(!this.draggingPoint)return;if(this.draggingPoint.x!==0&&this.draggingPoint.x!==255){this.draggingPoint.x=Math.max(1,Math.min(254,e.offsetX));}this.draggingPoint.y=Math.max(0,Math.min(255,e.offsetY));this.points.sort((a,b)=>a.x-b.x);this.draw();this.onChange(false);}onMouseUp(){if(this.draggingPoint){this.draggingPoint=null;this.generateLUT();this.onChange(true);}}}
});
