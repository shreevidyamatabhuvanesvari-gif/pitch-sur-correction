class PitchCorrector extends AudioWorkletProcessor{
 constructor(){
  super();this.sr=sampleRate;this.strength=.68;this.minHz=70;this.maxHz=1000;
  this.win=1024;this.half=512;this.an=new Float32Array(this.win);this.ac=new Float32Array(this.half+1);
  this.fill=0;this.dec=0;this.f0=0;this.ratio=1;this.phaseA=0;this.phaseB=.5;
  this.delay=Math.max(64,Math.floor(this.sr*.025));this.size=this.delay+4;
  this.l=new Float32Array(this.size);this.r=new Float32Array(this.size);this.w=0;
  this.port.onmessage=e=>{
   if(e.data.type==='strength')this.strength=Math.max(0,Math.min(1,e.data.value));
   if(e.data.type==='reset')this.reset();
  };
 }
 reset(){
  this.fill=0;this.dec=0;this.f0=0;this.ratio=1;this.phaseA=0;this.phaseB=.5;
  this.l.fill(0);this.r.fill(0);this.w=0;
 }
 detect(){
  const x=this.an,n=x.length;
  let mean=0,rms=0;
  for(let i=0;i<n;i++)mean+=x[i];
  mean/=n;
  for(let i=0;i<n;i++){x[i]-=mean;rms+=x[i]*x[i]}
  if(Math.sqrt(rms/n)<.008)return 0;
  const lo=Math.max(2,Math.floor(this.sr/this.maxHz));
  const hi=Math.min(this.half,Math.floor(this.sr/this.minHz));
  let best=0,bestLag=0;
  for(let lag=lo;lag<=hi;lag++){
   let s=0,e1=0,e2=0;
   for(let i=0;i<n-lag;i++){
    const a=x[i],b=x[i+lag];s+=a*b;e1+=a*a;e2+=b*b;
   }
   const q=s/Math.sqrt((e1*e2)||1);this.ac[lag]=q;
   if(q>best){best=q;bestLag=lag}
  }
  if(best<.34)return 0;
  let lag=bestLag;
  for(let k=lo+1;k<hi;k++){
   if(this.ac[k]>this.ac[k-1]&&this.ac[k]>=this.ac[k+1]&&this.ac[k]>.68*best){lag=k;break}
  }
  return lag?this.sr/lag:0;
 }
 analyze(){
  const f=this.detect();
  if(!f){this.ratio+= (1-this.ratio)*.05;return}
  this.f0=this.f0?this.f0*.75+f*.25:f;
  const midi=69+12*Math.log2(this.f0/440);
  const target=440*Math.pow(2,(Math.round(midi)-69)/12);
  const wanted=target/this.f0;
  this.ratio+= (Math.pow(wanted,this.strength)-this.ratio)*.18;
 }
 read(b,p){
  p%=this.size;if(p<0)p+=this.size;
  const i=p|0,f=p-i;
  return b[i]+(b[(i+1)%this.size]-b[i])*f;
 }
 process(inputs,outputs){
  const input=inputs[0],out=outputs[0];
  if(!input.length){out.forEach(c=>c.fill(0));return true}
  const L=input[0],R=input[1]||L;
  for(let i=0;i<L.length;i++){
   const l=L[i]||0,r=R[i]||l;
   this.l[this.w]=l;this.r[this.w]=r;
   if(++this.dec===2){
    this.dec=0;this.an[this.fill++]=(l+r)*.5;
    if(this.fill===this.win){
     this.analyze();
     this.an.copyWithin(0,this.half);
     this.fill=this.half;
    }
   }
   const amount=Math.max(.0001,Math.abs(this.ratio-1));
   const step=Math.min(.02,amount/Math.max(32,this.delay));
   const up=this.ratio>=1;
   const da=up?this.delay*(1-this.phaseA):this.delay*this.phaseA;
   const db=up?this.delay*(1-this.phaseB):this.delay*this.phaseB;
   const aL=this.read(this.l,this.w-da),aR=this.read(this.r,this.w-da);
   const bL=this.read(this.l,this.w-db),bR=this.read(this.r,this.w-db);
   const wa=.5-.5*Math.cos(2*Math.PI*this.phaseA);
   const wb=.5-.5*Math.cos(2*Math.PI*this.phaseB);
   out[0][i]=aL*wa+bL*wb;
   if(out[1])out[1][i]=aR*wa+bR*wb;
   this.w=(this.w+1)%this.size;
   this.phaseA+=step;this.phaseB+=step;
   if(this.phaseA>=1)this.phaseA-=1;
   if(this.phaseB>=1)this.phaseB-=1;
  }
  return true;
 }
}
registerProcessor('pitch-corrector',PitchCorrector);
