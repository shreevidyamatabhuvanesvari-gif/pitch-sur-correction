const $=s=>document.querySelector(s),video=$('#video'),file=$('#file'),stage=$('#stage'),empty=$('#empty'),status=$('#status'),dot=$('#dot'),fileName=$('#fileName');
let objectUrl='',ctx=null,source=null,processor=null,ready=false,mode='medium';
const strengths={light:.32,medium:.68,strong:1};
function say(msg,ok=false){status.textContent=msg;dot.classList.toggle('ok',ok)}
function setMode(next){mode=next;document.querySelectorAll('.mode').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));if(processor)processor.port.postMessage({type:'strength',value:strengths[mode]});if(video.paused)say(`Correction: ${mode}`);}
async function setupAudio(){
 if(ready)return;
 if(!window.AudioContext&&!window.webkitAudioContext)throw Error('Web Audio is not available in this browser.');
 if(!video.src)throw Error('Select a video first.');
 const AC=window.AudioContext||window.webkitAudioContext;ctx=new AC();
 if(!ctx.audioWorklet)throw Error('Pitch correction is not available in this browser.');
 await ctx.audioWorklet.addModule('pitch-processor.js');
 source=ctx.createMediaElementSource(video);processor=new AudioWorkletNode(ctx,'pitch-corrector',{numberOfInputs:1,numberOfOutputs:1,channelCount:2,channelCountMode:'max'});
 source.connect(processor).connect(ctx.destination);processor.port.postMessage({type:'strength',value:strengths[mode]});ready=true;
}
async function play(){
 if(!video.src){say('Please select a video first.');return}
 try{await setupAudio();if(ctx.state==='suspended')await ctx.resume();if(video.ended)video.currentTime=0;await video.play();say(`Pitch correction active — ${mode[0].toUpperCase()+mode.slice(1)}`,true)}catch(err){say(err.message||'Processing error')}
}
function stop(){if(!video.src)return;video.pause();video.currentTime=0;if(processor)processor.port.postMessage({type:'reset'});say('Stopped — ready to play')}
$('#choose').addEventListener('click',()=>file.click());
file.addEventListener('change',()=>{const f=file.files[0];if(!f)return;if(!f.type.startsWith('video/')){file.value='';say('Please choose a video file.');return}if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(f);video.src=objectUrl;video.load();fileName.textContent=f.name;empty.style.display='grid';if(processor)processor.port.postMessage({type:'reset'});say('Video loaded — press Play');});
video.addEventListener('loadedmetadata',()=>{empty.style.display='none';say(`Video ready • ${format(video.duration)}`)});
video.addEventListener('error',()=>{empty.style.display='grid';say('This video could not be played.');});
video.addEventListener('ended',()=>say('Video ended — press Play to replay'));
video.addEventListener('play',()=>{if(!ready)setupAudio().then(()=>{if(ctx.state==='suspended')return ctx.resume()}).catch(err=>say(err.message||'Processing error'))});
video.addEventListener('pause',()=>{if(!video.ended&&video.currentTime>0)say('Paused')});
document.querySelectorAll('.mode').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
$('#play').addEventListener('click',play);$('#stop').addEventListener('click',stop);
$('#full').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await stage.requestFullscreen()}catch{say('Full Screen is not available in this browser.')}});
function format(s){if(!Number.isFinite(s))return '--:--';s=Math.max(0,Math.floor(s));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`}
window.addEventListener('beforeunload',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);if(ctx)ctx.close()});
