// Live map: FR24-style aircraft layer, trails, selection panel, real flown tracks. Data: adsb.lol (ODbL).
let SEL=null,TR={},CSR=null,TK=null,prof=null,lastFrame=0,lastAnim=0,REG_BY_HEX={},SRCH_GND=[],QHits=[],QIx=-1,QTm=null,MOT={};
const TRACK_LAYERS=["trails","tk","tkgc","sel-flown","sel-join","sel-gap","sel-rem"];
const HIST_LAB_MINZOOM=10.2;
// 365-day paths: royal blue / rose, not live amber (#ffc400) and not airline cyan/magenta.
const COL_DEP="#3D8BFF", COL_ARR="#FF4B6B", COL_SID="#8FB8FF", COL_STAR="#FF8A9E", COL_CAS="#070b14";
const HIST_DIR_LAYERS=["hist-cas","hist-rep","hist-cor","hist-lab","hist-raw"];
let HI=null,HIST=null,HIST_APT=null,AIPI=null,AIP=null,AIP_APT=null;
function ageS(){return L&&L.at?Math.min(90,(Date.now()-new Date(L.at))/1000):0}
function gndLikePos(onG,gs,alt,posAge){
  const LM=typeof LiveMotion!=="undefined"?LiveMotion:null;
  const stale=posAge==null?0:(+posAge||0);
  if(LM) return !LM.canExtrap(gs, 0, onG, alt, stale);
  if(onG) return true;
  if(!(gs>0.5)) return true;
  if(alt!=null && Number.isFinite(+alt) && +alt<1000) return true;
  if(stale>=1200) return true;
  return false;
}
function snapAtMs(){return L&&L.at?+new Date(L.at):Date.now()}
function motRow(lat,lon,gs,trk,onG,alt,posAge){return {lat,lon,gs,trk,onG,alt,age:posAge}}
function motShown(lat,lon,gs,trk,onG,alt,posAge,hex){
  const LM=typeof LiveMotion!=="undefined"?LiveMotion:null;
  const now=Date.now(), at=snapAtMs();
  if(!LM) return [lon, lat, trk];
  if(hex){
    const m=LM.upsert(MOT, hex, motRow(lat,lon,gs,trk,onG,alt,posAge), now, at);
    return LM.display(m, now);
  }
  const tmp=LM.upsert({}, "_", motRow(lat,lon,gs,trk,onG,alt,posAge), now, at);
  return LM.display(tmp, now);
}
function dispLonLat(lat,lon,gs,trk,onG,alt,posAge,hex){
  const d=motShown(lat,lon,gs,trk,onG,alt,posAge,hex);
  return [d[0], d[1]];
}
function unwrapLine(coords){
  if(!coords||coords.length<2)return coords||[];
  const o=[coords[0].slice()];
  for(let i=1;i<coords.length;i++){
    let lon=coords[i][0]; const prev=o[o.length-1][0];
    if(lon-prev>180)lon-=360; else if(lon-prev<-180)lon+=360;
    o.push([lon,coords[i][1]]);
  }
  return o;
}
function nmLL(a,b){return hv(a[1],a[0],b[1],b[0])}
function isGapPt(p0,p1){
  const nm=hv(p0[2],p0[1],p1[2],p1[1]), dt=Math.max(0,(p1[0]-p0[0])/1000);
  if(dt>8*60 && nm>30)return true;
  if(dt>1 && nm/(dt/3600)>700)return true;
  if(nm>80 && dt<30)return true;
  return false;
}
function gndLike(p){return p[6]===1 || ((p[3]||0)===0 && (p[4]||0)<40)}
function airLike(p){return p[6]!==1 && ((p[3]||0)>=400 || ((p[3]||0)>50 && (p[4]||0)>80))}
function utcClock(ms){const d=new Date(ms);if(isNaN(+d))return null;const i=d.toISOString();return `${i.slice(0,10)}<br>${i.slice(11,16)} UTC`}
function numOrNull(v){if(v==null||v==="")return null;const n=+v;return Number.isFinite(n)?n:null}
function meanOf(xs){const a=xs.filter(v=>v!=null&&Number.isFinite(v));if(!a.length)return null;return a.reduce((s,v)=>s+v,0)/a.length}
function utcHm(ms){const d=new Date(ms);return isNaN(+d)?"n/a":d.toISOString().slice(11,16)}
function utcStamp(ms){const d=new Date(ms);return isNaN(+d)?"time n/a":d.toISOString().slice(0,19).replace("T"," ")+" UTC"}
function signedFpm(v){return `${v>=0?"+":"−"}${Math.abs(Math.round(v))} ft/min`}
let PROF_PTS=[];
function nearestProf(t){
  if(t==null||!PROF_PTS.length)return null;
  let best=PROF_PTS[0], d=Math.abs(best.t-t);
  for(const p of PROF_PTS){const n=Math.abs(p.t-t); if(n<d){best=p;d=n}}
  return best;
}
function fmtProfPoint(pt){
  if(!pt) return {text:"", html:""};
  const fl=pt.fl==null?"FL n/a":`FL${String(Math.round(pt.fl)).padStart(3,"0")}`;
  const ft=pt.alt==null?"baro n/a":`baro ${fmt(Math.round(pt.alt))} ft`;
  const gs=pt.gs==null?"GS n/a":`${Math.round(pt.gs)} kt`;
  const vs=pt.vs==null?"VS n/a":signedFpm(pt.vs);
  const t=utcStamp(pt.t);
  const html=`<b>Point</b> ${esc(t)}<br>${esc(fl)} · ${esc(ft)}<br>${esc(gs)} · ${esc(vs)}<div class="mu">This sample, not the chart average. Baro altitude / 100 is not a certified flight level.</div>`;
  const text=`Point ${t}\n${fl} · ${ft}\n${gs} · ${vs}`;
  return {t,fl,ft,gs,vs,html,text};
}
function showProfPoint(pt){
  const box=$("profpt"); if(!box)return;
  if(!pt){box.hidden=true;box.innerHTML="";return}
  const f=fmtProfPoint(pt);
  box.hidden=false; box.innerHTML=f.html;
}
function bindProfChart(c){
  if(!c||c._profBound)return;
  c._profBound=true;
  const pick=ev=>{
    let pt=null;
    if(ev&&ev.data&&ev.data.value) pt=nearestProf(ev.data.value[0]);
    else if(ev&&ev.value!=null) pt=nearestProf(ev.value);
    else if(ev&&ev.axesInfo&&ev.axesInfo[0]) pt=nearestProf(ev.axesInfo[0].value);
    if(pt) showProfPoint(pt);
  };
  c.on("click",pick);
  c.on("updateAxisPointer",pick);
}
function drawProf(P){
  const el=$("prof"), note=$("spn");
  if(!el)return;
  PROF_PTS=[];
  const gsVals=[], vsVals=[];
  for(const p of P||[]){
    const alt=numOrNull(p[3]), gs=numOrNull(p[4]), vs=numOrNull(p[5]), t=numOrNull(p[0]);
    if(t==null||alt==null) continue;
    PROF_PTS.push({t, alt, fl:alt/100, gs, vs});
    if(gs!=null) gsVals.push(gs);
    if(vs!=null) vsVals.push(vs);
  }
  if(PROF_PTS.length<2){
    el.style.display="none";
    showProfPoint(null);
    if(note) note.textContent="Vertical profile unavailable: this server has not yet stored two barometric altitudes for this hex.";
    return;
  }
  el.style.display="";
  const avgGs=meanOf(gsVals), avgVs=meanOf(vsVals);
  const gsTxt=avgGs==null?"avg GS n/a":`avg ${Math.round(avgGs)} kt`;
  const vsTxt=avgVs==null?"avg VS n/a":`avg ${signedFpm(avgVs)}`;
  const t0=PROF_PTS[0].t, t1=PROF_PTS[PROF_PTS.length-1].t;
  const last=PROF_PTS[PROF_PTS.length-1];
  const flData=PROF_PTS.map(p=>({value:[p.t,p.fl],gs:p.gs,vs:p.vs,alt:p.alt}));
  const c=ch("prof",{
    grid:{left:44,right:10,top:30,bottom:24},
    legend:{show:false},
    tooltip:{
      trigger:"axis",
      triggerOn:"mousemove|click",
      confine:true,
      hideDelay:1800,
      formatter:ps=>{
        const raw=ps&&ps[0]; if(!raw)return "";
        const t=raw.value&&raw.value[0];
        const pt=nearestProf(t); if(!pt)return "";
        const f=fmtProfPoint(pt);
        return `${f.t}<br>${f.fl} · ${f.ft}<br>${f.gs}<br>${f.vs}<br><span style="opacity:.8">This sample, not the average. Not a certified flight level.</span>`;
      }
    },
    axisPointer:{type:"line",snap:true},
    xAxis:ax({type:"time",axisLabel:{fontSize:9,hideOverlap:true,formatter:v=>{const d=new Date(v);return isNaN(+d)?"":d.toISOString().slice(11,16)}}}),
    yAxis:ax({type:"value",name:"FL (baro)",nameLocation:"middle",nameGap:30,min:0,nameTextStyle:{color:"#8aa0bf",fontSize:10},axisLabel:{fontSize:9,formatter:v=>Math.round(v)}}),
    series:[{name:"FL (baro)",type:"line",showSymbol:false,symbol:"circle",symbolSize:8,connectNulls:false,smooth:0.15,areaStyle:{opacity:.18},color:"#ffe14d",data:flData,markPoint:{symbol:"circle",symbolSize:8,label:{show:false},data:[{coord:[last.t,last.fl]}]}}],
    graphic:[{type:"text",right:8,top:4,z:100,silent:true,style:{text:gsTxt+"\n"+vsTxt,fill:"#cfe3ff",font:"11px Inter,system-ui,sans-serif",textAlign:"right",lineHeight:15}}]
  });
  bindProfChart(c);
  showProfPoint(last);
  if(note) note.textContent=`Barometric altitude as FL (hundreds of feet), not a certified flight level. Chart averages (${gsTxt}; ${vsTxt}) are means of sourced samples in this server’s displayed history (${PROF_PTS.length} pts, GS ${gsVals.length}/${P.length}, VS ${vsVals.length}/${P.length}, ${utcHm(t0)}–${utcHm(t1)} UTC; max ~3 h). Hover or tap a point for that sample’s FL, GS and VS; missing fields stay n/a and are not filled from the average or zero. Not a full flight history.`;
}
function posFresh(a){if(!a||a.held||a.gnd||a.src!=="live")return false; if(L&&L.at&&Date.now()-Date.parse(L.at)>180000)return false; return a.gs>120}
function observedEvents(P,a){
  const ev={takeoff:null,landing:null,since:P[0]?P[0][0]:null,takeoffLL:null};
  let lastG=null;
  for(const p of P){
    if(gndLike(p)) lastG=p;
    else if(airLike(p)&&lastG&&!ev.takeoff && (p[0]-lastG[0])<=20*60000){
      ev.takeoff=p[0];
      ev.takeoffLL=[lastG[2], lastG[1]];
    }
  }
  if(a&&(a.gnd||a.held)){
    for(let i=1;i<P.length;i++) if(airLike(P[i-1])&&gndLike(P[i])&&(P[i][0]-P[i-1][0])<=20*60000) ev.landing=P[i][0];
  }
  return ev;
}
function hideTracksOn(){return localStorage.hidet==="1"}
function migrateDirToggles(){
  if(localStorage.dep==null&&localStorage.arr==null){
    const on=localStorage.rwy!=="0";
    localStorage.dep=on?"1":"0";
    localStorage.arr=on?"1":"0";
  }
}
function depPathsOn(){migrateDirToggles();return localStorage.dep!=="0"}
function arrPathsOn(){migrateDirToggles();return localStorage.arr!=="0"}
function runwayPathsOn(){return depPathsOn()||arrPathsOn()}
function histDirFilter(){
  const d=depPathsOn(),a=arrPathsOn();
  if(d&&a) return null;
  if(d) return ["==",["get","dir"],"dep"];
  if(a) return ["==",["get","dir"],"arr"];
  return ["==",["get","dir"],"__none__"];
}
function aipKindFilter(){
  const d=depPathsOn(),a=arrPathsOn();
  if(d&&a) return null;
  if(d) return ["==",["get","kind"],"sid"];
  if(a) return ["==",["get","kind"],"star"];
  return ["==",["get","kind"],"__none__"];
}
function setLayerFilter(id,f){
  if(!map.getLayer(id)) return;
  map.setFilter(id,f);
}
function syncDirUi(){
  const d=depPathsOn(),a=arrPathsOn();
  localStorage.rwy=(d||a)?"1":"0";
  const de=$("depf"); if(de) de.checked=d;
  const ae=$("arrf"); if(ae) ae.checked=a;
  const db=$("depb"); if(db){db.classList.toggle("on",d);db.setAttribute("aria-pressed",d?"true":"false")}
  const ab=$("arrb"); if(ab){ab.classList.toggle("on",a);ab.setAttribute("aria-pressed",a?"true":"false")}
}
function afterDirToggle(){
  applyTrackVis();
}
function applyTrackVis(){
  if(!map)return;
  const hide=hideTracksOn(),vis=on=>on?"visible":"none";
  const dep=depPathsOn(),arr=arrPathsOn();
  for(const id of TRACK_LAYERS)if(map.getLayer(id))map.setLayoutProperty(id,"visibility",vis(!hide));
  if(map.getLayer("arcs"))map.setLayoutProperty("arcs","visibility",vis(!hide&&$("arcs")&&$("arcs").checked));
  const histOn=runwayPathsOn()&&HIST&&!HIST.error;
  const z=map.getZoom?map.getZoom():0;
  const hf=histDirFilter();
  for(const id of HIST_DIR_LAYERS){
    if(!map.getLayer(id)) continue;
    setLayerFilter(id,hf);
  }
  if(map.getLayer("hist-cas")) map.setLayoutProperty("hist-cas","visibility",vis(histOn));
  if(map.getLayer("hist-rep")) map.setLayoutProperty("hist-rep","visibility",vis(histOn));
  if(map.getLayer("hist-cor")) map.setLayoutProperty("hist-cor","visibility",vis(histOn&&z>=9.5));
  if(map.getLayer("hist-lab")) map.setLayoutProperty("hist-lab","visibility",vis(histOn&&z>=HIST_LAB_MINZOOM));
  if(map.getLayer("hist-raw")) map.setLayoutProperty("hist-raw","visibility",vis(histOn&&$("hraw")&&$("hraw").checked));
  const aipMaster=aipOn()&&AIP&&!AIP.error;
  const kf=aipKindFilter();
  if(map.getLayer("aip-sid-cas")) map.setLayoutProperty("aip-sid-cas","visibility",vis(aipMaster&&dep));
  if(map.getLayer("aip-sid")) map.setLayoutProperty("aip-sid","visibility",vis(aipMaster&&dep));
  if(map.getLayer("aip-star-cas")) map.setLayoutProperty("aip-star-cas","visibility",vis(aipMaster&&arr));
  if(map.getLayer("aip-star")) map.setLayoutProperty("aip-star","visibility",vis(aipMaster&&arr));
  if(map.getLayer("aip-near")){
    map.setLayoutProperty("aip-near","visibility",vis(aipMaster&&(dep||arr)));
    setLayerFilter("aip-near", kf);
  }
  if(map.getLayer("aip-lab")){
    map.setLayoutProperty("aip-lab","visibility",vis(aipMaster&&(dep||arr)&&z>=10.4));
    setLayerFilter("aip-lab", kf===null?null:["any",kf,["==",["get","kind"],"src"]]);
  }
}
function setDepPaths(on){
  migrateDirToggles();
  localStorage.dep=on?"1":"0";
  syncDirUi();
  afterDirToggle();
}
function setArrPaths(on){
  migrateDirToggles();
  localStorage.arr=on?"1":"0";
  syncDirUi();
  afterDirToggle();
}
function setRunwayPaths(on){
  migrateDirToggles();
  localStorage.dep=on?"1":"0";
  localStorage.arr=on?"1":"0";
  syncDirUi();
  afterDirToggle();
}
function setHideTracks(on){
  localStorage.hidet=on?"1":"0";
  const el=$("hidet");if(el)el.checked=!!on;
  const b=$("htb");if(b){b.classList.toggle("on",!!on);b.setAttribute("aria-pressed",on?"true":"false");const t=b.querySelector("[data-role=label]");if(t)t.textContent=on?"Show tracks":"Hide tracks";else b.textContent=on?"Show tracks":"Hide tracks"}
  applyTrackVis();
}
function regLabelsOn(){return localStorage.reglab!=="0"}
function applyRegLab(){
  if(!map)return;
  const vis=regLabelsOn()?"visible":"none";
  for(const id of ["live-reg","live-reg-sel","gnd-reg","gnd-reg-sel"]) if(map.getLayer(id))map.setLayoutProperty(id,"visibility",vis);
}
function setRegLabels(on){
  localStorage.reglab=on?"1":"0";
  const el=$("reglab");if(el)el.checked=!!on;
  const b=$("rlb");if(b){b.classList.toggle("on",!!on);b.setAttribute("aria-pressed",on?"true":"false");const t=b.querySelector("[data-role=label]");if(t)t.textContent=on?"Reg on":"Reg";else b.textContent=on?"Reg labels on":"Reg labels"}
  applyRegLab();
}
const AMB="#ffc400",GND="#8a94a6",ALTC=["interpolate",["linear"],["get","alt"],0,"#9aa4b2",1000,"#ff5a36",10000,"#ffb000",20000,"#c6ff3a",30000,"#00e5ff",40000,"#b06bff"];
const R2=Math.PI/180,hv=(a,b,c,d)=>{const x=Math.sin((c-a)*R2/2)**2+Math.cos(a*R2)*Math.cos(c*R2)*Math.sin((d-b)*R2/2)**2;return 2*3440.065*Math.asin(Math.sqrt(Math.min(1,x)))};
function plane(){const s=48,c=document.createElement("canvas");c.width=c.height=s;const x=c.getContext("2d");x.fillStyle="#fff";x.beginPath();
 const p=[[24,2],[27,8],[27,19],[45,29],[45,33],[27,27],[27,38],[33,43],[33,46],[24,43],[15,46],[15,43],[21,38],[21,27],[3,33],[3,29],[21,19],[21,8]];p.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();return x.getImageData(0,0,s,s)}
const WXMET_MINZOOM=9;
function airportMark(){
  const s=64,c=document.createElement("canvas");c.width=c.height=s;const x=c.getContext("2d");
  x.fillStyle="#fff";
  x.beginPath();x.arc(32,32,29,0,Math.PI*2);x.fill();
  x.save();x.globalCompositeOperation="destination-out";
  x.beginPath();x.arc(32,32,22,0,Math.PI*2);x.fill();
  x.restore();
  x.beginPath();
  const p=[[32,10],[35,16],[35,24],[50,33],[50,37],[35,32],[35,42],[41,47],[41,50],[32,47],[23,50],[23,47],[29,42],[29,32],[14,37],[14,33],[29,24],[29,16]];
  p.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();
  return x.getImageData(0,0,s,s);
}
function wxAvn(m){
  if(m&&m.avn&&m.avn.line) return m.avn;
  const pad=(n,w)=>String(Math.round(Math.abs(n))).padStart(w,"0");
  const raw=m&&m.raw||"";
  let timeZ="time n/a";
  const t=Date.parse(m&&m.obsTime);
  if(Number.isFinite(t)){const d=new Date(t);timeZ=pad(d.getUTCDate(),2)+pad(d.getUTCHours(),2)+pad(d.getUTCMinutes(),2)+"Z"}
  else {const z=String(raw).match(/\b(\d{6}Z)\b/); if(z) timeZ=z[1]}
  let wind=m&&m.windGroup||"";
  if(!wind){
    if(m&&m.windCalm) wind="00000KT";
    else if(m&&m.windVrb&&m.wspdKt!=null) wind="VRB"+pad(m.wspdKt,m.wspdKt>=100?3:2)+(m.wgstKt?"G"+pad(m.wgstKt,m.wgstKt>=100?3:2):"")+"KT";
    else if(m&&m.wdir!=null&&m.wspdKt!=null) wind=pad(m.wdir,3)+pad(m.wspdKt,m.wspdKt>=100?3:2)+(m.wgstKt?"G"+pad(m.wgstKt,m.wgstKt>=100?3:2):"")+"KT";
    else {const w=String(raw).match(/\b((?:VRB|\d{3})\d{2,3}(?:G\d{2,3})?KT|00000KT)\b/); wind=w?w[1]:"wind n/a"}
  }
  const fmt=v=>{if(v==null||v==="")return null;const n=Number(v);if(!Number.isFinite(n))return null;const r=Math.round(n);return (r<0?"M":"")+pad(r,2)};
  let td=null, tt=fmt(m&&m.tempC), dd=fmt(m&&m.dewpC);
  if(!tt||!dd){const g=String(raw).match(/(?:^|\s)(M?\d{2})\/(M?\d{2})(?=\s|$)/); if(g){if(!tt)tt=g[1];if(!dd)dd=g[2]}}
  td=tt&&dd?tt+"/"+dd:tt&&!dd?tt+"/n/a":!tt&&dd?"n/a/"+dd:"temp n/a";
  let altim="Q n/a";
  const q=String(raw).match(/\bQ(\d{4})\b/), a=String(raw).match(/\bA(\d{4})\b/);
  if(q) altim="Q"+q[1]; else if(a) altim="A"+a[1];
  else if(m&&m.altim>800&&m.altim<1100) altim="Q"+pad(m.altim,4);
  else if(m&&m.altim>=26&&m.altim<=33) altim="A"+pad(m.altim*100,4);
  const icao=m&&m.icao||"";
  return {timeZ,wind,tempDew:td,altim,line:[icao,timeZ,wind,td,altim].join(" "),subset:true};
}
function airSel(){
  const mf=$("mf"); if(!mf) return [];
  return [...mf.selectedOptions].map(o=>o.value).filter(v=>v&&v!=="all");
}
function airOk(al){
  const sel=airSel();
  if(sel.includes("_none")) return false;
  if(!sel.length) return true;
  al=al||"";
  if(sel.includes(al)) return true;
  if(sel.includes("other")&&!["QTR","UAE"].includes(al)) return true;
  return false;
}
function applyAirSel(sel){
  const mf=$("mf"); if(!mf) return;
  const set=new Set((sel||[]).filter(v=>v&&v!=="all"));
  for(const v of set){
    if(![...mf.options].some(o=>o.value===v)){
      const o=document.createElement("option");
      o.value=v; o.textContent=v==="other"?"Other airlines":v;
      mf.appendChild(o);
    }
  }
  for(const o of mf.options) o.selected=set.has(o.value);
}
function extraAirCodes(){
  const mf=$("mf"); if(!mf) return [];
  return [...mf.options].map(o=>o.value).filter(v=>!["QTR","UAE","other","all","_none"].includes(v));
}
function syncMfOptions(){
  const mf=$("mf"); if(!mf||!L) return;
  const keep=airSel();
  const live=[...new Set(liveRows().map(a=>a[2]).filter(Boolean))];
  const extra=[...new Set([...live,...keep])].filter(x=>x!=="QTR"&&x!=="UAE"&&x!=="other"&&x!=="all"&&x!=="_none").sort();
  const wanted=["QTR","UAE","other",...extra];
  const cur=[...mf.options].map(o=>o.value);
  if(wanted.length===cur.length&&wanted.every((v,i)=>v===cur[i])) return;
  mf.innerHTML=wanted.map(v=>`<option value="${v}">${v==="other"?"Other airlines":v}</option>`).join("");
  applyAirSel(keep);
}
let LOCAL_AIR=[];
function liveRowOk(a){
  if(!a) return false;
  const ty=($("tyf")&&$("tyf").value||"").trim().toUpperCase();
  if(ty&&!(String(a[3]||"").toUpperCase().startsWith(ty))) return false;
  return true;
}
function airCountOf(code){
  const rows=liveRows().filter(liveRowOk);
  if(code==="other") return rows.filter(a=>!["QTR","UAE"].includes(a[2])).length;
  if(!code) return rows.length;
  return rows.filter(a=>a[2]===code).length;
}
function liveLoading(){
  const n=((L&&L.ac)||[]).length;
  if(n) return false;
  const f=L&&L.feed;
  if(f&&f.loading) return true;
  if(!L||!L.at) return true;
  return false;
}
function syncLiveLoad(){
  const el=$("liveload"); if(!el) return;
  const on=liveLoading();
  el.hidden=!on;
  if(on) el.textContent="Loading live data…";
}
function syncAirCounts(){
  const el=$("filn"); if(!el) return;
  if(!L||!L.ac){el.textContent=liveLoading()?"Loading live data…":"";syncLiveLoad();return}
  const ty=($("tyf")&&$("tyf").value||"").trim().toUpperCase();
  const sel=airSel();
  const lab=ty?" "+ty:"";
  let lines;
  if(sel.includes("_none")){
    lines=[`0 live in sample${lab}`];
  } else if(!sel.length){
    lines=[`${typeof fmt==="function"?fmt(airCountOf()):airCountOf()} live in sample${lab}`];
  } else {
    lines=sel.filter(code=>code!=="_none").map(code=>{
      const n=airCountOf(code);
      const name=code==="other"?"Other":code;
      return `${name} ${typeof fmt==="function"?fmt(n):n}`;
    });
  }
  if(!L.ac.length && liveLoading()) lines=["Loading live data…"];
  el.textContent=lines.join("\n");
  el.title="Currently loaded live ADS-B aircraft in this sample matching the active filters. Not fleet size. Held last-ground positions are not counted. Not limited to the map viewport.";
  syncLiveLoad();
}
function syncLiveCount(){
  const el=$("cnt"); if(!el||!L) return;
  const tot=L.ac.length, n=acF().length;
  if(!tot && liveLoading()) el.textContent="· Loading live data…";
  else el.textContent=n===tot?`· ${fmt(tot)} live airline aircraft`:`· ${fmt(n)} of ${fmt(tot)} live airline aircraft`;
  const note=typeof feedNote==="function"?feedNote(L.feed):"";
  el.title=note||"Aircraft in the current live sample. Not fleet size.";
  syncAirCounts();
}
function liveRows(){
  const seen=new Set(), out=[];
  for(const a of [].concat((L&&L.ac)||[], LOCAL_AIR||[])){
    if(!a||!a[0]||seen.has(a[0])) continue;
    seen.add(a[0]); out.push(a);
  }
  return out;
}
function viewPad(){
  if(!map||typeof map.getBounds!=="function") return null;
  const b=map.getBounds();
  const dlat=b.getNorth()-b.getSouth(), dlon=b.getEast()-b.getWest();
  if(!(dlon>0) || b.getEast()<b.getWest()) return null;
  return {s:b.getSouth()-dlat*0.22, n:b.getNorth()+dlat*0.22, w:b.getWest()-dlon*0.22, e:b.getEast()+dlon*0.22};
}
function inPad(lon,lat,p){
  if(!p) return true;
  return lat>=p.s && lat<=p.n && lon>=p.w && lon<=p.e;
}
function acF(opts){
  const ty=($("tyf")&&$("tyf").value||"").trim().toUpperCase();
  const rows=liveRows(), pad=(opts&&opts.view)?viewPad():null, cull=!!(opts&&opts.view&&pad&&rows.length>400);
  const out=[];
  for(const a of rows){
    if(!airOk(a[2])||(ty&&!(String(a[3]||"").toUpperCase().startsWith(ty)))) continue;
    const shown=motShown(a[4],a[5],a[7],a[8],a[10],a[6],a[11],a[0]);
    if(cull && a[0]!==SEL && !inPad(shown[0],shown[1],pad)) continue;
    const rg=(a[9]||"").trim(); if(a[0]&&rg)REG_BY_HEX[a[0]]=rg;
    const trk=shown[2]==null?a[8]:shown[2];
    out.push({type:"Feature",properties:{h:a[0],cs:a[1],a:a[2],t:a[3],alt:a[6],gs:a[7],trk:trk,g:a[10],hl:["QTR","UAE"].includes(a[2])?1:0,s:a[0]===SEL?1:0,...(rg?{reg:rg}:{})},geometry:{type:"Point",coordinates:[shown[0],shown[1]]}});
  }
  return out;
}
function paintLive(opts){
  if(!map||!map.getSource("live")||(!L&&!(LOCAL_AIR&&LOCAL_AIR.length)))return;
  const f=acF(opts);
  map.getSource("live").setData({type:"FeatureCollection",features:f});
  if(SEL) selDraw();
  if($("trl")&&$("trl").checked && !(opts&&opts.view&&map.getZoom&&map.getZoom()<5)){
    const tf=[];
    for(const x of f){
      const t=TR[x.properties.h];
      if(t&&t.length){
        const coords=t.slice(-12);
        const last=coords[coords.length-1], cur=x.geometry.coordinates;
        if(!last||last[0]!==cur[0]||last[1]!==cur[1]) coords.push(cur);
        if(coords.length>1) tf.push({type:"Feature",properties:{a:x.properties.a},geometry:{type:"LineString",coordinates:coords}});
      }
    }
    map.getSource("trails").setData({type:"FeatureCollection",features:tf});
  } else if(map.getSource("trails")) map.getSource("trails").setData({type:"FeatureCollection",features:[]});
}
function drawLive(){
  paintLive({view:false});
  applyTrackVis();applyRegLab();if(SEL)selUpdate();refreshQres();syncLiveCount();if(typeof syncFilChips==="function")syncFilChips();
}
function animGap(){
  if(typeof document!=="undefined" && document.hidden) return 1000;
  const z=map&&map.getZoom?map.getZoom():2;
  const phone=typeof isPhone==="function"?isPhone():innerWidth<=700;
  if(z<3) return phone?400:280;
  if(z<5.5) return phone?140:90;
  return phone?55:33;
}
function onPoll(){
  syncLiveLoad();
  if(!L&&!(LOCAL_AIR&&LOCAL_AIR.length))return;
  const now=Date.now(), at=snapAtMs(), seen=new Set();
  for(const a of liveRows()){
    seen.add(a[0]);
    if(typeof LiveMotion!=="undefined") LiveMotion.upsert(MOT, a[0], motRow(a[4],a[5],a[7],a[8],a[10],a[6],a[11]), now, at);
    const t=TR[a[0]]||(TR[a[0]]=[]),p=t[t.length-1];
    if(!p||p[0]!==a[5]||p[1]!==a[4]) t.push([a[5],a[4]]);
    if(t.length>14) t.shift();
    const rg=(a[9]||"").trim(); if(a[0]&&rg)REG_BY_HEX[a[0]]=rg;
  }
  if(typeof LiveMotion!=="undefined") LiveMotion.prune(MOT, seen);
  for(const h of Object.keys(TR)) if(!seen.has(h)) delete TR[h];
  covDraw();
  syncMfOptions();drawLive();
}
function initMap(){map=new maplibregl.Map({container:"map",style:"https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",center:[35,28],zoom:innerWidth<700?1.1:2,attributionControl:{compact:true}});
 map.addControl(new maplibregl.NavigationControl(),"bottom-right");
 map.on("load",async()=>{map.addImage("plane",plane(),{sdf:true});if(map.hasImage("airport"))map.removeImage("airport");map.addImage("airport",airportMark(),{sdf:true});
  const cf=H.map.filter(r=>H.ap[r[1]]&&H.ap[r[2]]).map(r=>({type:"Feature",properties:{a:r[0],n:r[3],inf:r[4]||0,low:(r[3]<5||(r[4]||0)/r[3]>.5)?1:0,r:r[1]+"-"+r[2]},geometry:{type:"LineString",coordinates:gc(H.ap[r[1]],H.ap[r[2]])}}));
  map.addSource("cov",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addLayer({id:"cov",type:"fill",source:"cov",paint:{"fill-color":"#3aa0ff","fill-opacity":.06}});map.addSource("covb",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addLayer({id:"covb",type:"line",source:"covb",layout:{"line-join":"round",visibility:localStorage.cvb==="0"?"none":"visible"},paint:{"line-color":"#5cc8ff","line-width":["interpolate",["linear"],["zoom"],1,.8,6,1.6],"line-opacity":.85}});
  wxSetup();
  map.addSource("arcs",{type:"geojson",data:{type:"FeatureCollection",features:cf}});
  map.addLayer({id:"arcs",type:"line",source:"arcs",layout:{visibility:"none"},paint:{"line-color":["match",["get","a"],"QTR",C1,C2],"line-width":["interpolate",["linear"],["get","n"],1,.3,1600,1.4],"line-opacity":["case",["==",["get","low"],1],.12,.35],"line-dasharray":[2,2]}});
  HI=await fetch("/api/hist/index").then(r=>r.json()).catch(()=>null);
  if(HI&&HI.airports&&AH&&AH.merge) AH.merge(HI.airports);
  if($("histinfo")&&HI) $("histinfo").textContent=`${HI.n_airports||0} observed QTR airports; geometry tiles ${HI.n_with_geom||0}; sampled UTC days ${(HI.geom_days||[]).join(", ")||"none"}; window ${HI.from||"?"}–${HI.to||"?"} UTC.`;
  AIPI=await fetch("/api/aip/index").then(r=>r.json()).catch(()=>null);
  if($("aipinfo")&&AIPI) $("aipinfo").textContent=`${AIPI.n_draw||0} DRAW (FAA CIFP ${AIPI.cycle||""}, AIRAC ${AIPI.airac||"?"}, ${AIPI.effective_utc||"?"}–${AIPI.until_utc||"?"} UTC); ${AIPI.n_link||0} LINK-only official AIP AD 2. Per-flight ident: CIFP names only.`;
  TK=await fetch("/api/tracks").then(r=>r.json()).catch(()=>({f:[]}));
  const ts=$("tks");ts.innerHTML=`<option value="">Off</option><option value="QTR">All QTR (${TK.day})</option><option value="UAE">All UAE (${TK.day})</option>`+TK.f.map((f,i)=>[f.a+" "+f.o+"-"+f.d,i]).sort().map(([l,i])=>`<option value="${i}">${l}</option>`).join("");
  map.addSource("tk",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addSource("tkgc",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  const tv=hideTracksOn()?"none":"visible";
  map.addLayer({id:"tkgc",type:"line",source:"tkgc",layout:{visibility:tv},paint:{"line-color":"#ffffff","line-opacity":.45,"line-width":1,"line-dasharray":[3,3]}});
  map.addLayer({id:"tk",type:"line",source:"tk",layout:{visibility:tv},paint:{"line-color":["match",["get","a"],"QTR",C1,C2],"line-width":1.1,"line-opacity":.6}});
  map.addSource("trails",{type:"geojson",lineMetrics:true,data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"trails",type:"line",source:"trails",layout:{visibility:tv},paint:{"line-width":1.6,"line-gradient":["interpolate",["linear"],["line-progress"],0,"rgba(255,196,0,0)",1,"rgba(255,196,0,.75)"]}});
  map.addSource("sel",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"sel-rem",type:"line",source:"sel",filter:["==",["get","k"],"rem"],layout:{visibility:tv},paint:{"line-color":"#ffffff","line-width":1.6,"line-dasharray":[2,2],"line-opacity":.8}});
  map.addLayer({id:"sel-gap",type:"line",source:"sel",filter:["==",["get","k"],"gap"],layout:{visibility:tv},paint:{"line-color":"#8aa0bf","line-width":1.5,"line-dasharray":[4,3],"line-opacity":.85}});
  map.addLayer({id:"sel-join",type:"line",source:"sel",filter:["==",["get","k"],"join"],layout:{visibility:tv},paint:{"line-color":"#ffe14d","line-width":2,"line-dasharray":[1,2],"line-opacity":.85}});
  map.addLayer({id:"sel-flown",type:"line",source:"sel",filter:["==",["get","k"],"flown"],layout:{visibility:tv},paint:{"line-color":"#ffe14d","line-width":3}});
  map.addLayer({id:"sel-ap",type:"symbol",source:"sel",filter:["==",["get","k"],"ap"],layout:{"icon-image":"airport","icon-size":["interpolate",["linear"],["zoom"],2,.42,8,.82],"icon-anchor":"center","icon-allow-overlap":true,"icon-ignore-placement":true},paint:{"icon-color":"#ffffff","icon-halo-color":"#05070d","icon-halo-width":1.6}});
  map.addLayer({id:"sel-apl",type:"symbol",source:"sel",filter:["==",["get","k"],"ap"],layout:{"text-field":["get","n"],"text-size":11,"text-offset":[0,1.45],"text-anchor":"top","text-font":["Open Sans Regular"],"text-optional":true,"text-padding":4},paint:{"text-color":"#fff","text-halo-color":"#05070d","text-halo-width":1.2}});
  map.on("click","sel-ap",e=>{const p=e.features[0].properties;const m=wxFindMetar(p.icao)||wxFindMetar(p.n);if(m)new maplibregl.Popup({maxWidth:"320px"}).setHTML(`<div style="color:#000;font:12px/1.4 sans-serif">${wxMetHtml(wxMetFeat(m))}</div>`).setLngLat(e.lngLat).addTo(map)});
  ["sel-ap"].forEach(l=>{map.on("mouseenter",l,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",l,()=>map.getCanvas().style.cursor="")});
  map.addSource("live",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"live",type:"symbol",source:"live",layout:{"icon-image":"plane","icon-size":["interpolate",["linear"],["zoom"],1,["case",["==",["get","hl"],1],.34,.26],3,["case",["==",["get","hl"],1],.42,.32],8,["case",["==",["get","hl"],1],.7,.55]],"icon-rotate":["get","trk"],"icon-rotation-alignment":"map","icon-pitch-alignment":"map","icon-anchor":"center","icon-allow-overlap":true,"icon-ignore-placement":true,"icon-padding":0,"icon-offset":[0,0],"symbol-sort-key":["get","hl"]},
   paint:{"icon-color":AMB,"icon-halo-color":"#000","icon-halo-width":["case",["==",["get","s"],1],0,.6]}});
  map.addLayer({id:"live-reg",type:"symbol",source:"live",minzoom:6.5,filter:["all",["has","reg"],["!=",["get","s"],1]],layout:{visibility:regLabelsOn()?"visible":"none","text-field":["get","reg"],"text-size":11,"text-offset":[0,1.35],"text-anchor":"top","text-font":["Open Sans Regular"],"text-optional":true,"text-padding":4,"text-allow-overlap":false,"text-ignore-placement":false,"symbol-sort-key":["get","hl"]},
   paint:{"text-color":"#e6f1ff","text-halo-color":"#05070d","text-halo-width":1.5,"text-halo-blur":.2}});
  map.addLayer({id:"live-reg-sel",type:"symbol",source:"live",minzoom:5.5,filter:["all",["has","reg"],["==",["get","s"],1]],layout:{visibility:regLabelsOn()?"visible":"none","text-field":["get","reg"],"text-size":13,"text-offset":[0,1.45],"text-anchor":"top","text-font":["Open Sans Regular"],"text-optional":true,"text-allow-overlap":true,"text-ignore-placement":true},
   paint:{"text-color":"#ffffff","text-halo-color":"#05070d","text-halo-width":1.8}});
  colorMode();
  map.on("click","live",e=>select(e.features[0].properties.h));
  map.on("click","arcs",e=>{const p=e.features[0].properties;new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<span style="color:#000">${p.a} ${p.r}: ${fmt(p.n)} flights${p.inf?` (${p.inf} with one end inferred)`:""}${p.low?" · low confidence":""}</span>`).addTo(map)});
  ["live","arcs"].forEach(l=>{map.on("mouseenter",l,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",l,()=>map.getCanvas().style.cursor="")});
  CSR=await fetch("/api/csroute").then(r=>r.json()).catch(()=>null);
  map.on("moveend",onAptMove);
  map.on("zoom",applyTrackVis);
  const tick=()=>{
    if(map&&map.loaded&&!map.loaded()){requestAnimationFrame(tick);return;}
    const now=Date.now();
    if(now-lastAnim>=animGap()){lastAnim=now;paintLive({view:true})}
    if(now-lastFrame>1000){lastFrame=now;if(SEL)selUpdate();refreshQres();syncLiveCount()}
    requestAnimationFrame(tick);
  };
  tick();
  map.on("move",()=>{if(Date.now()-lastAnim>80){lastAnim=Date.now();paintLive({view:true})}});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){lastAnim=0;paintLive({view:true})}});
  onPoll();covDraw();setApt(localStorage.apt||"G");applyTrackVis();applyRegLab();syncWx()})}
function colorMode(){if(!map.getLayer("live"))return;const m=$("cm").value;
 map.setPaintProperty("live","icon-color",["case",["==",["get","s"],1],"#ffffff",["==",["get","g"],1],GND,m==="alt"?ALTC:["match",["get","a"],"QTR",C1,"UAE",C2,AMB]]);
 $("lgc").innerHTML=m==="alt"?`<b>Altitude</b> <i style="background:#ff5a36"></i>&lt;10k <i style="background:#ffb000"></i>10–20k <i style="background:#c6ff3a"></i>20–30k <i style="background:#00e5ff"></i>30–40k <i style="background:#b06bff"></i>40k+ ft`:`<i style="background:${C1}"></i>QTR <i style="background:${C2}"></i>UAE <i style="background:${AMB}"></i>other airlines`}
function tkDraw(){const v=$("tks").value;let f=v===""?[]:(v==="QTR"||v==="UAE")?TK.f.filter(x=>x.a===v):[TK.f[+v]];
 map.getSource("tk").setData({type:"FeatureCollection",features:f.map(x=>({type:"Feature",properties:{a:x.a},geometry:{type:"MultiLineString",coordinates:x.seg}}))});
 const g=f.length===1&&H.ap[f[0].o]&&H.ap[f[0].d]?[{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:gc(H.ap[f[0].o],H.ap[f[0].d])}}]:[];map.getSource("tkgc").setData({type:"FeatureCollection",features:g});
 $("tki").textContent=f.length===1?`${f[0].cs} ${f[0].reg} ${f[0].t} · ${f[0].o}→${f[0].d}${f[0].inf?" (one end inferred)":""} · ${new Date(f[0].t0*1000).toISOString().slice(0,16).replace("T"," ")} UTC · gaps = no receiver coverage`:f.length?`${f.length} flights on ${TK.day}`:"";applyTrackVis()}
function odOf(cs){const r=CSR&&CSR.cs[cs];if(!r)return null;const[o,d]=r[0].split("-"),A=CSR.ap;return A[o]&&A[d]?{o,d,O:A[o],D:A[d],n:r[1],tot:r[2]}:null}
let SEL_T=[],DB=null,GND_AC=[],SEL_DRAW="";
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function tg(k,t){return `<span class="tg ${k}">${t}</span>`}
function cell(l,v,k){return `<div class="sc${k?" "+k:""}"><span>${l}</span><b>${v}</b></div>`}
function na(l){return cell(l,"Unavailable","na")}
function hm(h){h=Math.max(0,h||0);return Math.floor(h)+"h "+Math.round((h%1)*60)+"m"}
function gRow(h){return GND_AC.find(x=>x[0]===h)}
function isPhone(){return innerWidth<=700||(innerHeight<=540&&innerWidth<=980)}
function fillMore(parts){
  const el=$("spmore"); if(!el) return;
  if(!isPhone()||!parts||!parts.length){el.innerHTML="";return}
  el.innerHTML=`<details class="spmore"><summary>Details / sources</summary>${parts.map(t=>`<p class="mu">${t}</p>`).join("")}</details>`;
}
function moreAppend(parts){
  if(!isPhone()||!parts||!parts.length) return;
  const el=$("spmore"); if(!el) return;
  let d=el.querySelector("details");
  if(!d){fillMore(parts);d=el.querySelector("details");if(d)d.dataset.wx="1";return}
  if(d.dataset.wx==="1") return;
  d.dataset.wx="1";
  d.insertAdjacentHTML("beforeend", parts.map(t=>`<p class="mu">${t}</p>`).join(""));
}
function padMap(){if(!map||typeof map.loaded!=="function"||!map.loaded())return;const on=$("sp").classList.contains("on")&&!$("sp").classList.contains("min"),w=!isPhone();map.setPadding({top:w?0:52,left:0,bottom:on&&!w?Math.min(280,innerHeight*.42):(w?0:64),right:on&&w?376:0})}
function openSp(){const el=$("sp");const host=$("mw")||document.body;if(el.parentNode!==host)host.appendChild(el);el.classList.add("on");el.classList.remove("min");el.style.display="flex";el.dataset.hex=SEL||"";const m=$("map");if(m&&m.scrollIntoView)m.scrollIntoView({block:"nearest",inline:"nearest"});padMap();if(map&&map.resize)map.resize()}
function closeSp(){const el=$("sp");el.classList.remove("on","min");el.style.display="none";el.dataset.hex="";padMap();if(map&&map.resize)map.resize()}
function liveAcRow(h){return liveRows().find(x=>x[0]===h)}
function selAc(){const a=liveAcRow(SEL);if(a)return{hex:a[0],cs:a[1],al:a[2],typ:a[3],lat:a[4],lon:a[5],alt:a[6],gs:a[7],trk:a[8],reg:a[9],gnd:!!a[10],age:a[11],vs:a[12],held:false,st:a[10]?"ground":"airborne",src:"live"};
 const g=gRow(SEL);if(!g)return null;const held=g[11]==="held";
 return{hex:g[0],cs:g[1]||g[0],al:g[2],typ:g[3],lat:g[4],lon:g[5],alt:0,gs:g[7],trk:g[6],reg:(g[14]||REG_BY_HEX[g[0]]||"").trim(),gnd:true,age:held?(g[12]||0)*60:g[9],held,heldMin:g[12],heldUtc:g[13]||"",st:g[8]||"ground",src:"ground",apt:g[15]||""}}
function alName(code,dbName){return (L&&L.nm&&code&&L.nm[code])||dbName||""}
function apBox(ap,side){if(!ap)return `<div class="ode ${side}"><div class="iata">—</div><div class="city">Unavailable</div></div>`;
 const code=ap.iata||ap.icao||"—";return `<div class="ode ${side}"><div class="iata">${esc(code)}</div><div class="city">${esc(ap.city||"")}</div><div class="an">${esc(ap.name||(ap.iata||ap.icao?"":"Unavailable"))}</div></div>`}
function routeOpts(a){
  if(!a) return {pos:null};
  const shown=dispLonLat(a.lat,a.lon,a.gs,a.trk,a.gnd||a.held,a.gnd||a.held?0:a.alt,a.age,a.hex);
  const ev=observedEvents(SEL_T||[],a);
  return {pos:{lat:shown[1],lon:shown[0]}, gs:a.gs, trk:a.trk, gnd:!!a.gnd, held:!!a.held, pts:SEL_T||[], takeoffLL:ev.takeoffLL};
}
function routeEnds(cs,a){const db=DB&&DB.found?{o:{iata:DB.origin.iata||"",icao:DB.origin.icao||"",name:DB.origin.name||"",city:DB.origin.city||"",lat:DB.origin.lat,lon:DB.origin.lon},d:{iata:DB.destination.iata||"",icao:DB.destination.icao||"",name:DB.destination.name||"",city:DB.destination.city||"",lat:DB.destination.lat,lon:DB.destination.lon},oi:DB.origin.iata||DB.origin.icao,di:DB.destination.iata||DB.destination.icao}:null;
 const hi0=odOf(cs),hi=hi0?{o:{iata:hi0.o,icao:"",name:"",city:hi0.O[2]||"",lat:hi0.O[0],lon:hi0.O[1]},d:{iata:hi0.d,icao:"",name:"",city:hi0.D[2]||"",lat:hi0.D[0],lon:hi0.D[1]},oi:hi0.o,di:hi0.d,n:hi0.n,tot:hi0.tot}:null;
 const o=routeOpts(a);
 if(typeof pickRoute==="function") return pickRoute(db,hi,o.pos,o);
 const conflict=!!(db&&hi&&(db.oi!==hi.oi||db.di!==hi.di));
 return{db,hi,od:conflict?null:(db||hi),conflict,unverified:false,rejected:[],src:null}}
async function select(h){SEL=h;DB=null;SEL_T=[];openSp();gPaint();wxPanel();const ac0=selAc();const cs=ac0&&ac0.cs;
 if(cs)fetch("/api/route?cs="+encodeURIComponent(cs)).then(r=>r.json()).then(j=>{if(SEL===h){DB=j;selUpdate();wxPanel()}}).catch(()=>{if(SEL===h){DB={found:false};selUpdate();wxPanel()}});
 const r=await fetch("/api/track?hex="+h+"&t="+Date.now(),{cache:"no-store"}).then(r=>r.json()).catch(()=>({points:[]}));if(SEL!==h)return;SEL_T=r.points||[];selUpdate(true);wxPanel()}
function selGeom(a){
 const snap=[a.lon,a.lat], shown=dispLonLat(a.lat,a.lon,a.gs,a.trk,a.gnd||a.held,a.gnd||a.held?0:a.alt,a.age,a.hex), ends=routeEnds(a.cs,a), F=[];
 let P=SEL_T.length?SEL_T.slice():[];
 const last=P[P.length-1];
 if(!last||last[1]!==a.lon||last[2]!==a.lat) P.push([L&&L.at?Date.parse(L.at):Date.now(),a.lon,a.lat,a.alt,a.gs,a.vs==null?null:a.vs,a.gnd?1:0]);
 let seg=[];
 const flush=()=>{if(seg.length>=2)F.push({type:"Feature",properties:{k:"flown"},geometry:{type:"LineString",coordinates:unwrapLine(seg.map(p=>[p[1],p[2]]))}})};
 for(let i=0;i<P.length;i++){
  if(i&&isGapPt(P[i-1],P[i])){
   flush();
   F.push({type:"Feature",properties:{k:"gap"},geometry:{type:"LineString",coordinates:unwrapLine([[P[i-1][1],P[i-1][2]],[P[i][1],P[i][2]]])}});
   seg=[P[i]];
  } else seg.push(P[i]);
 }
 flush();
 if(nmLL(snap,shown)>0.03) F.push({type:"Feature",properties:{k:"join"},geometry:{type:"LineString",coordinates:unwrapLine([snap,shown])}});
 const {od,unverified,conflict}=ends;
 if(!unverified&&!conflict&&od&&typeof od.o.lat==="number"&&typeof od.d.lat==="number"){
  F.push({type:"Feature",properties:{k:"rem"},geometry:{type:"LineString",coordinates:gc([shown[1],shown[0]],[od.d.lat,od.d.lon])}});
  F.push({type:"Feature",properties:{k:"ap",n:od.oi,icao:od.o.icao||""},geometry:{type:"Point",coordinates:[od.o.lon,od.o.lat]}},{type:"Feature",properties:{k:"ap",n:od.di,icao:od.d.icao||""},geometry:{type:"Point",coordinates:[od.d.lon,od.d.lat]}});
 }
 return {snap,shown,ends,F,P};
}
function selDraw(){
 if(!SEL||!map||!map.getSource("sel")) return;
 const a=selAc(); if(!a) return;
 map.getSource("sel").setData({type:"FeatureCollection",features:selGeom(a).F});
}
function selUpdate(first){const a=selAc();if(!a){unsel();return}
 const {snap,shown,ends,F,P}=selGeom(a), {db,hi,od,conflict,unverified,rejected,src}=ends;
 let routeHtml="", rm=null, canEta=false, etaMs=null, fl=null, pc=null;
 const phone=isPhone();
 const noteP=t=>phone?"":`<p class="mu">${t}</p>`;
 let more=[];
 if(unverified){
  const rn=`${srcNote(db,hi,{unverified:true,rejected,src})} Remaining route, progress and ETA are not drawn from it.`;
  more.push(rn);
  routeHtml=`<div class="spsec"><h3>Route ${tg("na","Unverified")}</h3>
   <div class="od">${apBox(null,"from")}<div class="odarr">→</div>${apBox(null,"to")}</div>
   <div class="scg">${cell("Route","unverified/unavailable","na")}</div>${noteP(rn)}</div>`
 } else if(conflict){
  const rn=`${srcNote(db,hi,{conflict:true,rejected,src})} Remaining route is not drawn from a guessed pair. Not a marketed flight number.`;
  more.push(rn);
  routeHtml=`<div class="spsec"><h3>Route ${tg("na","Unavailable")}</h3>
   <div class="od">${apBox(null,"from")}<div class="odarr">→</div>${apBox(null,"to")}</div>${noteP(rn)}</div>`
 } else if(od&&typeof od.o.lat==="number"&&typeof od.d.lat==="number"){
  fl=hv(od.o.lat,od.o.lon,shown[1],shown[0]); rm=hv(shown[1],shown[0],od.d.lat,od.d.lon); pc=Math.max(0,Math.min(100,100*fl/(fl+rm||1)));
  canEta=posFresh(a)&&rm!=null; if(canEta) etaMs=Date.now()+rm/a.gs*3600e3;
  const rn=`${srcNote(db,hi,{src,rejected})} Remaining route and the selected marker share the same displayed position (dead-reckoned between refreshes, estimate). Distances are great-circle, not the flown path. Not a schedule.`;
  more.push(rn);
  routeHtml=`<div class="spsec"><h3>Route ${tg("est","Estimated")}</h3>
   <div class="od">${apBox(od.o,"from")}<div class="odarr">→</div>${apBox(od.d,"to")}</div>
   <div class="pg"><span>${esc(od.oi)}<small>origin</small></span><div class="bar"><div style="width:${pc}%"></div><b style="left:${pc}%">✈</b></div><span>${esc(od.di)}<small>destination</small></span></div>
   <div class="scg">${cell("Progress (GC est.)",Math.round(pc)+"%")}${cell("Flown (GC est.)",fmt(Math.round(fl))+" nm")}${cell("Remaining (GC est.)",fmt(Math.round(rm))+" nm")}${canEta?cell("Remaining time (est.)",hm(rm/a.gs)):na("Remaining time")}</div>${noteP(rn)}</div>`}
 else {
  const rn=DB?"Origin and destination unavailable: adsbdb has no route for this callsign and there is no route history for it (history covers QTR/UAE only). ADS-B does not broadcast origin/destination.":"Looking up route in adsbdb…";
  more.push(rn);
  routeHtml=`<div class="spsec"><h3>Route ${DB?tg("na","Unavailable"):tg("est","Looking up")}</h3>
  <div class="od">${apBox(null,"from")}<div class="odarr">→</div>${apBox(null,"to")}</div>${noteP(rn)}</div>`;
 }
 if(map.getSource("sel"))map.getSource("sel").setData({type:"FeatureCollection",features:F});applyTrackVis();gPaint();
 const fn=(typeof acceptMarketedFlight==="function")?acceptMarketedFlight({callsign:a.cs,lookup:DB&&DB.flight_number_lookup,route:{od,unverified,conflict,src}}):{found:false,note:"Flight-number resolver unavailable."};
 const ident=identLive(a,P);
 const sk=[a.hex,a.lat,a.lon,a.alt,a.gs,a.trk,a.vs,a.age,a.held,!!(DB&&DB.found),P.length,a.src,canEta&&etaMs?Math.round(etaMs/60000):"",od&&od.oi||"",od&&od.di||"",unverified?1:0,conflict?1:0,src||"",fn.found?fn.number:"",ident&&ident.label||"",AIP_APT||""].join("|");
 if(!first&&sk===SEL_DRAW&&$("sp").classList.contains("on"))return;SEL_DRAW=sk;
 const name=alName(a.al,DB&&DB.airline),fresh=a.held?`Held last ground position, ${a.heldMin>=60?(a.heldMin/60).toFixed(1)+" h":a.heldMin+" min"} ago (ADS-B off / dropped)`:a.gnd?`Observed · on ground · ${a.age} s ago`:`Observed · ${a.age} s ago`;
 $("spcs").textContent=a.cs||"—";$("spal").textContent=name?name+(a.al?" · "+a.al:""):(a.al||"Airline unavailable");
 $("spsum").textContent=`Callsign ${a.cs||"—"} · ${a.gnd||a.held?"ground":fmt(a.alt)+" ft"} · ${a.held?"held":a.gs+" kt"} · ${fresh}`;
 $("sp").dataset.hex=a.hex||"";
 const chips=[a.reg?`<div class="chip"><span>Registration</span>${esc(a.reg)}</div>`:"",a.typ?`<div class="chip"><span>Aircraft type</span>${esc(a.typ)}</div>`:"",a.hex?`<div class="chip"><span>Hex</span>${esc(String(a.hex).toUpperCase())}</div>`:""].filter(Boolean).join("");
 const alt=a.held||a.gnd?"On ground":fmt(a.alt)+" ft";
 const vs=a.held||a.src==="ground"?null:a.vs;
 const ev=observedEvents(P,a);
 const toffHtml=ev.takeoff?cell("Observed takeoff",utcClock(ev.takeoff)):ev.since?cell("Tracking since",utcClock(ev.since)):na("Observed takeoff");
 const etaHtml=canEta&&etaMs?cell("Estimated arrival",utcClock(etaMs)+(phone?"":`<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">Estimated from remaining distance ÷ current ground speed, not schedule</div>`)):na("Estimated arrival");
 const landHtml=ev.landing?cell("Observed landing",utcClock(ev.landing)):na("Actual arrival");
 const timeNote=(ev.takeoff
  ? "Observed takeoff is the first airborne sample after a ground sample in this server's track (not wheels-up, not a schedule or gate time). Upstream type-cycle refresh is about 90 s; the browser polls /api/live every 15 s."
  : (ev.since?"No ground-to-air transition in this server's track. Tracking since is when this server first stored a position for the hex, not departure.":"No timestamped track yet for this hex."))
  +(ev.landing?" Observed landing is the first ground sample after airborne in this track (not on-blocks or gate).":" Actual arrival stays unavailable until an air-to-ground transition is captured.");
 const idNote=fn.found
  ? `Callsign is the ADS-B transponder identity from adsb.lol (observed). Flight number ${esc(fn.number)} is the marketed/ticketed passenger number from ${esc(fn.source)}, consistent with the plausibility-checked ${esc((od&&od.oi)||"?")}–${esc((od&&od.di)||"?")} pair. Not derived by prefix conversion. Codeshares are not resolved.`
  : "Callsign is the ADS-B transponder identity from adsb.lol (observed). Flight number means the marketed/ticketed passenger number: none of the connected free sources provide a verified current one, so it stays unavailable. An airline prefix conversion (QTR→QR, UAE→EK) is not that number — QTR68M is not QR68, UAE81W is not EK81. adsbdb <code>callsign_iata</code> is the same radio callsign with an IATA prefix and is never shown as a flight number. Codeshares are not resolved.";
 const fnCatalog=typeof catalogNote==="function"?catalogNote(DB&&DB.flight_number_lookup):"";
 const fnNote=fn.found?fn.note:(fn.note||idNote)+(fnCatalog?" "+fnCatalog:"");
 const coast=!a.held && !gndLikePos(a.gnd||a.held,a.gs,a.gnd||a.held?0:a.alt,a.age) && a.gs>0.5;
 const posNote=a.held?"Last ground position kept after the aircraft dropped out of the ADS-B feed. Not a live update."
  :(coast?"Snapshot is the last adsb.lol position. Between refreshes the marker is dead-reckoned each frame from ground speed and track (estimate), then eased ~1.6 s onto a new fix. Heading is blended ADS-B track. Cap 15 min / 120 nm (covers stretched type-cycles). Times UTC."
  :"Snapshot is the last adsb.lol position. Marker stays on that snapshot (on-ground, below 1000 ft baro, missing speed/track, or lost ~20 min) — not dead-reckoned, not snapped to a runway. Heading is ADS-B track. Times UTC.");
 const tmNote="No airline schedule feed is connected, so scheduled times stay unavailable. Estimated arrival is remaining great-circle distance ÷ current ground speed, UTC, only when the route destination is known and the position is a fresh moving airborne snapshot — not a schedule or airport actual. Actual arrival is shown only after an observed air-to-ground transition in this track. "+timeNote;
 more.unshift(idNote,fnNote,posNote); more.push(tmNote,"Barometric altitude as FL (hundreds of feet) is not a certified flight level. Hover or tap a profile point for that sample’s FL, ground speed and vertical speed; missing fields stay n/a. Not a full flight history.","Live lat/lon are stored to 5 decimal degrees (~1.1 m). Markers are not snapped to runway or taxiway centreline. Satellite pavement can sit tens of metres off WGS84. Dead-reckoning between snapshots is airborne-only (baro at least 1000 ft, gs over 0.5 kt, speed and track present, not lost ~20 min), capped at 15 min or 120 nm, with a ~1.6 s ease onto each new fix. Packed pos_age includes type-group fetch lag.","Not for operational flight planning. NOAA/NWS Aviation Weather Center. Live positions © adsb.lol contributors (ODbL). Routes: adsbdb.com. Times UTC.");
 if(ident&&ident.note) more.push(ident.note);
 $("spb").innerHTML=`<div class="chips">${chips}</div>
  <p class="spcaveat">Not for operational flight planning</p>
  <div class="spsec"><h3>Identity</h3>
   <div class="scg">${cell("Callsign",esc(a.cs||"—"))}${fn.found?cell("Flight number",esc(fn.number)):na("Flight number")}</div>${noteP(idNote)}</div>
  <div class="spsec"><h3>Position ${a.held?tg("est","Held"):tg("obs","Observed")}</h3>
   <div class="scg">${cell("Altitude",alt)}${a.held?na("Ground speed"):cell("Ground speed",a.gs+" kt")}${cell("Heading / track",a.trk+"°")}${vs==null?na("Vertical rate"):cell("Vertical rate",(vs>0?"+":"")+fmt(vs)+" fpm")}${cell("Freshness",esc(fresh))}${cell("Snapshot",a.lat.toFixed(5)+" / "+a.lon.toFixed(5))}</div>${noteP(posNote)}</div>
  ${routeHtml}
  <div class="spsec"><h3>Times</h3>
   <div class="scg">${na("Scheduled departure")}${na("Scheduled arrival")}${toffHtml}${etaHtml}${landHtml}</div>${noteP(tmNote)}</div>
  ${sidStarPanelHtml(ident)}
  <div class="spsec"><h3>Observed track ${P.length>=2?tg("obs","Observed"):tg("na","Unavailable")}</h3></div>`;
 fillMore(more);
 drawProf(P);
 if(first)map.easeTo({center:shown,zoom:Math.max(map.getZoom(),4),padding:innerWidth>700?{right:376,top:0,left:0,bottom:0}:{top:0,left:0,right:0,bottom:120}})}
function unsel(){SEL=null;SEL_T=[];DB=null;SEL_DRAW="";closeSp();if(map&&map.getSource("sel"))map.getSource("sel").setData({type:"FeatureCollection",features:[]});gPaint();const w=$("spwx");if(w)w.innerHTML="";fillMore([])}
const IATA={QR:"QTR",EK:"UAE",EY:"ETD",BA:"BAW",AA:"AAL",DL:"DAL",UA:"UAL",LH:"DLH",AF:"AFR",KL:"KLM",VS:"VIR",SQ:"SIA",CX:"CPA",QF:"QFA",TK:"THY",SV:"SVA",MS:"MSR",AC:"ACA",NH:"ANA",JL:"JAL",KE:"KAL",CZ:"CSN",MU:"CES",CA:"CCA",NZ:"ANZ",AY:"FIN",SK:"SAS",LX:"SWR",OS:"AUA",IB:"IBE",AZ:"AZA",TP:"TAP",EI:"EIN",FR:"RYR",WN:"SWA",B6:"JBU",AS:"ASA",NK:"NKS",F9:"FFT",HA:"HAL",AM:"AMX",LA:"LAN",AV:"AVA",CM:"CMP",AR:"ARG",G3:"GLO",AD:"AZU",AI:"AIC",MH:"MAS",GA:"GIA",PR:"PAL",VA:"VOZ",AK:"AXM",JQ:"JST",SA:"SAA",ET:"ETH",KQ:"KQA",AT:"RAM",GF:"GFA",WY:"OMA",RJ:"RJA",ME:"MEA",KU:"KAC",PK:"PIA",UL:"ALK",TG:"THA",VN:"HVN",OZ:"AAR",BR:"EVA",CI:"CAL",HU:"CHH",LY:"ELY",DY:"NAX",W6:"WZZ",VY:"VLG",A3:"AEE",LO:"LOT",RO:"ROT",BT:"BTI",FI:"ICE",PC:"PGT",SU:"AFL",S7:"SBI",U6:"SVR",WS:"WJA",TS:"TSC",FJ:"FJI",HR:"CTN",OU:"CTN",OK:"CSA",SN:"BEL",U2:"EZY"};
function normQ(s){return String(s||"").toUpperCase().replace(/[\s\-]/g,"")}
function icaoAlias(q){const m=String(q).match(/^([A-Z]{2})([0-9A-Z]{1,6})$/);return m&&IATA[m[1]]?IATA[m[1]]+m[2]:null}
function searchPool(){
  const by=new Map();
  for(const x of liveRows()){const rg=(x[9]||"").trim();if(x[0]&&rg)REG_BY_HEX[x[0]]=rg;by.set(x[0],{hex:x[0],cs:x[1]||"",al:x[2]||"",typ:x[3]||"",lat:x[4],lon:x[5],reg:rg,gnd:!!x[10],held:false,src:"live",age:x[11],st:x[10]?"ground":"airborne"})}
  for(const g of [].concat(GND_AC||[],SRCH_GND||[])){if(!g||!g[0]||by.has(g[0]))continue;const held=g[11]==="held",rg=(g[14]||REG_BY_HEX[g[0]]||"").trim();by.set(g[0],{hex:g[0],cs:g[1]||"",al:g[2]||"",typ:g[3]||"",lat:g[4],lon:g[5],reg:rg,gnd:true,held,src:"ground",age:held?(g[12]||0)*60:g[9],st:g[8]||"ground",apt:g[15]||"",heldMin:g[12]})}
  return[...by.values()]
}
function findMatches(raw){
  const q=normQ(raw);if(q.length<2)return[];
  const alias=icaoAlias(q),out=[];
  for(const a of searchPool()){
    const cs=normQ(a.cs),reg=normQ(a.reg),hex=String(a.hex||"").toUpperCase();
    let how=null,rank=50,extra={};
    if(cs&&cs===q){how="callsign";rank=0}
    else if(alias&&cs===alias){how="alias";rank=1;extra={aliasIata:q.slice(0,2),aliasIcao:alias.slice(0,3)}}
    else if(reg&&reg===q){how="registration";rank=2}
    else if(hex===q){how="hex";rank=3}
    else if(reg&&q.length>=3&&reg.startsWith(q)){how="registration";rank=4}
    else if(cs&&q.length>=3&&cs.startsWith(q)){how="callsign";rank=5}
    else if(hex.startsWith(q)&&q.length>=4){how="hex";rank=6}
    if(how)out.push({...a,how,rank,...extra});
  }
  out.sort((a,b)=>a.rank-b.rank||(a.cs||"").localeCompare(b.cs||""));
  return out.slice(0,8)
}
function hideQres(){const el=$("qres");if(!el)return;el.hidden=true;el.innerHTML="";$("qs")&&$("qs").setAttribute("aria-expanded","false");QHits=[];QIx=-1}
function qStatus(a){if(a.held){const m=a.heldMin!=null?a.heldMin:Math.round((a.age||0)/60);return `Held · last seen ${m>=60?(m/60).toFixed(1)+" h":m+" min"} ago`} if(a.src==="live")return a.gnd?"Live · on ground":"Live · airborne"; return "Ground · "+(a.st||"on ground")}
function renderQres(){
  const box=$("qres");if(!box)return;
  const q=$("qs").value.trim();
  if(!q){hideQres();return}
  $("qs").setAttribute("aria-expanded","true");box.hidden=false;
  if(!QHits.length){box.innerHTML=`<div class="qempty">No match in the current live/held ADS-B sample. That does not mean the flight is not operating — it may be out of coverage, using a different callsign, or not in this feed. Marketed passenger flight numbers are not searched: this feed has callsigns and registrations, not ticketed flight numbers. This is not a full fleet or schedule search.</div>`;return}
  box.innerHTML=QHits.map((a,i)=>{const lab=a.how==="alias"?`Callsign alias (${esc(a.aliasIata)}↔${esc(a.aliasIcao)}) · not a ticketed flight number`:a.how==="registration"?"Registration":a.how==="hex"?"Hex":"Callsign";return `<button type="button" class="qhit${i===QIx?" on":""}" role="option" data-i="${i}"><b>${esc(a.cs||"Callsign unavailable")}</b><span>${esc(a.reg||"Reg unavailable")} · ${esc(a.typ||"Type unavailable")}</span><em>${esc(qStatus(a))} · ${lab}</em></button>`}).join("")+`<div class="qfoot">Matches ADS-B callsign or registration in the current sample. IATA prefix (QR/EK) is a callsign alias only, not a verified passenger flight number.</div>`;
  box.querySelectorAll(".qhit").forEach(b=>b.onclick=()=>pickSearch(+b.dataset.i));
}
function refreshQres(){const box=$("qres");if(!box||box.hidden||!$("qs").value.trim())return;QHits=findMatches($("qs").value);if(QIx>=QHits.length)QIx=QHits.length?0:-1;renderQres()}
function revealFor(a){
  const notes=[];
  if(!airOk(a.al)){
    const add=(!a.al||a.al==="QTR"||a.al==="UAE")?(a.al||""):"other";
    if(add){applyAirSel(airSel().concat(add));notes.push("Airline filter expanded so this aircraft is visible.")}
  }
  const ty=$("tyf").value.trim().toUpperCase();
  const hideTy=ty&&!(a.typ||"").toUpperCase().startsWith(ty);
  if(hideTy){$("tyf").value="";notes.push("Type filter cleared so this aircraft is visible.")}
  return notes;
}
function pickSearch(i){
  const a=QHits[i];if(!a)return;
  const notes=revealFor(a);
  hideQres();
  const go=()=>{drawLive();select(a.hex);if(notes.length&&$("qnote")){$("qnote").hidden=false;$("qnote").textContent=notes.join(" ")}else if($("qnote"))$("qnote").hidden=true};
  if(a.src==="live"&&APT!=="G"&&!aptNear(a.lat,a.lon,APT,50)){setApt("G");setTimeout(go,500)}
  else if(a.apt&&a.src==="ground"&&APT!==a.apt&&aptHub(a.apt)){setApt(a.apt);setTimeout(go,500)}
  else go();
}
function search(){
  const q=$("qs").value;if($("qclr"))$("qclr").hidden=!q.trim();
  if(!q.trim()){hideQres();$("qs").style.borderColor="";return}
  QHits=findMatches(q);QIx=QHits.length?0:-1;renderQres();
  if(!QHits.length)$("qs").style.borderColor="#ff4d4d";else $("qs").style.borderColor="";
}
function onQsKey(e){
  $("qs").style.borderColor="";
  if(e.key==="Escape"){if(!$("qres").hidden){e.preventDefault();hideQres()}else{$("qs").value="";hideQres();if($("qclr"))$("qclr").hidden=true}return}
  if(e.key==="ArrowDown"){e.preventDefault();if($("qres").hidden)search();if(QHits.length){QIx=Math.min(QHits.length-1,QIx+1);renderQres()}return}
  if(e.key==="ArrowUp"){e.preventDefault();if(QHits.length){QIx=Math.max(0,QIx-1);renderQres()}return}
  if(e.key==="Enter"){e.preventDefault();if($("qres").hidden||!QHits.length)search();if(QHits.length)pickSearch(QIx<0?0:QIx);return}
  clearTimeout(QTm);QTm=setTimeout(search,220);
}

function srcNote(db,hi,meta){const h=hi?`${hi.oi}→${hi.di} (${hi.n}/${hi.tot} past flights)`:null;
 const rej=(meta&&meta.rejected||[]).filter(r=>r&&r.pair).map(r=>`${r.pair} (${r.src})`).join("; ");
 const drop=rej?` Discarded as geographically implausible from the displayed position: ${rej}. No replacement pair is invented.`:"";
 if(meta&&meta.unverified) return `Route unverified/unavailable.${drop} Crowd-sourced callsign routes can be stale or reused; alphanumeric callsigns are not a marketed flight number.`;
 if(meta&&meta.conflict) return `Origin and destination stay unavailable because the two connected route sources disagree and both are geographically plausible.${drop} Not a marketed flight number.`;
 if(meta&&meta.src==="history") return (db?`adsbdb.com pair was not used.${drop} `:drop)+`Estimated from adsb.lol history ${h}. Not observed on this flight. Not a marketed flight number.`;
 if(meta&&meta.src==="adsbdb") return "Route from adsbdb.com for this ADS-B callsign"+(hi?" (history pair was not used after the geographic check).":" (no adsb.lol history to cross-check).")+" Geographically consistent with the displayed position. Crowd-sourced; may still be stale or a reused callsign. Not a marketed flight number."+drop;
 if(meta&&meta.src==="both") return `Route from adsbdb.com for this ADS-B callsign, matches adsb.lol history ${h}. Crowd-sourced; may be stale or a reused callsign. Not a marketed flight number.`;
 if(db&&hi)return (db.oi===hi.oi&&db.di===hi.di)?`Route from adsbdb.com for this ADS-B callsign, matches adsb.lol history ${h}. Crowd-sourced; may be stale or a reused callsign. Not a marketed flight number.`:`Route from adsbdb.com (${db.oi}→${db.di}); <b style="color:#ffb020">disagrees</b> with adsb.lol history ${h}. adsbdb routes are crowd-sourced and can be stale or reused. Not a marketed flight number.`;
 if(db)return "Route from adsbdb.com for this ADS-B callsign (no adsb.lol history to cross-check). Crowd-sourced; may be stale or a reused callsign. Not a marketed flight number.";
 return DB?`adsbdb has no route for this callsign; estimated from adsb.lol history ${h}. Not observed on this flight.`:`Estimated from adsb.lol history ${h}; checking adsbdb…`}
let COVT=0;async function covDraw(){if(!map||!map.getSource("cov")||Date.now()-COVT<300000)return;COVT=Date.now();const j=await fetch("/api/coverage").then(r=>r.json()).catch(()=>null);if(!j)return;
 map.getSource("cov").setData({type:"FeatureCollection",features:j.cells.map(([a,o])=>({type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[o,a],[o+2,a],[o+2,a+2],[o,a+2],[o,a]]]}}))});map.getSource("covb").setData(covEdges(j.cells));$("covn").textContent=`${j.cells.length} 2° cells with receptions in the last ${j.window_h} h (accumulated since ${String(j.since_utc||"").slice(0,16).replace("T"," ")} UTC)`}
// Outline of the union of 2° cells: keep only cell edges with no covered neighbour, then merge collinear runs.
function covEdges(cells){const S=new Set(cells.map(c=>c[0]+","+c[1])),h=new Map(),v=new Map(),add=(m,k,x)=>{(m.get(k)||m.set(k,[]).get(k)).push(x)};
 for(const[a,o]of cells){if(!S.has((a+2)+","+o))add(h,a+2,o);if(!S.has((a-2)+","+o))add(h,a,o);if(!S.has(a+","+(o+2)))add(v,o+2,a);if(!S.has(a+","+(o-2)))add(v,o,a)}
 const L=[],run=(m,f)=>{for(const[k,xs]of m){xs.sort((p,q)=>p-q);let s=xs[0],e=s+2;for(const x of xs.slice(1)){if(x===e)e+=2;else{L.push(f(k,s,e));s=x;e=x+2}}L.push(f(k,s,e))}};
 run(h,(a,s,e)=>[[s,a],[e,a]]);run(v,(o,s,e)=>[[o,s],[o,e]]);return{type:"FeatureCollection",features:[{type:"Feature",properties:{},geometry:{type:"MultiLineString",coordinates:L}}]}}

// Airport local view: satellite + /api/ground (surface 8 nm, airborne 40 nm) at any catalog hub.
const AH=typeof AirportHubs!=="undefined"?AirportHubs:null;
function aptHub(id){return AH&&AH.resolveApt?AH.resolveApt(id):null}
function aptNear(lat,lon,id,maxNm){const h=aptHub(id);if(!h||typeof lat!=="number")return false;return (AH.hv||hv)(lat,lon,h.lat,h.lon)<=(maxNm||50)}
const APTC=(()=>{const o={}; if(AH&&AH.HUBS) for(const h of AH.HUBS) o[h.id]=[h.lon,h.lat]; return o})();
let APT="G",GT=null,APT_FLY=false;
function gIcon(){const c=document.createElement("canvas");c.width=c.height=32;const x=c.getContext("2d");x.fillStyle="#fff";x.strokeStyle="#000";x.lineWidth=2;x.beginPath();x.moveTo(16,2);x.lineTo(28,28);x.lineTo(16,22);x.lineTo(4,28);x.closePath();x.stroke();x.fill();return x.getImageData(0,0,32,32)}
function gSetup(){if(map.getSource("sat"))return;const b=map.getStyle().layers.find(l=>l.type==="symbol"||l.id==="cov");
 map.addSource("sat",{type:"raster",tiles:["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],tileSize:256,maxzoom:19,attribution:"Imagery © Esri, Maxar, Earthstar Geographics"});
 map.addLayer({id:"sat",type:"raster",source:"sat",minzoom:10,layout:{visibility:"none"},paint:{"raster-opacity":.75,"raster-brightness-max":.7,"raster-saturation":-.3}},b&&b.id);
 map.addImage("gac",gIcon(),{sdf:true});map.addSource("gnd",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
 map.addLayer({id:"gnd",type:"symbol",source:"gnd",layout:{"icon-image":"gac","icon-size":.6,"icon-rotate":["get","tr"],"icon-rotation-alignment":"map","icon-pitch-alignment":"map","icon-anchor":"center","icon-offset":[0,0],"icon-allow-overlap":true,"text-field":["get","cs"],"text-size":11,"text-offset":[0,1.3],"text-allow-overlap":false,"text-optional":true,"text-font":["Open Sans Regular"],visibility:"none"},paint:{"icon-color":["case",["==",["get","s"],1],"#ffffff",["match",["get","st"],"parked","#9aa6b8","taxi","#ffc400","#ff4d6d"]],"icon-opacity":["match",["get","mode"],"held",.4,1],"icon-halo-color":"#000","icon-halo-width":["case",["==",["get","s"],1],2.6,1],"text-color":["match",["get","mode"],"held","#9aa6b8","#fff"],"text-opacity":["match",["get","mode"],"held",.7,1],"text-halo-color":"#000","text-halo-width":1.2}});
 map.addLayer({id:"gnd-reg",type:"symbol",source:"gnd",minzoom:11,filter:["all",["has","reg"],["!=",["get","s"],1]],layout:{visibility:"none","text-field":["get","reg"],"text-size":11,"text-offset":[1.25,0],"text-anchor":"left","text-font":["Open Sans Regular"],"text-optional":true,"text-allow-overlap":false,"text-ignore-placement":false},paint:{"text-color":"#e6f1ff","text-halo-color":"#05070d","text-halo-width":1.5}});
  map.addLayer({id:"gnd-reg-sel",type:"symbol",source:"gnd",minzoom:11,filter:["all",["has","reg"],["==",["get","s"],1]],layout:{visibility:"none","text-field":["get","reg"],"text-size":12,"text-offset":[1.3,0],"text-anchor":"left","text-font":["Open Sans Regular"],"text-allow-overlap":true,"text-ignore-placement":true},paint:{"text-color":"#fff","text-halo-color":"#05070d","text-halo-width":1.8}});
  map.on("click","gnd",e=>{const h=e.features[0].properties.h;if(h)select(h)});
  map.on("mouseenter","gnd",()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave","gnd",()=>map.getCanvas().style.cursor="");
  if(!map.getSource("hist")){
    map.addSource("histcor",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    map.addLayer({id:"hist-cor",type:"fill",source:"histcor",layout:{visibility:"none"},paint:{"fill-color":["match",["get","dir"],"dep",COL_DEP,COL_ARR],"fill-opacity":0.16}});
    map.addSource("histraw",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    map.addLayer({id:"hist-raw",type:"line",source:"histraw",layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":["match",["get","dir"],"dep",COL_SID,COL_STAR],"line-width":1.05,"line-opacity":0.28}});
    map.addSource("hist",{type:"geojson",data:{type:"FeatureCollection",features:[]},tolerance:0});
    map.addLayer({id:"hist-cas",type:"line",source:"hist",layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":COL_CAS,"line-width":["interpolate",["linear"],["zoom"],3,["case",["==",["get","sec"],1],3.8,5.4],7,["case",["==",["get","sec"],1],4.0,5.6],12,["case",["==",["get","sec"],1],3.6,5.0]],"line-opacity":0.78}});
    map.addLayer({id:"hist-rep",type:"line",source:"hist",layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":["match",["get","dir"],"dep",COL_DEP,COL_ARR],"line-width":["interpolate",["linear"],["zoom"],3,["case",["==",["get","sec"],1],2.2,3.4],7,["case",["==",["get","sec"],1],2.4,3.6],12,["case",["==",["get","sec"],1],2.1,3.2]],"line-opacity":["case",["==",["get","sec"],1],0.82,0.98]}});
    map.addSource("histlab",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    map.addLayer({id:"hist-lab",type:"symbol",source:"histlab",minzoom:10.2,layout:{visibility:"none","text-field":["get","lab"],"text-size":11,"text-font":["Open Sans Regular"],"text-anchor":"left","text-offset":[0.5,0],"text-optional":true,"text-allow-overlap":true,"text-ignore-placement":true,"text-padding":2},paint:{"text-color":["match",["get","dir"],"dep","#d4e4ff","#ffd4dc"],"text-halo-color":"#05070d","text-halo-width":1.8}});
    const histClick=(e, raw)=>{
      if(!e.features||!e.features[0]) return;
      histIdentPopup(e.lngLat, e.features[0].properties, raw);
    };
    map.on("click","hist-cas",e=>histClick(e,false));
    map.on("click","hist-rep",e=>histClick(e,false));
    map.on("click","hist-raw",e=>histClick(e,true));
    ["hist-cas","hist-rep","hist-raw"].forEach(l=>{map.on("mouseenter",l,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",l,()=>map.getCanvas().style.cursor="")});
  }
  if($("hraw")&&!$("hraw").dataset.bound){$("hraw").dataset.bound="1";$("hraw").onchange=()=>histPaint()}
  if(!map.getSource("aip")){
    map.addSource("aip",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    map.addLayer({id:"aip-sid-cas",type:"line",source:"aip",filter:["==",["get","kind"],"sid"],layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":COL_CAS,"line-width":["interpolate",["linear"],["zoom"],2,1.8,8,2.4,12,2.8],"line-opacity":0.62,"line-dasharray":[2.2,1.6]}});
    map.addLayer({id:"aip-sid",type:"line",source:"aip",filter:["==",["get","kind"],"sid"],layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":COL_SID,"line-width":["interpolate",["linear"],["zoom"],2,0.8,8,1.2,12,1.5],"line-opacity":0.78,"line-dasharray":[2.2,1.6]}});
    map.addLayer({id:"aip-star-cas",type:"line",source:"aip",filter:["==",["get","kind"],"star"],layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":COL_CAS,"line-width":["interpolate",["linear"],["zoom"],2,1.8,8,2.4,12,2.8],"line-opacity":0.62,"line-dasharray":[2.2,1.6]}});
    map.addLayer({id:"aip-star",type:"line",source:"aip",filter:["==",["get","kind"],"star"],layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":COL_STAR,"line-width":["interpolate",["linear"],["zoom"],2,0.8,8,1.2,12,1.5],"line-opacity":0.78,"line-dasharray":[2.2,1.6]}});
    map.addSource("aipnear",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    map.addLayer({id:"aip-near",type:"line",source:"aipnear",layout:{visibility:"none","line-join":"round","line-cap":"round"},paint:{"line-color":["match",["get","kind"],"sid",COL_SID,COL_STAR],"line-width":["interpolate",["linear"],["zoom"],2,1.2,8,1.8,12,2.4],"line-opacity":0.92,"line-dasharray":[1.6,1.2]}});
    map.addSource("aiplab",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    map.addLayer({id:"aip-lab",type:"symbol",source:"aiplab",minzoom:10.4,layout:{visibility:"none","text-field":["get","lab"],"text-size":11,"text-font":["Open Sans Regular"],"text-anchor":"left","text-offset":[0.45,0],"text-optional":true,"text-allow-overlap":false,"text-padding":2},paint:{"text-color":["match",["get","kind"],"sid","#d4e4ff","star","#ffd4dc","#e6f1ff"],"text-halo-color":"#05070d","text-halo-width":1.8}});
  }
  if($("aipsid")&&!$("aipsid").dataset.bound){$("aipsid").dataset.bound="1";$("aipsid").onchange=()=>setAipOn($("aipsid").checked)}
  if($("aipall")&&!$("aipall").dataset.bound){$("aipall").dataset.bound="1";$("aipall").onchange=()=>{localStorage.aipall=$("aipall").checked?"1":"0";aipPaint()}}
  if($("aipname")&&!$("aipname").dataset.bound){$("aipname").dataset.bound="1";$("aipname").onchange=()=>{localStorage.aipname=$("aipname").checked?"1":"0";aipPaint();histPaint();if(SEL)selUpdate()}}
}
function setApt(a,opts){
  const fly=!opts||opts.fly!==false;
  const hub=a&&a!=="G"?aptHub(a):null;
  if(a&&a!=="G"&&!hub) return;
  const id=hub?hub.id:(a==="G"||!a?"G":a);
  APT=id;localStorage.apt=id;
  document.querySelectorAll("#aps button").forEach(b=>b.classList.toggle("on",b.dataset.a===id));
  if(!map)return;gSetup();const g=id!=="G";
  ["sat","gnd"].forEach(l=>{if(map.getLayer(l))map.setLayoutProperty(l,"visibility",g?"visible":"none")});
  if($("gp"))$("gp").style.display=g?"block":"none";
  if($("gpt")&&hub) $("gpt").textContent=`${hub.id} (${hub.icao||hub.id} ${hub.name||""})`;
  else if($("gpt")&&!g) $("gpt").textContent="";
  clearInterval(GT);
  if(!g){LOCAL_AIR=[];GND_AC=[];if(map.getSource("gnd"))map.getSource("gnd").setData({type:"FeatureCollection",features:[]});drawLive()}
  const afterFly=()=>{APT_FLY=false};
  if(g){
    if(fly){APT_FLY=true;map.flyTo({center:[hub.lon,hub.lat],zoom:innerWidth<700?12.6:13.4,speed:2});map.once("moveend",afterFly)}
    gLoad();GT=setInterval(gLoad,30000);histLoad(id);aipLoad(id)
  }else {
    // Keep the last loaded airport's paths when their toggles are on. Do not fetch every tile.
    if(!runwayPathsOn()) histLoad("G"); else histPaint();
    if(!aipOn()) aipLoad("G"); else aipPaint();
    if(fly){APT_FLY=true;map.flyTo({center:[35,28],zoom:innerWidth<700?1.1:2,speed:2});map.once("moveend",afterFly)}
  }
  applyTrackVis();applyRegLab()
}
async function histLoad(id){
  if(!id||id==="G"){HIST=null;HIST_APT=null;histPaint();return}
  if(HIST_APT===id&&HIST){histPaint();return}
  HIST_APT=id;
  const j=await fetch("/api/hist?apt="+encodeURIComponent(id)).then(r=>r.json()).catch(()=>null);
  if(HIST_APT!==id) return;
  HIST=j;
  histPaint();
}
function aipEsc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]))}
function aipNameOn(){return !!( $("aipname") && $("aipname").checked )}
function identNearApt(a, P, j){
  if(!j||j.lat==null||j.lon==null) return false;
  const hvnm=(typeof AipIdent!=="undefined"&&AipIdent.hv)?AipIdent.hv:hv;
  if(a&&hvnm(a.lat,a.lon,j.lat,j.lon)<=45) return true;
  for(const p of P||[]){
    if(!p) continue;
    const lat=p.length>=3?p[2]:p[1], lon=p.length>=3?p[1]:p[0];
    if(typeof lat==="number"&&hvnm(lat,lon,j.lat,j.lon)<=45) return true;
  }
  return false;
}
function identLive(a, P){
  const j=AIP;
  if(!j||j.error==="no_aip") return null;
  if(!identNearApt(a,P,j)) return null;
  if(j.ident_mode!=="cifp"||!(j.procs||[]).length){
    const terms=j.ident_terms||"No licence-safe SID/STAR coding table for this state. Procedure names are not assigned.";
    return {
      status:"unavailable",
      proc:null,
      label:"Not identified",
      hits:[],
      note: aipNameOn()
        ? ("Name-only SID/STAR ID (licence-restricted) is on. "+terms+" Names and fixes are never fabricated.")
        : "Procedure identification needs a licence-safe AIP coding table (FAA CIFP at US airports). Tick “Name-only SID/STAR ID (licence-restricted)” for the licensing assessment. Names are not invented."
    };
  }
  if(typeof AipIdent==="undefined") return null;
  const track=AipIdent.trackFromPoints(P);
  if(track.length<4) return Object.assign(AipIdent.nomatch(), {note:"Track too short to identify a SID/STAR. Estimated from the ADS-B track, not the ATC clearance. Not for navigation."});
  const ev=observedEvents(P,a);
  let kind=null;
  if(ev.takeoff&&!ev.landing) kind="dep";
  else if(ev.landing) kind="arr";
  else if(a&&a.vs>200) kind="dep";
  else if(a&&a.vs<-200) kind="arr";
  if(kind) return AipIdent.identify(track, j.procs, j.lat, j.lon, kind, null);
  const sid=AipIdent.identify(track, j.procs, j.lat, j.lon, "dep", null);
  const star=AipIdent.identify(track, j.procs, j.lat, j.lon, "arr", null);
  return ((sid&&sid.conf)||0)>=((star&&star.conf)||0)?sid:star;
}
function sidStarPanelHtml(ident){
  if(!ident) return "";
  const phone=typeof isPhone==="function"&&isPhone();
  const noteP=t=>phone?"":`<p class="mu">${t}</p>`;
  const hits=(ident.hits||[]).length?`<div class="mu">Matched published fixes: ${ident.hits.map(esc).join(" → ")}</div>`:"";
  const title=ident.status==="unavailable"?"SID/STAR":"SID/STAR (estimated)";
  const tag=ident.status==="match"?tg("est","Estimated"):ident.status==="unavailable"?tg("na","Not identified"):tg("na","No match / vectored");
  const line=esc(ident.label||"No match / vectored");
  const body=ident.status==="match"
    ? `<p>${line}</p><div class="scg">${cell("Likely "+esc(String(ident.kind||"").toUpperCase()), esc(ident.proc||"—")+(ident.trans?" ("+esc(ident.trans)+")":"")+" · "+Math.round(ident.conf)+"% match")}</div>`
    : `<p>${line}</p><div class="scg">${cell("SID/STAR", line)}</div>`;
  return `<div class="spsec" id="spidstar"><h3>${title} ${tag}</h3>${body}${hits}${noteP(esc(ident.note||"Estimated from the ADS-B track, not the ATC clearance. Not for navigation."))}</div>`;
}
function identRepRec(rwy, dir){
  const rows=((AIP&&AIP.ident&&AIP.ident.rep)||[]);
  return rows.find(r=>String(r.rwy||"")===String(rwy||"")&&r.dir===dir)||null;
}
function identRawRec(i){
  const rows=((AIP&&AIP.ident&&AIP.ident.raw)||[]);
  return rows[i]||null;
}
function identShareLines(rwy, dir){
  const block=((AIP&&AIP.ident&&AIP.ident.by_rwy)||[]).find(x=>String(x.id||"")===String(rwy||"")&&x.dir===dir);
  if(!block||!block.share) return [];
  return block.share.map(x=>{
    const pct=Math.round((x.share||0)*100);
    if(!x.proc) return `No match / vectored: ${x.n}/${block.n} (${pct}%)`;
    const kind=String(x.kind||"sid").toUpperCase();
    return `Likely ${kind} ${x.proc}${x.trans?" ("+x.trans+")":""}: ${x.n}/${block.n} (${pct}%) · mean ${Math.round(x.mean_conf||0)}% match · estimated from ADS-B, not ATC clearance`;
  });
}
function histIdentPopup(lngLat, props, raw){
  if(!map||!lngLat) return;
  const rec=raw?identRawRec(props.i):identRepRec(props.rwy, props.dir);
  const identLine=(props.ident||(rec&&rec.label)||"No match / vectored");
  const cifp=AIP&&AIP.ident_mode==="cifp";
  const foot=cifp
    ?"Estimated from the ADS-B track, not the ATC clearance. Kalman subsample, not every 365-day flight. FAA CIFP names only. Not for navigation."
    :"SID/STAR not identified: no licence-safe coding table for this state. Names are not invented. Not for navigation.";
  const html=`<b>${esc(props.lab||("RWY "+(props.rwy||"")+" "+(props.dir||"")))}</b><br>${esc(identLine)}<br><i>${esc(foot)}</i>`;
  const ll=Array.isArray(lngLat)?lngLat:(lngLat.lng!=null?[lngLat.lng,lngLat.lat]:lngLat);
  new maplibregl.Popup({maxWidth:"320px", closeOnClick:true}).setHTML(`<div style="color:#000;font:12px/1.4 sans-serif">${html}</div>`).setLngLat(ll).addTo(map);
}
function aipOn(){return localStorage.aipsid==="1"}
function setAipOn(on){
  localStorage.aipsid=on?"1":"0";
  ["aipsid","aipsidf"].forEach(id=>{const el=$(id);if(el)el.checked=!!on});
  const b=$("sidb");if(b){b.classList.toggle("on",!!on);b.setAttribute("aria-pressed",on?"true":"false");const t=b.querySelector("[data-role=label]");if(t)t.textContent=on?"SID/STAR":"SID off";else b.textContent=on?"SID/STAR":"SID off"}
  aipPaint();
}
function sidNoteText(j){
  if(!j||j.mode!=="link"||j.error) return "";
  const icao=(j.icao||"").toUpperCase();
  const apt=(j.apt||"").toUpperCase();
  if(icao==="OTHH"||apt==="DOH") return "Doha SID/STAR charts: official links only (licence)";
  const names={OMDB:"Dubai",OMAA:"Abu Dhabi",EGLL:"Heathrow",EGKK:"Gatwick",WSSS:"Singapore",VABB:"Mumbai",LIRF:"Rome",EDDF:"Frankfurt",RJAA:"Narita",OKBK:"Kuwait",OOMS:"Muscat",OBBI:"Bahrain",OEJN:"Jeddah",OERK:"Riyadh",LFPG:"Paris",EHAM:"Amsterdam"};
  const n=names[icao]||j.state||icao||apt;
  return n+" SID/STAR charts: official links only (licence)";
}
function syncSidNote(j){
  const t=sidNoteText(j);
  ["sidnote","sidnotef"].forEach(id=>{
    const el=$(id);
    if(!el) return;
    el.textContent=t;
    el.hidden=!t;
  });
}
async function aipLoad(id){
  if(!id||id==="G"){AIP=null;AIP_APT=null;aipPaint();histPaint();return}
  if(AIP_APT===id&&AIP){aipPaint();histPaint();return}
  AIP_APT=id;
  const j=await fetch("/api/aip?apt="+encodeURIComponent(id)).then(r=>r.json()).catch(()=>null);
  if(AIP_APT!==id) return;
  AIP=j;
  aipPaint();
  histPaint();
  if(SEL) selUpdate();
}
function aipPaint(){
  if(!map) return;
  const j=AIP;
  const draw=j&&j.mode==="draw"&&!j.error;
  const link=j&&j.mode==="link"&&!j.error;
  if($("aipsid")) $("aipsid").closest("label").style.display=draw?"":"none";
  if($("aipall")) $("aipall").closest("label").style.display=draw&&(j.match||[]).length?"":"none";
  if($("aipname")) $("aipname").closest("label").style.display=link?"":"none";
  const on=aipOn()&&draw;
  const matches=j&&j.match||[];
  const nearestOnly=on&&matches.length&&$("aipall")&&!$("aipall").checked;
  const wantAll=on&&!nearestOnly;
  const nearKeys=new Set(matches.map(m=>m.kind+"|"+m.proc+"|"+(m.trans||"")));
  const feats=[], near=[], labs=[];
  if(on&&j.procs){
    for(const p of j.procs){
      if(!p.path||p.path.length<2) continue;
      const key=p.kind+"|"+p.id+"|"+(p.trans||"");
      const isNear=nearKeys.has(key);
      if(wantAll) feats.push({type:"Feature",properties:{kind:p.kind,id:p.id,trans:p.trans||"",near:isNear?1:0},geometry:{type:"LineString",coordinates:p.path}});
      if(isNear){
        near.push({type:"Feature",properties:{kind:p.kind,id:p.id},geometry:{type:"LineString",coordinates:p.path}});
        const mid=p.path[Math.min(p.path.length-1, Math.floor(p.path.length/2))];
        labs.push({type:"Feature",properties:{kind:p.kind,lab:`${p.id}${p.trans?" "+p.trans:""} · ${p.kind.toUpperCase()} · ${j.cycle||"CIFP"} · Not for navigation`},geometry:{type:"Point",coordinates:mid}});
      }
    }
    if(j.lon!=null&&j.lat!=null){
      labs.push({type:"Feature",properties:{kind:"src",lab:`${j.cycle||"FAA CIFP"} AIRAC ${j.airac||""} · Not for navigation`},geometry:{type:"Point",coordinates:[j.lon,j.lat]}});
    }
  }
  if(map.getSource("aip")) map.getSource("aip").setData({type:"FeatureCollection",features:feats});
  if(map.getSource("aipnear")) map.getSource("aipnear").setData({type:"FeatureCollection",features:near});
  if(map.getSource("aiplab")) map.getSource("aiplab").setData({type:"FeatureCollection",features:labs});
  applyTrackVis();
  syncSidNote(j);
  const el=$("aipp");
  if(el){
    if(!j||j.error){el.textContent="";}
    else if(j.mode==="link"){
      const href=aipEsc(j.ad2_url||j.source_url||"");
      const lab=aipEsc(j.ad2_label||"official AIP AD 2");
      el.innerHTML=`Official charts: <a href="${href}" target="_blank" rel="noopener noreferrer">${lab}</a>. Not for navigation. Geometry is not redrawn (licence).`;
    }else{
      const href=aipEsc(j.ad2_url||j.source_url||"");
      const src=aipEsc(j.source||"FAA CIFP");
      const cycle=aipEsc(j.cycle||"");
      const airac=aipEsc(j.airac||"");
      const when=[j.effective_utc,j.until_utc].filter(Boolean).join(" to ");
      const matchHtml=(matches||[]).map(m=>`Observed RWY ${aipEsc(m.hist_rwy)} ${m.hist_dir==="dep"?"dep":"arr"} ≈ ${aipEsc(m.proc)}${m.trans?" ("+aipEsc(m.trans)+")":""} · mean ${m.mean_nm} nm · not a clearance`).join("<br>");
      const idn=j.ident||{};
      const identHtml=`<br>Per-flight ident (Kalman subsample, not every 365-day flight): ${idn.named||0}/${idn.flights||0} named from FAA CIFP. Estimated from the ADS-B track, not the ATC clearance. Below threshold: No match / vectored.`;
      el.innerHTML=`${src} · ${cycle} · AIRAC ${airac}${when?` (${when} UTC)`:""} · straight lines between published fixes · <b>Not for navigation</b>. Drawn ${j.n_sid||0} SID, ${j.n_star||0} STAR. Official: <a href="${href}" target="_blank" rel="noopener noreferrer">${aipEsc(j.ad2_label||"FAA d-TPP / airport diagram")}</a>. Tick “Published SID/STAR” to overlay.${matchHtml?"<br>Nearest published procedure (licence-safe, vs observed runway path):<br>"+matchHtml:"<br>No nearest-procedure match within the distance gate — observed paths are not labelled as a SID/STAR."}${identHtml}`;
    }
  }
}
function histPaint(){
  if(!map) return;
  const feats=[], cors=[], labs=[], raws=[];
  const j=HIST;
  if(j&&!j.error&&j.rwys){
    for(const r of j.rwys){
      const dir=r.dir==="dep"?"departures":"arrivals";
      for(let i=0;i<(r.clusters||[]).length;i++){
        const c=r.clusters[i];
        if(!c||!c.path||c.path.length<2) continue;
        const pct=Math.round((c.share||0)*100);
        const rec=identRepRec(r.id, r.dir);
        const identLab=rec&&rec.label?rec.label:"No match / vectored";
        const full=`RWY ${r.id} ${dir} · ${pct}% of ${r.n} flights · observed ADS-B, not published SID/STAR`;
        feats.push({type:"Feature",properties:{dir:r.dir,sec:i?1:0,lab:full,rwy:r.id,n:r.n,share:c.share||0,ident:identLab},geometry:{type:"LineString",coordinates:c.path}});
        const labPt=r.dir==="arr"?c.path[Math.max(0,c.path.length-4)]:c.path[Math.min(c.path.length-1,3)];
        if(labPt&&i===0){
          const hint=rec&&rec.status==="match"?` · likely ${rec.proc}`:"";
          labs.push({type:"Feature",properties:{dir:r.dir,lab:`RWY ${r.id} ${r.dir==="dep"?"dep":"arr"} · ${pct}% of ${r.n}${hint}`},geometry:{type:"Point",coordinates:labPt}});
        }
      }
    }
    if($("hraw")&&$("hraw").checked){
      (j.raw||[]).forEach((t,i)=>{
        if(t.seg&&t.seg.length){
          const rec=identRawRec(i);
          raws.push({type:"Feature",properties:{dir:t.dir,rwy:t.rwy||"",i,ident:rec&&rec.label||"No match / vectored",lab:`RWY ${t.rwy||"?"} ${t.dir||""} · Kalman clip`},geometry:{type:"MultiLineString",coordinates:t.seg}});
        }
      });
    }
  }
  if(map.getSource("hist")) map.getSource("hist").setData({type:"FeatureCollection",features:feats});
  if(map.getSource("histcor")) map.getSource("histcor").setData({type:"FeatureCollection",features:cors});
  if(map.getSource("histlab")) map.getSource("histlab").setData({type:"FeatureCollection",features:labs});
  if(map.getSource("histraw")) map.getSource("histraw").setData({type:"FeatureCollection",features:raws});
  const el=$("hpt");
  if(el){
    if(!j||j.error==="no_geometry"){
      el.textContent=`No terminal-area geometry in the sampled UTC days (${((HI&&HI.geom_days)||[]).join(", ")||"none"}). 365-day observed QTR city-pair count: ${j&&j.h2h_n!=null?j.h2h_n:"n/a"} flights (${j&&j.h2h_inf||0} one-end-inferred). adsb.lol had no assignable QTR/UAE traces here, or coverage was too thin. Observed ADS-B, not published SID/STAR.`;
    }else if(j&&j.rwys&&j.rwys.length){
      const days=(j.geom_days||[]).join(", ");
      const head=`${j.icao||j.apt} representative paths · ${j.n_assigned||0} assigned flights · geometry UTC days ${days} · window ${j.from}–${j.to} UTC · ground-roll unsmoothed · heading+offset per runway end · not published SID/STAR`;
      const cifp=AIP&&AIP.ident_mode==="cifp";
      const identFoot=cifp
        ?`<br>Per-flight SID/STAR shares use the stored Kalman subsample (${(AIP.ident&&AIP.ident.flights)||0} clips here), not every 365-day flight. FAA CIFP names only. Estimated from the ADS-B track, not the ATC clearance. Not for navigation.`
        :(AIP&&AIP.ident_mode==="none"
          ?(aipNameOn()?`<br><b>Name-only SID/STAR ID (licence-restricted) is on.</b> ${aipEsc(AIP.ident_terms||"No licence-safe coding table.")} Names and fixes are never fabricated.`
            :`<br>SID/STAR not identified: no licence-safe coding table for this state. Tick “Name-only SID/STAR ID (licence-restricted)” for the assessment. Names are not invented.`)
          :"");
      el.innerHTML=head+"<br>"+j.rwys.map(r=>{
        const c=r.clusters&&r.clusters[0];
        const pct=c?Math.round((c.share||0)*100):0;
        const shares=identShareLines(r.id, r.dir);
        const shareHtml=shares.length?"<br>"+shares.map(s=>"&nbsp;&nbsp;"+aipEsc(s)).join("<br>"):"";
        return `RWY ${r.id} ${r.dir==="dep"?"departures":"arrivals"} · ${pct}% of ${r.n} flights · observed ADS-B, not published SID/STAR${shareHtml}`;
      }).join("<br>")+identFoot;
    }else el.textContent="";
  }
  applyTrackVis();
}
function aptFromView(){
  if(!map||!AH||!AH.nearestApt) return "G";
  if(map.getZoom()<(AH.AUTO_ZOOM||10.5)) return "G";
  const c=map.getCenter();
  const n=AH.nearestApt(c.lat,c.lng,AH.AUTO_NM);
  return n?n.id:"G";
}
function onAptMove(){
  if(APT_FLY||!map) return;
  const want=aptFromView();
  if(want!==APT) setApt(want,{fly:false});
}
async function gLoad(){const a=APT;if(a==="G")return;const j=await fetch("/api/ground?apt="+encodeURIComponent(a)).then(r=>r.json()).catch(()=>null);if(!j||j.error&&!j.ac||a!==APT)return;
 const all=$("gall")&&$("gall").checked,list=j.ac||[],r=list.filter(x=>all||x[2]==="QTR"||x[2]==="UAE"),live=r.filter(x=>x[11]!=="held"),held=r.filter(x=>x[11]==="held");
 GND_AC=j.ac||[];gPaint(r);
 LOCAL_AIR=(j.air||[]).filter(x=>x&&x[0]);
 for(const row of LOCAL_AIR){const t=TR[row[0]]||(TR[row[0]]=[]);const p=t[t.length-1];if(!p||p[0]!==row[5]||p[1]!==row[4])t.push([row[5],row[4]]);if(t.length>24)t.shift()}
 drawLive();
 const airN=LOCAL_AIR.filter(x=>all||x[2]==="QTR"||x[2]==="UAE").length;
 $("gpt").textContent=`${a} (${j.name||a}): ${live.length} live ground · ${held.length} held · ${airN} airborne ≤${j.air_radius_nm||40} nm${all?"":" (QTR/UAE)"} · ${String(j.time_utc||"").slice(11,19)} UTC${j.error?" · feed: "+j.source:""}`;
 const row=x=>{const held=x[11]==="held",ago=held?`held ${x[12]>=60?(x[12]/60).toFixed(1)+" h":x[12]+" min"} ago`:`${x[9]} s ago`;return`<tr class="${held?"held":""}"><td>${x[1]||x[0]}</td><td>${x[3]}</td><td>${x[8]}${held?" · held":""}</td><td>${held?"–":x[7]}</td><td>${ago}</td></tr>`};
 $("gpl").innerHTML="<tr><th>Callsign</th><th>Type</th><th>Status</th><th>kt</th><th>Last seen</th></tr>"+(r.length?r.sort((p,q)=>(p[11]==="held")-(q[11]==="held")||(p[1]<q[1]?-1:1)).map(row).join(""):'<tr><td colspan="5" class="mu">No live or held ground aircraft right now.</td></tr>')}
function gPaint(r){if(!map||!map.getSource("gnd"))return;const rows=r||GND_AC.filter(x=>$("gall").checked||x[2]==="QTR"||x[2]==="UAE");
 map.getSource("gnd").setData({type:"FeatureCollection",features:rows.map(x=>{const rg=(x[14]||REG_BY_HEX[x[0]]||"").trim();return{type:"Feature",properties:{h:x[0],cs:x[1]||x[0],tr:x[6],st:x[8],mode:x[11]||"live",s:x[0]===SEL?1:0,...(rg?{reg:rg}:{})},geometry:{type:"Point",coordinates:[x[5],x[4]]}}})});applyRegLab()}

let WX={haz:null,st:null,wnd:null,load:{}};
const WX_COL=["match",["get","hz"],"TS","#ff7a45","CONVECTIVE","#ff7a45","TURB","#ff2fd6","TURB-LO","#d67aff","ICE","#5ce1ff","TC","#b06bff","VA","#ffe14d","IFR","#8aa0bf","MTW","#c6ff3a","#ffb020"];
function wxOn(k){return localStorage["wx"+k]==="1"}
function setWx(k,on){
  localStorage["wx"+k]=on?"1":"0";
  const id={haz:"wxhaz",met:"wxmet",wnd:"wxwnd"}[k];
  if($(id))$(id).checked=!!on;
  applyWxVis();
  if(on)wxLoad(k==="met"?"st":k);
  else wxStatus();
  if(SEL)wxPanel();
}
function applyWxVis(){
  if(!map)return;
  const vis=on=>on?"visible":"none";
  if(map.getLayer("wxhaz-fill"))map.setLayoutProperty("wxhaz-fill","visibility",vis(wxOn("haz")));
  if(map.getLayer("wxhaz-line"))map.setLayoutProperty("wxhaz-line","visibility",vis(wxOn("haz")));
  if(map.getLayer("wxmet"))map.setLayoutProperty("wxmet","visibility",vis(wxOn("met")));
  if(map.getLayer("wxmet-lab"))map.setLayoutProperty("wxmet-lab","visibility",vis(wxOn("met")));
  if(map.getLayer("wxwnd"))map.setLayoutProperty("wxwnd","visibility",vis(wxOn("wnd")&&WX.wnd&&WX.wnd.available));
  if(map.getLayer("wxwnd-lab"))map.setLayoutProperty("wxwnd-lab","visibility",vis(wxOn("wnd")&&WX.wnd&&WX.wnd.available));
  if(map.getLayer("wxhaz-lab"))map.setLayoutProperty("wxhaz-lab","visibility",vis(wxOn("haz")));
}
function wxRingC(r){
  if(!r||r.length<1)return null;
  let n=r.length;
  if(n>1&&r[0][0]===r[n-1][0]&&r[0][1]===r[n-1][1])n--;
  if(n<1)return null;
  let x=0,y=0;
  for(let i=0;i<n;i++){x+=r[i][0];y+=r[i][1]}
  return [x/n,y/n];
}
function wxLabPts(fc){
  const out=[];
  for(const f of (fc&&fc.features)||[]){
    const g=f.geometry; if(!g) continue;
    let c=null;
    if(g.type==="Polygon") c=wxRingC(g.coordinates[0]);
    else if(g.type==="MultiPolygon") c=wxRingC((g.coordinates[0]||[])[0]);
    else if(g.type==="LineString") c=g.coordinates[Math.floor(g.coordinates.length/2)];
    else if(g.type==="MultiLineString"){const r=g.coordinates[0]||[]; c=r[Math.floor(r.length/2)]}
    if(c) out.push({type:"Feature",properties:f.properties,geometry:{type:"Point",coordinates:c}});
  }
  return {type:"FeatureCollection",features:out};
}
function wxSetHaz(fc){
  const data=fc&&fc.type==="FeatureCollection"?fc:{type:"FeatureCollection",features:[]};
  if(map&&map.getSource("wxhaz"))map.getSource("wxhaz").setData(data);
  if(map&&map.getSource("wxhaz-pts"))map.getSource("wxhaz-pts").setData(wxLabPts(data));
}
function wxSetup(){
  if(!map||map.getSource("wxhaz"))return;
  map.addSource("wxhaz",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addSource("wxhaz-pts",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"wxhaz-fill",type:"fill",source:"wxhaz",filter:["any",["==",["geometry-type"],"Polygon"],["==",["geometry-type"],"MultiPolygon"]],layout:{visibility:wxOn("haz")?"visible":"none"},paint:{"fill-color":WX_COL,"fill-opacity":["match",["get","product"],"gairmet",.1,.2]}});
  map.addLayer({id:"wxhaz-line",type:"line",source:"wxhaz",layout:{visibility:wxOn("haz")?"visible":"none"},paint:{"line-color":WX_COL,"line-width":["match",["get","product"],"gairmet",1,1.6],"line-opacity":.85}});
  map.addLayer({id:"wxhaz-lab",type:"symbol",source:"wxhaz-pts",minzoom:3.4,layout:{visibility:wxOn("haz")?"visible":"none","text-field":["coalesce",["get","origLabel"],["get","seriesId"],["get","hazard"]],"text-size":10,"text-font":["Open Sans Regular"],"text-optional":true,"symbol-placement":"point","text-allow-overlap":false},paint:{"text-color":WX_COL,"text-halo-color":"#05070d","text-halo-width":1.2}});
  map.addSource("wxwnd",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  if(!map.hasImage("warrow")){const s=32,c=document.createElement("canvas");c.width=c.height=s;const x=c.getContext("2d");x.translate(16,16);x.rotate(0);x.fillStyle="#fff";x.beginPath();x.moveTo(0,-12);x.lineTo(5,10);x.lineTo(0,6);x.lineTo(-5,10);x.closePath();x.fill();map.addImage("warrow",x.getImageData(0,0,s,s),{sdf:true})}
  map.addLayer({id:"wxwnd",type:"symbol",source:"wxwnd",minzoom:2.4,layout:{visibility:"none","icon-image":"warrow","icon-size":["interpolate",["linear"],["zoom"],2,.35,6,.7],"icon-rotate":["get","dir"],"icon-rotation-alignment":"map","icon-allow-overlap":true,"icon-ignore-placement":true},paint:{"icon-color":["interpolate",["linear"],["get","kt"],10,"#8aa0bf",40,"#7cff6b",80,"#ffb020",120,"#ff5a36"],"icon-halo-color":"#05070d","icon-halo-width":.4}});
  map.addLayer({id:"wxwnd-lab",type:"symbol",source:"wxwnd",minzoom:4.5,layout:{visibility:"none","text-field":["to-string",["get","kt"]],"text-size":9,"text-offset":[0,1.1],"text-font":["Open Sans Regular"],"text-optional":true},paint:{"text-color":"#e6f1ff","text-halo-color":"#05070d","text-halo-width":1}});
  if(map.hasImage("airport"))map.removeImage("airport");map.addImage("airport",airportMark(),{sdf:true});
  map.addSource("wxmet",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"wxmet",type:"symbol",source:"wxmet",minzoom:WXMET_MINZOOM,layout:{visibility:wxOn("met")?"visible":"none","icon-image":"airport","icon-size":["interpolate",["linear"],["zoom"],9,.88,11,1.05,13,1.18],"icon-anchor":"center","icon-allow-overlap":true,"icon-ignore-placement":true,"icon-padding":0,"icon-rotation-alignment":"viewport"},paint:{"icon-color":["case",["==",["get","stale"],1],"#d6c48a","#c5e4ff"],"icon-halo-color":"#05070d","icon-halo-width":2}});
  map.addLayer({id:"wxmet-lab",type:"symbol",source:"wxmet",minzoom:WXMET_MINZOOM,layout:{visibility:wxOn("met")?"visible":"none","text-field":["step",["zoom"],["get","labShort"],10,["get","lab"]],"text-size":["interpolate",["linear"],["zoom"],9,11,11,12.5],"text-font":["Open Sans Regular"],"text-optional":true,"text-allow-overlap":false,"text-ignore-placement":false,"text-padding":2,"text-line-height":1.05,"text-max-width":18,"text-variable-anchor":["left","right","bottom","top"],"text-radial-offset":1.45,"text-justify":"auto"},paint:{"text-color":["case",["==",["get","stale"],1],"#ffb020","#e6f1ff"],"text-halo-color":"#05070d","text-halo-width":1.6}});
  const pop=html=>new maplibregl.Popup({maxWidth:"320px"}).setHTML(`<div style="color:#000;font:12px/1.4 sans-serif">${html}</div>`);
  map.on("click","wxhaz-fill",e=>{const p=e.features[0].properties;pop(wxHazHtml(p)).setLngLat(e.lngLat).addTo(map)});
  map.on("click","wxhaz-line",e=>{const p=e.features[0].properties;pop(wxHazHtml(p)).setLngLat(e.lngLat).addTo(map)});
  const wxMetClick=e=>{const p=e.features[0].properties;pop(wxMetHtml(p)).setLngLat(e.lngLat).addTo(map)};
  map.on("click","wxmet",wxMetClick);map.on("click","wxmet-lab",wxMetClick);
  map.on("click","wxwnd",e=>{const p=e.features[0].properties;pop(wxWndHtml(p)).setLngLat(e.lngLat).addTo(map)});
  ["wxhaz-fill","wxhaz-line","wxmet","wxmet-lab","wxwnd"].forEach(l=>{map.on("mouseenter",l,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",l,()=>map.getCanvas().style.cursor="")});
}
function wxHazHtml(p){
  const kind=p.product==="isigmet"?"International SIGMET":p.product==="airsigmet"?"US SIGMET":p.product==="gairmet"?"US G-AIRMET (CONUS-only advisory, not a SIGMET)":esc(p.product||"Advisory");
  return `<b>${esc(p.origLabel||p.seriesId||p.hazard||"Advisory")}</b><br><i>Advisory · not a measured observation · not live turbulence</i><br>${esc(kind)}<br>${p.rawHeader?esc(p.rawHeader)+"<br>":""}${p.firName||p.fir?esc(p.firName||p.fir)+"<br>":""}${p.issueTime?`Issued ${utcShort(p.issueTime)}<br>`:""}Valid ${utcShort(p.validFrom)} → ${utcShort(p.validTo)}${p.top!=null?`<br>Top ${esc(p.top)} ft`:""}<br><span style="white-space:pre-wrap">${esc(p.raw||"")}</span><br><i>Not for operational flight planning. NOAA/NWS AWC / origin agency. Times UTC.</i>`}
function wxWndHtml(p){
  return `<b>GFS forecast winds aloft</b> (model forecast, not an observation)<br>${esc(p.hpa)} hPa · valid ${utcShort(p.valid)} · cycle ${utcShort(p.cycle)} · F${esc(p.fh)}<br>${esc(p.kt)} kt from ${esc(p.from)}°${p.tC!=null?` · ${esc(p.tC)} °C`:""}<br><i>NOAA GFS 1.0° global via NOMADS grib filter. Not WAFS. Not for operational flight planning. Times UTC.</i>`}
function wxIata(){return {DOH:"OTHH",DXB:"OMDB",AUH:"OMAA",LHR:"EGLL",JFK:"KJFK",CDG:"LFPG",FRA:"EDDF",SIN:"WSSS",BKK:"VTBS",HKG:"VHHH",BOM:"VABB",DEL:"VIDP",SYD:"YSSY",MEL:"YMML",NRT:"RJAA",HND:"RJTT"}}
function wxFindMetar(code){
  const rows=(WX.st&&WX.st.metar)||[];
  if(!code)return null;
  const c=String(code).toUpperCase();
  return rows.find(x=>x.icao===c)||rows.find(x=>x.icao===wxIata()[c])||null;
}
function wxObsAgeMin(obs){
  const t=Date.parse(obs); if(!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now()-t)/60000));
}
function wxMetFeat(m){
  const age=wxObsAgeMin(m.obsTime);
  const stale=age!=null&&age>=90;
  const av=wxAvn(m);
  const pa=m.pressPa==null||m.pressPa===""?"Pa n/a":m.pressPa+" Pa";
  const ageBit=age==null?"age n/a":(age<1?"age <1 min":"age "+age+" min");
  const avLine=[m.icao||"",av.timeZ].join(" ");
  const avMet=[av.wind,av.tempDew,av.altim].join(" ");
  return {
    icao:m.icao||"", name:m.name||"", fltCat:m.fltCat||"", raw:m.raw||"", obsTime:m.obsTime||"",
    tempC:m.tempC==null?"":String(m.tempC), dewpC:m.dewpC==null?"":String(m.dewpC),
    windText:m.windText||"wind n/a", windGroup:av.wind, tempDew:av.tempDew, altimGroup:av.altim, avnLine:av.line,
    pressPa:m.pressPa==null?"":String(m.pressPa), pressRef:m.pressRef||"", pressVia:m.pressVia||"",
    labShort:[avLine,avMet].join("\n"),
    lab:[avLine,avMet,pa+(stale?" · stale":""),ageBit].join("\n"),
    stale:stale?1:0, ageMin:age==null?"":String(age)
  };
}
function wxMetHtml(p){
  const taf=WX.st&&WX.st.taf&&WX.st.taf.find(t=>t.icao===p.icao);
  const pa=p.pressPa===""||p.pressPa==null?"pressure n/a (no QNH/altimeter in this METAR)":esc(p.pressPa)+" Pa";
  const ref=p.pressRef?" ("+esc(p.pressRef)+")":"";
  const age=p.ageMin===""||p.ageMin==null?"age n/a":esc(p.ageMin)+" min old";
  const stale=+p.stale===1?" · stale (not a live minute reading)":" · not a live minute reading";
  const av=esc(p.avnLine||[p.icao,p.windGroup,p.tempDew,p.altimGroup].filter(Boolean).join(" "));
  return `<b>METAR summary</b> (subset for the map label, not a complete report)<br>${esc(p.icao)} ${esc(p.name||"")}<br><code>${av}</code><br>${pa}${ref}<br>${p.obsTime?esc(String(p.obsTime).replace("T"," ").slice(0,16))+" UTC":"obs time n/a"} · ${age}${stale}${p.fltCat?" · "+esc(p.fltCat):""}<br><b>Full raw METAR</b><br><code>${esc(p.raw||"raw METAR unavailable")}</code>${taf?`<br><b>TAF · terminal forecast</b><br>Issued ${esc(String(taf.issueTime||"").replace("T"," ").slice(0,16))} UTC<br>Valid ${esc(String(taf.validFrom||"").slice(0,16))} → ${esc(String(taf.validTo||"").slice(0,16))}<br><code>${esc(taf.raw||"")}</code>`:"<br>TAF unavailable for this station in the current cache."}<br><i>Not for operational flight planning or official briefing. NOAA/NWS AWC. Times UTC.</i>`}
function wxStatus(msg,err){
  const el=$("wxst"), full=$("wxfull"), btn=$("wxbtn");
  const bits=[], chip=[];
  const isErr=!!(err||(wxOn("haz")&&WX.haz&&WX.haz.error)||(wxOn("met")&&WX.st&&WX.st.error)||(wxOn("wnd")&&WX.wnd&&!WX.wnd.available));
  if(msg)bits.push(msg);
  if(wxOn("haz")&&WX.haz){
    if(WX.haz.error){bits.push(WX.haz.error);chip.push("hazards error")}
    else {bits.push(`${WX.haz.counts&&WX.haz.counts.current||0} current advisories`+(WX.haz.expiredOmitted?` · ${WX.haz.expiredOmitted} expired omitted`:"" )+(WX.haz.stale?" · stale cache":""));chip.push((WX.haz.counts&&WX.haz.counts.current||0)+" adv."+(WX.haz.stale?" stale":""))}
  }
  if(wxOn("met")&&WX.st){
    if(WX.st.error){bits.push(WX.st.error);chip.push("METAR error")}
    else {bits.push(`${(WX.st.metar||[]).length} METARs / ${(WX.st.taf||[]).length} TAFs`);chip.push((WX.st.metar||[]).length+" METAR")}
  }
  if(wxOn("wnd")){
    const w=WX.wnd;
    if(!w) {bits.push("Loading GFS winds…");chip.push("GFS…")}
    else if(w.available) {bits.push(`GFS winds ${w.cycle_utc?w.cycle_utc.replace("T"," ").slice(0,16)+" UTC cycle":""} · forecast, not observed`);chip.push("GFS winds")}
    else {bits.push("Forecast winds aloft unavailable: "+(w.reason||"no GFS grid").split(". ")[0]+".");chip.push("GFS unavailable")}
  }
  if(btn){btn.classList.toggle("on",wxOn("haz")||wxOn("met")||wxOn("wnd"));btn.classList.toggle("err",isErr);btn.setAttribute("aria-pressed",(wxOn("haz")||wxOn("met")||wxOn("wnd"))?"true":"false")}
  if(full) full.textContent=bits.length?bits.join(" · ")+" Not for operational flight planning. NOAA/NWS AWC. Times UTC. Upstream errors are not “no hazards”.":"Weather overlays off. Enable Airport METAR/TAF for circled-aircraft station icons (close airport zoom) with measured temp, wind and QNH in Pa. Not for operational flight planning. NOAA/NWS AWC. Times UTC.";
  if(!el)return;
  if(!chip.length){el.hidden=true;el.textContent="";el.classList.remove("err");return}
  el.hidden=false;el.classList.toggle("err",isErr);
  el.textContent=chip.join(" · ");
  el.title=bits.join(" · ");
}
async function wxLoad(which){
  if(which==="haz"||which==="all"){
    if(WX.load.haz)return WX.load.haz;
    WX.load.haz=fetch("/api/wx/hazards").then(r=>r.ok?r.json():Promise.reject(new Error("HTTP "+r.status))).then(j=>{WX.haz=j;WX.load.haz=null;wxSetHaz(j.features);wxStatus();if(SEL)wxPanel();return j}).catch(e=>{WX.load.haz=null;WX.haz={error:"Hazard overlay unavailable: "+e.message,features:{type:"FeatureCollection",features:[]},counts:{current:0,expired:0}};wxSetHaz(WX.haz.features);wxStatus(WX.haz.error,true);if(SEL)wxPanel();});
    await WX.load.haz;
  }
  if(which==="st"||which==="all"){
    const extra=wxExtraIcao(), key=extra.slice().sort().join(",");
    if(WX.st&&WX.st._key===key&&!WX.load.st){wxDrawMetar();return}
    const q=extra.length?"?ids="+encodeURIComponent(extra.join(",")):"";
    if(WX.load.st)return WX.load.st;
    WX.load.st=fetch("/api/wx/stations"+q).then(r=>r.ok?r.json():Promise.reject(new Error("HTTP "+r.status))).then(j=>{j._key=key;WX.st=j;WX.load.st=null;wxDrawMetar();wxStatus();if(SEL)wxPanel();return j}).catch(e=>{WX.load.st=null;WX.st={error:"METAR/TAF unavailable: "+e.message,metar:[],taf:[],_key:key};wxDrawMetar();wxStatus(WX.st.error,true);if(SEL)wxPanel();});
    await WX.load.st;
  }
  if(which==="wnd"||which==="all"){
    if(WX.load.wnd)return WX.load.wnd;
    WX.load.wnd=fetch("/api/wx/winds").then(r=>r.ok?r.json():Promise.reject(new Error("HTTP "+r.status))).then(j=>{WX.wnd=j;WX.load.wnd=null;wxFillWindSelects();wxDrawWind();applyWxVis();wxStatus();if(SEL)wxPanel();return j}).catch(e=>{WX.wnd={available:false,status:"unavailable",reason:e.message};WX.load.wnd=null;wxFillWindSelects();wxDrawWind();applyWxVis();wxStatus();if(SEL)wxPanel();});
    await WX.load.wnd;
  }
}
function wxFillWindSelects(){
  const lev=$("wxlev"), hr=$("wxhr"), w=WX.wnd;
  if(!lev||!hr)return;
  if(!w||!w.available){lev.disabled=true;hr.disabled=true;lev.innerHTML=`<option value="">unavailable</option>`;hr.innerHTML=`<option value="">unavailable</option>`;return}
  lev.disabled=false;hr.disabled=false;
  const curL=lev.value, curH=hr.value;
  lev.innerHTML=(w.levels||[]).map(l=>`<option value="${l}">${l} hPa</option>`).join("");
  hr.innerHTML=(w.times||[]).map(t=>`<option value="${t.fh}">F${t.fh} · ${String(t.valid_utc||"").replace("T"," ").slice(0,16)} UTC</option>`).join("");
  if([...lev.options].some(o=>o.value===curL))lev.value=curL; else if([...lev.options].some(o=>o.value==="300"))lev.value="300";
  if([...hr.options].some(o=>o.value===curH))hr.value=curH;
}
function wxDrawWind(){
  if(!map||!map.getSource("wxwnd"))return;
  const w=WX.wnd;
  if(!wxOn("wnd")||!w||!w.available){map.getSource("wxwnd").setData({type:"FeatureCollection",features:[]});applyWxVis();return}
  const lev=$("wxlev")&&$("wxlev").value|| (w.levels||[])[0];
  const fh=$("wxhr")&&$("wxhr").value|| (w.times&&w.times[0]&&w.times[0].fh);
  const rec=w.fields&&w.fields[fh+":"+lev];
  if(!rec){map.getSource("wxwnd").setData({type:"FeatureCollection",features:[]});return}
  const feats=[];
  const nlon=(w.lons||[]).length, z=map.getZoom?map.getZoom():2, phone=typeof isPhone==="function"?isPhone():innerWidth<=700;
  const stride=(z<2.8||(phone&&z<3.5))?2:1;
  const copies=z<3.2?[-360,0,360]:(z<4.5?[-360,0,360]:[0]);
  for(let j=0;j<(w.lats||[]).length;j+=stride) for(let i=0;i<nlon;i+=stride){
    const lat=w.lats[j];
    if(lat==null||Math.abs(lat)>85) continue;
    const k=j*nlon+i, u=rec.u[k], v=rec.v[k];
    if(u==null||v==null)continue;
    const spd=Math.sqrt(u*u+v*v), kt=Math.round(spd*1.94384);
    let to=Math.atan2(u,v)*180/Math.PI; if(to<0)to+=360;
    const from=(to+180)%360;
    let lon=w.lons[i]; if(lon>180)lon-=360; else if(lon<-180)lon+=360;
    const props={kt,dir:Math.round(to),from:Math.round(from),hpa:lev,fh,valid:rec.valid_utc,cycle:rec.cycle_utc,tC:rec.tC?rec.tC[k]:null};
    for(const wrap of copies){
      const x=lon+wrap;
      if(x<-540||x>540) continue;
      feats.push({type:"Feature",properties:props,geometry:{type:"Point",coordinates:[x,lat]}});
    }
  }
  map.getSource("wxwnd").setData({type:"FeatureCollection",features:feats});
  applyWxVis();
}
function wxDrawMetar(){
  if(!map||!map.getSource("wxmet"))return;
  const rows=(WX.st&&WX.st.metar)||[];
  map.getSource("wxmet").setData({type:"FeatureCollection",features:rows.filter(m=>typeof m.lat==="number"&&typeof m.lon==="number").map(m=>({type:"Feature",properties:wxMetFeat(m),geometry:{type:"Point",coordinates:[m.lon,m.lat]}}))});
}
function wxExtraIcao(){
  const a=SEL&&selAc(), {od}=a?routeEnds(a.cs||"",a):{};
  const iata=wxIata();
  const ids=[];
  if(od){if(od.o&&od.o.icao)ids.push(od.o.icao);if(od.d&&od.d.icao)ids.push(od.d.icao);if(od.oi&&iata[od.oi])ids.push(iata[od.oi]);if(od.di&&iata[od.di])ids.push(iata[od.di])}
  return [...new Set(ids.filter(Boolean))];
}
function pip(lon,lat,geom){
  if(!geom)return false;
  const ring=(coords)=>{let ins=false;const r=coords[0]||[];for(let i=0,j=r.length-1;i<r.length;j=i++){const xi=r[i][0],yi=r[i][1],xj=r[j][0],yj=r[j][1];if(((yi>lat)!==(yj>lat))&&lon<(xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi)ins=!ins}return ins};
  if(geom.type==="Polygon")return ring(geom.coordinates);
  if(geom.type==="MultiPolygon")return geom.coordinates.some(ring);
  return false;
}
function wxHits(lon,lat,line){
  const feats=(WX.haz&&WX.haz.features&&WX.haz.features.features)||[];
  const at=[], along=[];
  for(const f of feats){
    if(pip(lon,lat,f.geometry)) at.push(f);
    if(line&&line.length){for(const c of line){if(pip(c[0],c[1],f.geometry)){along.push(f);break}}}
  }
  return {at, along};
}
function utcShort(t){return t?String(t).replace("T"," ").slice(0,16)+" UTC":"time unavailable"}
function wxPanel(){
  const el=$("spwx");if(!el)return;
  if(!SEL){el.innerHTML="";return}
  const a=selAc();if(!a){el.innerHTML="";return}
  const [lon,lat]=dispLonLat(a.lat,a.lon,a.gs,a.trk,a.gnd||a.held,a.gnd||a.held?0:a.alt,a.age,a.hex);
  const {od,unverified}=routeEnds(a.cs,a);
  let rem=null;
  if(od&&typeof od.d.lat==="number") rem=typeof gc==="function"?gc([lat,lon],[od.d.lat,od.d.lon]):null;
  const needHaz=true, needSt=true;
  if(needHaz&&!WX.haz&&!WX.load.haz)wxLoad("haz");
  if(needSt&&!WX.st&&!WX.load.st)wxLoad("st");
  if(wxOn("wnd")&&!WX.wnd&&!WX.load.wnd)wxLoad("wnd");
  const h=WX.haz, st=WX.st, wnd=WX.wnd;
  const phone=isPhone();
  let body="";
  body+=`<div class="spsec"><h3>En-route weather ${tg("na","Not operational")}</h3>`;
  if(!h) body+=`<p class="mu">Loading hazard advisories…</p>`;
  else if(h.error&&!(h.features&&h.features.features&&h.features.features.length)) body+=`<p class="mu warn">${esc(h.error)} This is an upstream/cache error, not a finding of no hazards.</p>`;
  else {
    const hit=wxHits(lon,lat,rem);
    const near=hit.at.slice(0,4);
    const route=hit.along.filter(f=>!hit.at.includes(f)).slice(0,4);
    if(h.stale) body+=`<p class="mu">Hazard cache is stale. ${esc(h.error||"")}</p>`;
    if(near.length) body+=`<p><b>${phone?"At position":"Advisories at displayed position"}</b>${phone?"":" (SIGMET/G-AIRMET polygons, not live turbulence)"}</p>`+near.map(f=>wxAdvLine(f)).join("");
    else body+=`<p class="mu">No current SIGMET/G-AIRMET polygon in this overlay contains the displayed position. That is not a clearance and is not “no weather”.</p>`;
    if(route.length) body+=`<p><b>${phone?"On remaining GC":"Provisional remaining-route intersections"}</b>${phone?"":" (estimated great-circle to destination, <em>not</em> a filed plan)"}</p>`+route.map(f=>wxAdvLine(f)).join("");
    else if(rem) body+=`<p class="mu">No current advisory polygon in this overlay intersects the estimated remaining great-circle. Intersections are provisional because the remaining route is not a filed flight plan.</p>`;
    else body+=`<p class="mu">${unverified?"Remaining-route intersection unavailable: route unverified/unavailable, so there is no estimated great-circle.":"Remaining-route intersection unavailable: destination is unknown, so there is no estimated great-circle."}</p>`;
    if(h.counts) body+=`<p class="mu">${h.counts.current} current advisories in overlay · ${h.expiredOmitted||0} expired omitted · ${h.at?("fetched "+h.at.replace("T"," ").slice(0,16)+" UTC"):""}</p>`;
  }
  body+=wxStationBlock(st,od,lat,lon,a);
  body+=wxWindBlock(wnd,a,lat,lon);
  body+=`<p class="mu">Not for operational flight planning. NOAA/NWS Aviation Weather Center; origin meteorological authorities. Hide tracks does not change weather layers. Times UTC.</p></div>`;
  el.innerHTML=body;
  moreAppend([
    "SIGMET/G-AIRMET polygons are not live turbulence and not a clearance. Remaining-route intersections are provisional because the remaining route is not a filed flight plan.",
    "METAR pressure in Pa is converted from hPa or inHg, not a METAR Q group. TAF is a forecast. NOAA GFS winds are forecast, not WAFS and not live turbulence.",
    "Not for operational flight planning. NOAA/NWS Aviation Weather Center; origin meteorological authorities. Hide tracks does not change weather layers. Times UTC."
  ]);
}
function wxAdvLine(f){
  const p=f.properties||{};
  const prod=p.product==="isigmet"?"International SIGMET":p.product==="airsigmet"?"US SIGMET":p.product==="gairmet"?"US G-AIRMET":"Advisory";
  return `<div class="chip"><span>${esc(prod)} · advisory</span>${esc(p.origLabel||((p.hazard||"")+(p.qualifier?" "+p.qualifier:"")))}<div class="mu">${esc(p.rawHeader||p.firName||p.coverage||"")}${p.issueTime?`<br>Issued ${utcShort(p.issueTime)}`:""}<br>Valid ${utcShort(p.validFrom)} → ${utcShort(p.validTo)}</div></div>`;
}
function wxWindBlock(w,a,lat,lon){
  if(!w) return `<p class="mu">Forecast winds aloft: enable the toggle to load NOAA GFS (global 1°). Not loaded yet.</p>`;
  if(!w.available) return `<div class="scg">${na("Forecast winds aloft")}</div><p class="mu">${esc(w.reason||"Unavailable.")} This is not a finding of calm winds.</p>`;
  const alt=a&&!a.gnd&&!a.held?a.alt:null;
  const hpaWant=alt==null?300:alt>35000?200:alt>25000?300:alt>14000?500:850;
  const levs=w.levels||[];
  const hpa=levs.reduce((b,x)=>Math.abs(x-hpaWant)<Math.abs(b-hpaWant)?x:b, levs[0]||300);
  const fh=(w.times&&w.times[0]&&w.times[0].fh)||6;
  const rec=w.fields&&w.fields[fh+":"+hpa];
  if(!rec||!w.lats||!w.lons) return `<div class="scg">${na("Forecast winds aloft")}</div><p class="mu">GFS field ${hpa} hPa F${fh} is not in the decoded subset.</p>`;
  const lonWrap=(a,b)=>{let d=a-b;while(d>180)d-=360;while(d<-180)d+=360;return d};
  let bi=0,bj=0,bd=1e9;
  for(let j=0;j<w.lats.length;j++) for(let i=0;i<w.lons.length;i++){const d=(w.lats[j]-lat)**2+lonWrap(w.lons[i],lon)**2;if(d<bd){bd=d;bi=i;bj=j}}
  const k=bj*w.lons.length+bi, u=rec.u[k], v=rec.v[k];
  if(u==null||v==null) return `<div class="scg">${na("Forecast winds aloft")}</div><p class="mu">No GFS sample at this location.</p>`;
  const spd=Math.sqrt(u*u+v*v), kt=Math.round(spd*1.94384);
  let to=Math.atan2(u,v)*180/Math.PI; if(to<0)to+=360;
  const tC=rec.tC&&rec.tC[k];
  return `<div class="scg">${cell("GFS winds aloft (forecast)",`${hpa} hPa · ${kt} kt from ${Math.round((to+180)%360)}°${tC!=null?" · "+tC+" °C":""}<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">Nearest ${w.step_deg}° sample to displayed position · valid ${utcShort(rec.valid_utc)} · cycle ${utcShort(rec.cycle_utc)} F${fh}${alt==null?"":" · level from displayed altitude, not a sounding"}</div>`)}</div><p class="mu">NOAA GFS 1.0° via NOMADS grib filter (simple packing). Forecast, not a measured wind. Not WAFS and not live turbulence.</p>`;
}
function wxStationBlock(st,od,lat,lon,a){
  if(!st) return `<p class="mu">Loading METAR/TAF…</p>`;
  if(st.error&&!(st.metar&&st.metar.length)) return `<p class="mu">${esc(st.error)} Observation/forecast error, not “no weather”.</p>`;
  const want=[];
  const iata=wxIata();
  if(od){const o=od.o&&(od.o.icao||iata[od.oi]), d=od.d&&(od.d.icao||iata[od.di]); if(o)want.push(["Origin",o]); if(d)want.push(["Destination",d])}
  if(a&&(a.gnd||a.held)&&a.apt){const h=aptHub(a.apt);if(h&&h.icao&&!want.some(w=>w[1]===h.icao))want.push(["Airport",h.icao])}
  if(APT&&APT!=="G"){const h=aptHub(APT);if(h&&h.icao&&!want.some(w=>w[1]===h.icao))want.push(["Airport",h.icao])}
  const rows=st.metar||[];
  let nearest=null, nd=1e9;
  for(const m of rows){if(typeof m.lat!=="number")continue;const d=hv(lat,lon,m.lat,m.lon);if(d<nd){nd=d;nearest=m}}
  if(nearest&&nd<250&&!want.some(w=>w[1]===nearest.icao)) want.push([`Nearest in cache (${Math.round(nd)} nm)`, nearest.icao]);
  if(!want.length&&nearest) want.push(["Nearest in cache", nearest.icao]);
  if(!want.length) return `<p class="mu">No METAR in the cached hub set for this position.</p>`;
  return want.map(([lab,id])=>{
    const m=rows.find(x=>x.icao===id), t=(st.taf||[]).find(x=>x.icao===id);
    const f=m?wxMetFeat(m):null;
    const press=m?(m.pressPa==null?"pressure n/a":m.pressPa+" Pa"+(m.pressRef?" ("+m.pressRef+")":"")):"pressure n/a";
    const avn=f&&f.avnLine?`<br><code>${esc(f.avnLine)}</code>`:"";
    const stale=f&&f.stale?' <span class="tg est">Stale</span>':"";
    const obs=m?cell(lab+" METAR (measured)",`${esc(id)} · ${esc(m.fltCat||"cat n/a")}${stale}${avn}<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">${esc(press)} — Pa is converted, not a METAR Q group<br>Full raw: ${esc(m.raw||"raw METAR unavailable")}<br>${utcShort(m.obsTime)} · not a live minute reading</div>`):na(lab+" METAR (measured)");
    const fc=t?cell(lab+" TAF (forecast)",`${esc(id)}<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">${esc(t.raw||"")}<br>Valid ${utcShort(t.validFrom)} → ${utcShort(t.validTo)}</div>`):na(lab+" TAF (forecast)");
    return `<div class="scg">${obs}${fc}</div>`;
  }).join("");
}
function syncWx(){
  ["haz","met","wnd"].forEach(k=>{const id={haz:"wxhaz",met:"wxmet",wnd:"wxwnd"}[k];if($(id))$(id).checked=wxOn(k);if(wxOn(k))wxLoad(k==="met"?"st":k)});
  applyWxVis();wxStatus();
}
