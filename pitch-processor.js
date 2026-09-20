class PitchCorrector extends AudioWorkletProcessor{
 constructor(){super();this.sr=sampleRate;this.mode=.68;this.minHz=70;this.maxHz=1000;this.ab=new Float32Array(1024);this.corr=new Float32Array(512);this.fill=0;this.dec=0;this.f0=0;this.target=1;this.ratio=1;this.bufLen=Math.ceil(this.sr*.05);this.bufL=new Float32Array(this.bufLen);this.bufR=new Float32Array(this.bufLen);this.wp=0;this.p1=0;this.p2=.5;this.port.onmessage=e=>{if(e.data.type==='strength')this.mode=Math.max(0,Math.min(1,e.data.value));if(e.data.type==='reset')this.reset()}}
 reset(){this.fill=0;this.dec=0;this.f0=0;this.target=1;this.ratio=1;this.p1=0;this.p2=.5;this.bufL.fill(0);this.bufR.fill(0);this.wp=0}
 detect(){const b=this.ab,n=b.length,sr=this.sr/2;let mean=0,pow=0;for(let i=0;i<n;i++)mean+=b[i];mean/=n;for(let i=0;i<n;i++){const v=b[i]-mean;pow+=v*v;b[i]=v}if(Math.sqrt(pow/n)<.008)return 0;const lo=Math.max(2,Math.floor(sr/this.maxHz)),hi=Math.min(n-2,Math.floor(sr/this.minHz));let best=-1;for(let lag=lo;lag<=hi;lag++){let ac=0,e1=0,e2=0;for(let i=0;i<n-lag;i++){const a=b[i],c=b[i+lag];ac+=a*c;e1+=a*a;e2+=c*c}const q=ac/Math.sqrt((e1*e2)||1);this.corr[lag]=q;if(q>best)best=q}if(best<.34)return 0;let lag=0,gate=best*.68;for(let k=lo+1;k<hi;k++)if(this.corr[k]>gate&&this.corr[k]>=this.corr[k-1]&&this.corr[k]>=this.corr[k+1]){lag=k;break}if(!lag){for(let k=lo;k<=hi;k++)if(this.corr[k]>gate){lag=k;break}}return lag?sr/lag:0}
 analyze(){const f=this.detect();if(f){this.f0=this.f0?this.f0*.72+f*.28:f;const midi=69+12*Math.log2(this.f0/440),target=440*Math.pow(2,(Math.round(midi)-69)/12);this.target=Math.max(.75,Math.min(1.33,Math.pow(target/this.f0,this.mode)))}else this.target=1}
 read(buf,pos){pos%=this.bufLen;if(pos<0)pos+=this.bufLen;const i=pos|0,f=pos-i;return buf[i]+(buf[(i+1)%this.bufLen]-buf[i])*f}
 process(inputs,outputs){const input=inputs[0],out=outputs[0];if(!input.length){out.forEach(c=>c.fill(0));return true}const L=input[0],R=input[1]||L,delayMax=Math.max(1,Math.floor(this.sr*.015));for(let i=0;i<L.length;i++){
  const l=L[i]||0,r=R[i]||l;this.bufL[this.wp]=l;this.bufR[this.wp]=r;
  if(++this.dec===2){this.dec=0;this.ab[this.fill++]=(l+r)*.5;if(this.fill===this.ab.length){this.analyze();this.ab.copyWithin(0,this.ab.length/2);this.fill=this.ab.length/2}}
  this.ratio+=((this.target||1)-this.ratio)*.003;const up=this.ratio>=1,d1=up?delayMax*(1-this.p1):delayMax*this.p1,d2=up?delayMax*(1-this.p2):delayMax*this.p2;
  const aL=this.read(this.bufL,this.wp-d1),aR=this.read(this.bufR,this.wp-d1),bL=this.read(this.bufL,this.wp-d2),bR=this.read(this.bufR,this.wp-d2),w1=.5-.5*Math.cos(2*Math.PI*this.p1),w2=.5-.5*Math.cos(2*Math.PI*this.p2);out[0][i]=aL*w1+bL*w2;if(out[1])out[1][i]=aR*w1+bR*w2;
  const inc=Math.abs(1-this.ratio)/delayMax;this.wp=(this.wp+1)%this.bufLen;this.p1+=inc;this.p2+=inc;if(this.p1>=1)this.p1-=1;if(this.p2>=1)this.p2-=1}
 return true}
}
registerProcessor('pitch-corrector',PitchCorrector);
