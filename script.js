const $=s=>document.querySelector(s),video=$('#video'),file=$('#file'),stage=$('#stage'),empty=$('#empty'),status=$('#status'),dot=$('#dot'),fileName=$('#fileName');
let objectUrl='',ctx=null,source=null,node=null,ready=false,mode='medium';
const strength={light:.32,medium:.68,strong:1},label=()=>mode[0].toUpperCase()+mode.slice(1);
function say(msg,ok=false){status.textContent=msg;dot.classList.toggle('ok',ok)}
function setMode(next){mode=next;document.querySelectorAll('.mode').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));if(node)node.port.postMessage({type:'strength',value:strength[mode]});if(video.paused)say(`Correction: ${label()}`)}
async function setup(){
 if(ready)return;if(!video.src)throw Error('Select a video first.');const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw Error('Web Audio is not available in this browser.');
 if(!ctx)ctx=new AC;if(!ctx.audioWorklet)throw Error('Pitch correction is not available in this browser.');
 if(!node){await ctx.audioWorklet.addModule('pitch-processor.js');source=ctx.createMediaElementSource(video);node=new AudioWorkletNode(ctx,'pitch-corrector',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});source.connect(node).connect(ctx.destination)}
 node.port.postMessage({type:'strength',value:strength[mode]});ready=true;
}
async function play(){if(!video.src){say('Please select a video first.');return}try{await setup();if(ctx.state==='suspended')await ctx.resume();if(video.ended)video.currentTime=0;await video.play();say(`Pitch correction active — ${label()}`,true)}catch(e){say(e.message||'Processing error')}}
function stop(){if(!video.src)return;video.pause();video.currentTime=0;if(node)node.port.postMessage({type:'reset'});say('Stopped — ready to play')}
$('#choose').onclick=()=>file.click();file.onchange=()=>{const f=file.files[0];if(!f)return;if(!f.type.startsWith('video/')){file.value='';say('Please choose a video file.');return}if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(f);video.src=objectUrl;video.load();fileName.textContent=f.name;empty.style.display='grid';if(node)node.port.postMessage({type:'reset'});say('Video loaded — press Play')};
video.onloadedmetadata=()=>{empty.style.display='none';say(`Video ready • ${format(video.duration)}`)};video.onerror=()=>{empty.style.display='grid';say('This video could not be played.')};video.onended=()=>say('Video ended — press Play to replay');
video.onpause=()=>{if(!video.ended&&video.currentTime>0)say('Paused')};document.querySelectorAll('.mode').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));$('#play').onclick=play;$('#stop').onclick=stop;
$('#full').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await stage.requestFullscreen()}catch{say('Full Screen is not available in this browser.')}};
function format(s){if(!Number.isFinite(s))return'--:--';s=Math.floor(Math.max(0,s));return`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`}
addEventListener('beforeunload',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);if(ctx)ctx.close()});
