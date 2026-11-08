// Live map: FR24-style aircraft layer, trails, selection panel, real flown tracks. Data: adsb.lol (ODbL).
let SEL=null,TR={},CSR=null,TK=null,prof=null,lastFrame=0,REG_BY_HEX={},SRCH_GND=[],QHits=[],QIx=-1,QTm=null;
const TRACK_LAYERS=["trails","tk","tkgc","sel-flown","sel-join","sel-gap","sel-rem"];
function ageS(){return L&&L.at?Math.min(90,(Date.now()-new Date(L.at))/1000):0}
function dispLonLat(lat,lon,gs,trk,onG){
  let la=+lat, lo=+lon;
  if(!onG && gs>40){
    const d=gs*ageS()/3600/60, t=trk*R2, c=Math.cos(la*R2);
    la+=d*Math.cos(t); lo+=d*Math.sin(t)/Math.max(Math.abs(c),0.2);
  }
  if(lo>180)lo-=360; else if(lo<-180)lo+=360;
  return [lo,la];
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
function posFresh(a){if(!a||a.held||a.gnd||a.src!=="live")return false; if((a.age||0)>60)return false; if(L&&L.at&&Date.now()-Date.parse(L.at)>120000)return false; return a.gs>120}
function observedEvents(P,a){
  const ev={takeoff:null,landing:null,since:P[0]?P[0][0]:null};
  let lastG=null;
  for(const p of P){
    if(gndLike(p)) lastG=p;
    else if(airLike(p)&&lastG&&!ev.takeoff && (p[0]-lastG[0])<=20*60000) ev.takeoff=p[0];
  }
  if(a&&(a.gnd||a.held)){
    for(let i=1;i<P.length;i++) if(airLike(P[i-1])&&gndLike(P[i])&&(P[i][0]-P[i-1][0])<=20*60000) ev.landing=P[i][0];
  }
  return ev;
}
function hideTracksOn(){return localStorage.hidet==="1"}
function applyTrackVis(){
  if(!map)return;
  const hide=hideTracksOn(),vis=on=>on?"visible":"none";
  for(const id of TRACK_LAYERS)if(map.getLayer(id))map.setLayoutProperty(id,"visibility",vis(!hide));
  if(map.getLayer("arcs"))map.setLayoutProperty("arcs","visibility",vis(!hide&&$("arcs")&&$("arcs").checked));
}
function setHideTracks(on){
  localStorage.hidet=on?"1":"0";
  const el=$("hidet");if(el)el.checked=!!on;
  const b=$("htb");if(b){b.classList.toggle("on",!!on);b.setAttribute("aria-pressed",on?"true":"false");b.textContent=on?"Show tracks":"Hide tracks"}
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
  const b=$("rlb");if(b){b.classList.toggle("on",!!on);b.setAttribute("aria-pressed",on?"true":"false");b.textContent=on?"Reg labels on":"Reg labels"}
  applyRegLab();
}
const AMB="#ffc400",GND="#8a94a6",ALTC=["interpolate",["linear"],["get","alt"],0,"#9aa4b2",1000,"#ff5a36",10000,"#ffb000",20000,"#c6ff3a",30000,"#00e5ff",40000,"#b06bff"];
const R2=Math.PI/180,hv=(a,b,c,d)=>{const x=Math.sin((c-a)*R2/2)**2+Math.cos(a*R2)*Math.cos(c*R2)*Math.sin((d-b)*R2/2)**2;return 2*3440.065*Math.asin(Math.sqrt(Math.min(1,x)))};
function plane(){const s=48,c=document.createElement("canvas");c.width=c.height=s;const x=c.getContext("2d");x.fillStyle="#fff";x.beginPath();
 const p=[[24,2],[27,8],[27,19],[45,29],[45,33],[27,27],[27,38],[33,43],[33,46],[24,43],[15,46],[15,43],[21,38],[21,27],[3,33],[3,29],[21,19],[21,8]];p.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();return x.getImageData(0,0,s,s)}
function acF(){const mf=$("mf").value,ty=$("tyf").value.trim().toUpperCase();
 return (L?L.ac:[]).filter(a=>(mf==="all"||(mf==="other"?!["QTR","UAE"].includes(a[2]):a[2]===mf))&&(!ty||(a[3]||"").toUpperCase().startsWith(ty))).map(a=>{
  const [lon,lat]=dispLonLat(a[4],a[5],a[7],a[8],a[10]);
  const rg=(a[9]||"").trim(); if(a[0]&&rg)REG_BY_HEX[a[0]]=rg;
  return{type:"Feature",properties:{h:a[0],cs:a[1],a:a[2],t:a[3],alt:a[6],gs:a[7],trk:a[8],g:a[10],hl:["QTR","UAE"].includes(a[2])?1:0,s:a[0]===SEL?1:0,...(rg?{reg:rg}:{})},geometry:{type:"Point",coordinates:[lon,lat]}}})}
function drawLive(){if(!map||!map.getSource("live")||!L)return;const f=acF();map.getSource("live").setData({type:"FeatureCollection",features:f});
 if($("trl").checked){const tf=[];for(const x of f){const t=TR[x.properties.h];if(t&&t.length>1)tf.push({type:"Feature",properties:{a:x.properties.a},geometry:{type:"LineString",coordinates:[...t.slice(-12),x.geometry.coordinates]}})}map.getSource("trails").setData({type:"FeatureCollection",features:tf})}
 else map.getSource("trails").setData({type:"FeatureCollection",features:[]});applyTrackVis();applyRegLab();if(SEL)selUpdate();refreshQres()}
function onPoll(){if(!L)return;for(const a of L.ac){const t=TR[a[0]]||(TR[a[0]]=[]),p=t[t.length-1];if(!p||p[0]!==a[5]||p[1]!==a[4])t.push([a[5],a[4]]);if(t.length>14)t.shift();const rg=(a[9]||"").trim();if(a[0]&&rg)REG_BY_HEX[a[0]]=rg}covDraw();
 const al=[...new Set(L.ac.map(a=>a[2]))].sort(),mf=$("mf"),v=mf.value;if(mf.options.length<4+al.length-2){mf.innerHTML=`<option value="all">All airlines</option><option value="QTR">QTR</option><option value="UAE">UAE</option><option value="other">Other airlines</option>`+al.filter(x=>!["QTR","UAE"].includes(x)).map(x=>`<option>${x}</option>`).join("");mf.value=v}drawLive()}
function initMap(){map=new maplibregl.Map({container:"map",style:"https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",center:[35,28],zoom:innerWidth<700?1.1:2,attributionControl:{compact:true}});
 map.addControl(new maplibregl.NavigationControl());
 map.on("load",async()=>{map.addImage("plane",plane(),{sdf:true});
  const cf=H.map.filter(r=>H.ap[r[1]]&&H.ap[r[2]]).map(r=>({type:"Feature",properties:{a:r[0],n:r[3],inf:r[4]||0,low:(r[3]<5||(r[4]||0)/r[3]>.5)?1:0,r:r[1]+"-"+r[2]},geometry:{type:"LineString",coordinates:gc(H.ap[r[1]],H.ap[r[2]])}}));
  map.addSource("cov",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addLayer({id:"cov",type:"fill",source:"cov",paint:{"fill-color":"#3aa0ff","fill-opacity":.06}});map.addSource("covb",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addLayer({id:"covb",type:"line",source:"covb",layout:{"line-join":"round",visibility:localStorage.cvb==="0"?"none":"visible"},paint:{"line-color":"#5cc8ff","line-width":["interpolate",["linear"],["zoom"],1,.8,6,1.6],"line-opacity":.85}});
  wxSetup();
  map.addSource("arcs",{type:"geojson",data:{type:"FeatureCollection",features:cf}});
  map.addLayer({id:"arcs",type:"line",source:"arcs",layout:{visibility:"none"},paint:{"line-color":["match",["get","a"],"QTR",C1,C2],"line-width":["interpolate",["linear"],["get","n"],1,.3,1600,1.4],"line-opacity":["case",["==",["get","low"],1],.12,.35],"line-dasharray":[2,2]}});
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
  map.addLayer({id:"sel-ap",type:"circle",source:"sel",filter:["==",["get","k"],"ap"],paint:{"circle-radius":5,"circle-color":"#0b1222","circle-stroke-color":"#fff","circle-stroke-width":2}});
  map.addLayer({id:"sel-apl",type:"symbol",source:"sel",filter:["==",["get","k"],"ap"],layout:{"text-field":["get","n"],"text-size":12,"text-offset":[0,1.2],"text-font":["Open Sans Regular"]},paint:{"text-color":"#fff","text-halo-color":"#000","text-halo-width":1}});
  map.addSource("live",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"live",type:"symbol",source:"live",layout:{"icon-image":"plane","icon-size":["interpolate",["linear"],["zoom"],1,["case",["==",["get","hl"],1],.34,.26],3,["case",["==",["get","hl"],1],.42,.32],8,["case",["==",["get","hl"],1],.7,.55]],"icon-rotate":["get","trk"],"icon-rotation-alignment":"map","icon-allow-overlap":true,"icon-ignore-placement":true,"icon-padding":0,"symbol-sort-key":["get","hl"]},
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
  const tick=()=>{if(Date.now()-lastFrame>1000){lastFrame=Date.now();drawLive()}requestAnimationFrame(tick)};tick();onPoll();covDraw();setApt(localStorage.apt||"G");applyTrackVis();applyRegLab();syncWx()})}
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
function padMap(){if(!map||typeof map.loaded!=="function"||!map.loaded())return;const on=$("sp").classList.contains("on")&&!$("sp").classList.contains("min"),w=innerWidth>700;map.setPadding({top:0,left:0,bottom:on&&!w?Math.min(280,innerHeight*.42):0,right:on&&w?376:0})}
function openSp(){const el=$("sp");if(el.parentNode!==document.body)document.body.appendChild(el);el.classList.add("on");el.classList.remove("min");el.style.display="flex";el.dataset.hex=SEL||"";const m=$("map");if(m&&m.scrollIntoView)m.scrollIntoView({block:"nearest",inline:"nearest"});padMap();if(map&&map.resize)map.resize()}
function closeSp(){const el=$("sp");el.classList.remove("on","min");el.style.display="none";el.dataset.hex="";padMap();if(map&&map.resize)map.resize()}
function selAc(){const a=L&&L.ac.find(x=>x[0]===SEL);if(a)return{hex:a[0],cs:a[1],al:a[2],typ:a[3],lat:a[4],lon:a[5],alt:a[6],gs:a[7],trk:a[8],reg:a[9],gnd:!!a[10],age:a[11],vs:a[12],held:false,st:a[10]?"ground":"airborne",src:"live"};
 const g=gRow(SEL);if(!g)return null;const held=g[11]==="held";
 return{hex:g[0],cs:g[1]||g[0],al:g[2],typ:g[3],lat:g[4],lon:g[5],alt:0,gs:g[7],trk:g[6],reg:(g[14]||REG_BY_HEX[g[0]]||"").trim(),gnd:true,age:held?(g[12]||0)*60:g[9],held,heldMin:g[12],heldUtc:g[13]||"",st:g[8]||"ground",src:"ground",apt:g[15]||""}}
function alName(code,dbName){return (L&&L.nm&&code&&L.nm[code])||dbName||""}
function apBox(ap,side){if(!ap)return `<div class="ode ${side}"><div class="iata">—</div><div class="city">Unavailable</div></div>`;
 const code=ap.iata||ap.icao||"—";return `<div class="ode ${side}"><div class="iata">${esc(code)}</div><div class="city">${esc(ap.city||"")}</div><div class="an">${esc(ap.name||(ap.iata||ap.icao?"":"Unavailable"))}</div></div>`}
function routeEnds(cs){const db=DB&&DB.found?{o:{iata:DB.origin.iata||"",icao:DB.origin.icao||"",name:DB.origin.name||"",city:DB.origin.city||"",lat:DB.origin.lat,lon:DB.origin.lon},d:{iata:DB.destination.iata||"",icao:DB.destination.icao||"",name:DB.destination.name||"",city:DB.destination.city||"",lat:DB.destination.lat,lon:DB.destination.lon},oi:DB.origin.iata||DB.origin.icao,di:DB.destination.iata||DB.destination.icao}:null;
 const hi0=odOf(cs),hi=hi0?{o:{iata:hi0.o,icao:"",name:"",city:hi0.O[2]||"",lat:hi0.O[0],lon:hi0.O[1]},d:{iata:hi0.d,icao:"",name:"",city:hi0.D[2]||"",lat:hi0.D[0],lon:hi0.D[1]},oi:hi0.o,di:hi0.d,n:hi0.n,tot:hi0.tot}:null;
 return{db,hi,od:db||hi}}
async function select(h){SEL=h;DB=null;SEL_T=[];openSp();gPaint();wxPanel();const ac0=selAc();const cs=ac0&&ac0.cs;
 if(cs)fetch("/api/route?cs="+encodeURIComponent(cs)).then(r=>r.json()).then(j=>{if(SEL===h){DB=j;selUpdate();wxPanel()}}).catch(()=>{if(SEL===h){DB={found:false};selUpdate();wxPanel()}});
 const r=await fetch("/api/track?hex="+h+"&t="+Date.now(),{cache:"no-store"}).then(r=>r.json()).catch(()=>({points:[]}));if(SEL!==h)return;SEL_T=r.points||[];selUpdate(true);wxPanel()}
function selUpdate(first){const a=selAc();if(!a){unsel();return}
 const snap=[a.lon,a.lat], shown=dispLonLat(a.lat,a.lon,a.gs,a.trk,a.gnd||a.held), {db,hi,od}=routeEnds(a.cs), F=[];
 let P=SEL_T.length?SEL_T.slice():[];
 const last=P[P.length-1];
 if(!last||last[1]!==a.lon||last[2]!==a.lat) P.push([L&&L.at?Date.parse(L.at):Date.now(),a.lon,a.lat,a.alt,a.gs,a.vs||0,a.gnd?1:0]);
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
 let routeHtml="", rm=null, canEta=false, etaMs=null, fl=null, pc=null;
 if(od&&typeof od.o.lat==="number"&&typeof od.d.lat==="number"){
  F.push({type:"Feature",properties:{k:"rem"},geometry:{type:"LineString",coordinates:gc([shown[1],shown[0]],[od.d.lat,od.d.lon])}});
  F.push({type:"Feature",properties:{k:"ap",n:od.oi},geometry:{type:"Point",coordinates:[od.o.lon,od.o.lat]}},{type:"Feature",properties:{k:"ap",n:od.di},geometry:{type:"Point",coordinates:[od.d.lon,od.d.lat]}});
  fl=hv(od.o.lat,od.o.lon,shown[1],shown[0]); rm=hv(shown[1],shown[0],od.d.lat,od.d.lon); pc=Math.max(0,Math.min(100,100*fl/(fl+rm||1)));
  canEta=posFresh(a)&&rm!=null; if(canEta) etaMs=Date.now()+rm/a.gs*3600e3;
  routeHtml=`<div class="spsec"><h3>Route ${tg("est","Estimated")}</h3>
   <div class="od">${apBox(od.o,"from")}<div class="odarr">→</div>${apBox(od.d,"to")}</div>
   <div class="pg"><span>${esc(od.oi)}<small>origin</small></span><div class="bar"><div style="width:${pc}%"></div><b style="left:${pc}%">✈</b></div><span>${esc(od.di)}<small>destination</small></span></div>
   <div class="scg">${cell("Progress (GC est.)",Math.round(pc)+"%")}${cell("Flown (GC est.)",fmt(Math.round(fl))+" nm")}${cell("Remaining (GC est.)",fmt(Math.round(rm))+" nm")}${canEta?cell("Remaining time (est.)",hm(rm/a.gs)):na("Remaining time")}</div>
   <p class="mu">${srcNote(db,hi)} Remaining route and the selected marker share the same displayed position (dead-reckoned between refreshes, estimate). Distances are great-circle, not the flown path. Not a schedule.</p></div>`}
 else routeHtml=`<div class="spsec"><h3>Route ${DB?tg("na","Unavailable"):tg("est","Looking up")}</h3>
  <div class="od">${apBox(null,"from")}<div class="odarr">→</div>${apBox(null,"to")}</div>
  <p class="mu">${DB?"Origin and destination unavailable: adsbdb has no route for this callsign and there is no route history for it (history covers QTR/UAE only). ADS-B does not broadcast origin/destination.":"Looking up route in adsbdb…"}</p></div>`;
 if(map.getSource("sel"))map.getSource("sel").setData({type:"FeatureCollection",features:F});applyTrackVis();gPaint();
 const sk=[a.hex,a.lat,a.lon,a.alt,a.gs,a.trk,a.vs,a.age,a.held,!!(DB&&DB.found),P.length,a.src,canEta&&etaMs?Math.round(etaMs/60000):""].join("|");
 if(!first&&sk===SEL_DRAW&&$("sp").classList.contains("on"))return;SEL_DRAW=sk;
 const name=alName(a.al,DB&&DB.airline),fresh=a.held?`Held last ground position, ${a.heldMin>=60?(a.heldMin/60).toFixed(1)+" h":a.heldMin+" min"} ago (ADS-B off / dropped)`:a.gnd?`Observed · on ground · ${a.age} s ago`:`Observed · ${a.age} s ago`;
 $("spcs").textContent=a.cs||"—";$("spal").textContent=name?name+(a.al?" · "+a.al:""):(a.al||"Airline unavailable");
 $("spsum").textContent=`Callsign ${a.cs||"—"} · ${a.gnd||a.held?"ground":fmt(a.alt)+" ft"} · ${a.held?"held":a.gs+" kt"} · ${fresh}`;
 $("sp").dataset.hex=a.hex||"";
 const chips=[a.reg?`<div class="chip"><span>Registration</span>${esc(a.reg)}</div>`:"",a.typ?`<div class="chip"><span>Aircraft type</span>${esc(a.typ)}</div>`:"",a.hex?`<div class="chip"><span>Hex</span>${esc(String(a.hex).toUpperCase())}</div>`:""].filter(Boolean).join("");
 const iataCs=DB&&DB.callsign_iata&&DB.callsign_iata!==a.cs?cell("IATA-form callsign",esc(DB.callsign_iata)+`<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">adsbdb spelling of this ADS-B callsign, not a ticketed flight number</div>`):"";
 const alt=a.held||a.gnd?"On ground":fmt(a.alt)+" ft";
 const vs=a.held||a.src==="ground"?null:a.vs;
 const ev=observedEvents(P,a);
 const toffHtml=ev.takeoff?cell("Observed takeoff",utcClock(ev.takeoff)):ev.since?cell("Tracking since",utcClock(ev.since)):na("Observed takeoff");
 const etaHtml=canEta&&etaMs?cell("Estimated arrival",`${utcClock(etaMs)}<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">Estimated from remaining distance ÷ current ground speed, not schedule</div>`):na("Estimated arrival");
 const landHtml=ev.landing?cell("Observed landing",utcClock(ev.landing)):na("Actual arrival");
 const timeNote=(ev.takeoff
  ? "Observed takeoff is the first airborne sample after a ground sample in this server's track (not wheels-up, not a schedule or gate time). Refresh interval is about 90 s."
  : (ev.since?"No ground-to-air transition in this server's track. Tracking since is when this server first stored a position for the hex, not departure.":"No timestamped track yet for this hex."))
  +(ev.landing?" Observed landing is the first ground sample after airborne in this track (not on-blocks or gate).":" Actual arrival stays unavailable until an air-to-ground transition is captured.");
 $("spb").innerHTML=`<div class="chips">${chips}</div>
  <div class="spsec"><h3>Identity</h3>
   <div class="scg">${cell("Callsign",esc(a.cs||"—"))}${na("Flight number")}${iataCs}</div>
   <p class="mu">Callsign is the ADS-B transponder identity from adsb.lol (observed). Flight number means the marketed/ticketed passenger number: none of the connected sources provide a verified current one. adsbdb returns <code>callsign_iata</code> by putting the airline IATA prefix on the same callsign string (QR72L for QTR72L, EK214 for UAE214) — that is not a ticketed flight, especially for alphanumeric callsigns, and the route can be stale or reused. Codeshares are not resolved.</p></div>
  <div class="spsec"><h3>Position ${a.held?tg("est","Held"):tg("obs","Observed")}</h3>
   <div class="scg">${cell("Altitude",alt)}${a.held?na("Ground speed"):cell("Ground speed",a.gs+" kt")}${cell("Heading / track",a.trk+"°")}${vs==null?na("Vertical rate"):cell("Vertical rate",(vs>0?"+":"")+fmt(vs)+" fpm")}${cell("Freshness",esc(fresh))}${cell("Snapshot",a.lat.toFixed(a.src==="ground"?5:3)+" / "+a.lon.toFixed(a.src==="ground"?5:3))}</div>
   <p class="mu">${a.held?"Last ground position kept after the aircraft dropped out of the ADS-B feed. Not a live update.":"Snapshot is the last adsb.lol position (not interpolated). The map marker and remaining route use the same displayed point, dead-reckoned from that snapshot between refreshes (estimate). Heading is ADS-B track. Times UTC."}</p></div>
  ${routeHtml}
  <div class="spsec"><h3>Times</h3>
   <div class="scg">${na("Scheduled departure")}${na("Scheduled arrival")}${toffHtml}${etaHtml}${landHtml}</div>
   <p class="mu">No airline schedule feed is connected, so scheduled times stay unavailable. Estimated arrival is remaining great-circle distance ÷ current ground speed, UTC, only when the route destination is known and the position is a fresh moving airborne snapshot — not a schedule or airport actual. Actual arrival is shown only after an observed air-to-ground transition in this track. ${timeNote}</p></div>
  <div class="spsec"><h3>Observed track ${P.length>=2?tg("obs","Observed"):tg("na","Unavailable")}</h3></div>`;
 $("prof").style.display=P.length<2?"none":"";
 if(P.length>=2)ch("prof",{grid:{left:44,right:36,top:12,bottom:46},legend:{bottom:0,itemWidth:12,itemHeight:6,textStyle:{color:"#cfe3ff",fontSize:10},data:["Altitude ft","Ground speed kt","Vertical rate fpm"]},xAxis:ax({type:"time",axisLabel:{fontSize:9,hideOverlap:true}}),yAxis:[ax({type:"value",axisLabel:{fontSize:9}}),ax({type:"value",axisLabel:{fontSize:9},splitLine:{show:false}})],
  series:[{name:"Altitude ft",type:"line",showSymbol:false,areaStyle:{opacity:.15},color:"#ffe14d",data:P.map(p=>[p[0],p[3]]),markPoint:{symbol:"circle",symbolSize:7,label:{show:false},data:[{coord:[P[P.length-1][0],P[P.length-1][3]]}]}},
  {name:"Ground speed kt",type:"line",yAxisIndex:1,showSymbol:false,color:C1,data:P.map(p=>[p[0],p[4]])},{name:"Vertical rate fpm",type:"line",yAxisIndex:1,showSymbol:false,color:C2,data:P.map(p=>[p[0],(p[5]||0)/10])}]});
 $("spn").textContent=P.length>=2?`Vertical profile: ${P.length} positions recorded by this server (UTC, since it began tracking this hex; max ~3 h). Not a full flight history. Dashed yellow = dead-reckoning join to the displayed marker; grey dashes = coverage gap, not flown track.`:"Vertical profile unavailable: this server has not yet stored two positions for this hex.";
 if(first)map.easeTo({center:shown,zoom:Math.max(map.getZoom(),4),padding:innerWidth>700?{right:376,top:0,left:0,bottom:0}:{top:0,left:0,right:0,bottom:120}})}
function unsel(){SEL=null;SEL_T=[];DB=null;SEL_DRAW="";closeSp();if(map&&map.getSource("sel"))map.getSource("sel").setData({type:"FeatureCollection",features:[]});gPaint();const w=$("spwx");if(w)w.innerHTML=""}
const IATA={QR:"QTR",EK:"UAE",EY:"ETD",BA:"BAW",AA:"AAL",DL:"DAL",UA:"UAL",LH:"DLH",AF:"AFR",KL:"KLM",VS:"VIR",SQ:"SIA",CX:"CPA",QF:"QFA",TK:"THY",SV:"SVA",MS:"MSR",AC:"ACA",NH:"ANA",JL:"JAL",KE:"KAL",CZ:"CSN",MU:"CES",CA:"CCA",NZ:"ANZ",AY:"FIN",SK:"SAS",LX:"SWR",OS:"AUA",IB:"IBE",AZ:"AZA",TP:"TAP",EI:"EIN",FR:"RYR",WN:"SWA",B6:"JBU",AS:"ASA",NK:"NKS",F9:"FFT",HA:"HAL",AM:"AMX",LA:"LAN",AV:"AVA",CM:"CMP",AR:"ARG",G3:"GLO",AD:"AZU",AI:"AIC",MH:"MAS",GA:"GIA",PR:"PAL",VA:"VOZ",AK:"AXM",JQ:"JST",SA:"SAA",ET:"ETH",KQ:"KQA",AT:"RAM",GF:"GFA",WY:"OMA",RJ:"RJA",ME:"MEA",KU:"KAC",PK:"PIA",UL:"ALK",TG:"THA",VN:"HVN",OZ:"AAR",BR:"EVA",CI:"CAL",HU:"CHH",LY:"ELY",DY:"NAX",W6:"WZZ",VY:"VLG",A3:"AEE",LO:"LOT",RO:"ROT",BT:"BTI",FI:"ICE",PC:"PGT",SU:"AFL",S7:"SBI",U6:"SVR",WS:"WJA",TS:"TSC",FJ:"FJI",HR:"CTN",OU:"CTN",OK:"CSA",SN:"BEL",U2:"EZY"};
function normQ(s){return String(s||"").toUpperCase().replace(/[\s\-]/g,"")}
function icaoAlias(q){const m=String(q).match(/^([A-Z]{2})([0-9A-Z]{1,6})$/);return m&&IATA[m[1]]?IATA[m[1]]+m[2]:null}
function searchPool(){
  const by=new Map();
  if(L&&L.ac)for(const x of L.ac){const rg=(x[9]||"").trim();if(x[0]&&rg)REG_BY_HEX[x[0]]=rg;by.set(x[0],{hex:x[0],cs:x[1]||"",al:x[2]||"",typ:x[3]||"",lat:x[4],lon:x[5],reg:rg,gnd:!!x[10],held:false,src:"live",age:x[11],st:x[10]?"ground":"airborne"})}
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
  const mf=$("mf").value, ty=$("tyf").value.trim().toUpperCase();
  const hideAl=mf!=="all"&&((mf==="other"&&["QTR","UAE"].includes(a.al))||(mf!=="other"&&a.al!==mf));
  const hideTy=ty&&!(a.typ||"").toUpperCase().startsWith(ty);
  if(hideAl){$("mf").value="all";notes.push("Airline filter set to All so this aircraft is visible.")}
  if(hideTy){$("tyf").value="";notes.push("Type filter cleared so this aircraft is visible.")}
  return notes;
}
function pickSearch(i){
  const a=QHits[i];if(!a)return;
  const notes=revealFor(a);
  hideQres();
  const go=()=>{drawLive();select(a.hex);if(notes.length&&$("qnote")){$("qnote").hidden=false;$("qnote").textContent=notes.join(" ")}else if($("qnote"))$("qnote").hidden=true};
  if(a.src==="live"&&APT!=="G"){setApt("G");setTimeout(go,500)}
  else if(a.apt&&a.src==="ground"&&APT!==a.apt&&APTC[a.apt]){setApt(a.apt);setTimeout(go,500)}
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

function srcNote(db,hi){const h=hi?`${hi.oi}→${hi.di} (${hi.n}/${hi.tot} past flights)`:null;
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

// Airport ground view (DOH/DXB): satellite basemap at airport zoom + ground aircraft from /api/ground.
const APTC={DOH:[51.6081,25.2731],DXB:[55.3644,25.2528]};let APT="G",GT=null;
function gIcon(){const c=document.createElement("canvas");c.width=c.height=32;const x=c.getContext("2d");x.fillStyle="#fff";x.strokeStyle="#000";x.lineWidth=2;x.beginPath();x.moveTo(16,2);x.lineTo(28,28);x.lineTo(16,22);x.lineTo(4,28);x.closePath();x.stroke();x.fill();return x.getImageData(0,0,32,32)}
function gSetup(){if(map.getSource("sat"))return;const b=map.getStyle().layers.find(l=>l.type==="symbol"||l.id==="cov");
 map.addSource("sat",{type:"raster",tiles:["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],tileSize:256,maxzoom:19,attribution:"Imagery © Esri, Maxar, Earthstar Geographics"});
 map.addLayer({id:"sat",type:"raster",source:"sat",minzoom:10,layout:{visibility:"none"},paint:{"raster-opacity":.75,"raster-brightness-max":.7,"raster-saturation":-.3}},b&&b.id);
 map.addImage("gac",gIcon(),{sdf:true});map.addSource("gnd",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
 map.addLayer({id:"gnd",type:"symbol",source:"gnd",layout:{"icon-image":"gac","icon-size":.6,"icon-rotate":["get","tr"],"icon-rotation-alignment":"map","icon-allow-overlap":true,"text-field":["get","cs"],"text-size":11,"text-offset":[0,1.3],"text-allow-overlap":false,"text-optional":true,"text-font":["Open Sans Regular"],visibility:"none"},paint:{"icon-color":["case",["==",["get","s"],1],"#ffffff",["match",["get","st"],"parked","#9aa6b8","taxi","#ffc400","#ff4d6d"]],"icon-opacity":["match",["get","mode"],"held",.4,1],"icon-halo-color":"#000","icon-halo-width":["case",["==",["get","s"],1],2.6,1],"text-color":["match",["get","mode"],"held","#9aa6b8","#fff"],"text-opacity":["match",["get","mode"],"held",.7,1],"text-halo-color":"#000","text-halo-width":1.2}});
 map.addLayer({id:"gnd-reg",type:"symbol",source:"gnd",minzoom:11,filter:["all",["has","reg"],["!=",["get","s"],1]],layout:{visibility:"none","text-field":["get","reg"],"text-size":11,"text-offset":[1.25,0],"text-anchor":"left","text-font":["Open Sans Regular"],"text-optional":true,"text-allow-overlap":false,"text-ignore-placement":false},paint:{"text-color":"#e6f1ff","text-halo-color":"#05070d","text-halo-width":1.5}});
 map.addLayer({id:"gnd-reg-sel",type:"symbol",source:"gnd",minzoom:11,filter:["all",["has","reg"],["==",["get","s"],1]],layout:{visibility:"none","text-field":["get","reg"],"text-size":12,"text-offset":[1.3,0],"text-anchor":"left","text-font":["Open Sans Regular"],"text-allow-overlap":true,"text-ignore-placement":true},paint:{"text-color":"#fff","text-halo-color":"#05070d","text-halo-width":1.8}});
 map.on("click","gnd",e=>{const h=e.features[0].properties.h;if(h)select(h)});
 map.on("mouseenter","gnd",()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave","gnd",()=>map.getCanvas().style.cursor="")}
function setApt(a){APT=a;localStorage.apt=a;document.querySelectorAll("#aps button").forEach(b=>b.classList.toggle("on",b.dataset.a===a));if(!map)return;gSetup();const g=a!=="G";
 ["sat","gnd"].forEach(l=>map.setLayoutProperty(l,"visibility",g?"visible":"none"));$("gp").style.display=g?"block":"none";clearInterval(GT);
 if(g){map.flyTo({center:APTC[a],zoom:innerWidth<700?12.6:13.4,speed:2});gLoad();GT=setInterval(gLoad,30000)}else map.flyTo({center:[35,28],zoom:innerWidth<700?1.1:2,speed:2});applyTrackVis();applyRegLab()}
async function gLoad(){const a=APT;if(a==="G")return;const j=await fetch("/api/ground?apt="+a).then(r=>r.json()).catch(()=>null);if(!j||a!==APT)return;
 const all=$("gall").checked,r=j.ac.filter(x=>all||x[2]==="QTR"||x[2]==="UAE"),live=r.filter(x=>x[11]!=="held"),held=r.filter(x=>x[11]==="held");
 GND_AC=j.ac;gPaint(r);
 $("gpt").textContent=`${a} (${j.name}): ${live.length} live · ${held.length} held last ground position${all?"":" (QTR/UAE)"} · ${j.time_utc.slice(11,19)} UTC${j.error?" · feed: "+j.source:""}`;
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
  map.addSource("wxmet",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"wxmet",type:"circle",source:"wxmet",minzoom:2.2,layout:{visibility:wxOn("met")?"visible":"none"},paint:{"circle-radius":["interpolate",["linear"],["zoom"],2,3,6,6],"circle-color":["match",["get","fltCat"],"VFR","#7cff6b","MVFR","#3aa0ff","IFR","#ff5a36","LIFR","#ff2fd6","#8aa0bf"],"circle-stroke-width":1,"circle-stroke-color":"#05070d"}});
  map.addLayer({id:"wxmet-lab",type:"symbol",source:"wxmet",minzoom:4.2,layout:{visibility:wxOn("met")?"visible":"none","text-field":["get","icao"],"text-size":10,"text-offset":[0,1.1],"text-font":["Open Sans Regular"],"text-optional":true},paint:{"text-color":"#e6f1ff","text-halo-color":"#05070d","text-halo-width":1.2}});
  const pop=html=>new maplibregl.Popup({maxWidth:"320px"}).setHTML(`<div style="color:#000;font:12px/1.4 sans-serif">${html}</div>`);
  map.on("click","wxhaz-fill",e=>{const p=e.features[0].properties;pop(wxHazHtml(p)).setLngLat(e.lngLat).addTo(map)});
  map.on("click","wxhaz-line",e=>{const p=e.features[0].properties;pop(wxHazHtml(p)).setLngLat(e.lngLat).addTo(map)});
  map.on("click","wxmet",e=>{const p=e.features[0].properties;pop(wxMetHtml(p)).setLngLat(e.lngLat).addTo(map)});
  map.on("click","wxwnd",e=>{const p=e.features[0].properties;pop(wxWndHtml(p)).setLngLat(e.lngLat).addTo(map)});
  ["wxhaz-fill","wxhaz-line","wxmet","wxwnd"].forEach(l=>{map.on("mouseenter",l,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",l,()=>map.getCanvas().style.cursor="")});
}
function wxHazHtml(p){
  const kind=p.product==="isigmet"?"International SIGMET":p.product==="airsigmet"?"US SIGMET":p.product==="gairmet"?"US G-AIRMET (CONUS-only advisory, not a SIGMET)":esc(p.product||"Advisory");
  return `<b>${esc(p.origLabel||p.seriesId||p.hazard||"Advisory")}</b><br><i>Advisory · not a measured observation · not live turbulence</i><br>${esc(kind)}<br>${p.rawHeader?esc(p.rawHeader)+"<br>":""}${p.firName||p.fir?esc(p.firName||p.fir)+"<br>":""}${p.issueTime?`Issued ${utcShort(p.issueTime)}<br>`:""}Valid ${utcShort(p.validFrom)} → ${utcShort(p.validTo)}${p.top!=null?`<br>Top ${esc(p.top)} ft`:""}<br><span style="white-space:pre-wrap">${esc(p.raw||"")}</span><br><i>Not for operational flight planning. NOAA/NWS AWC / origin agency. Times UTC.</i>`}
function wxWndHtml(p){
  return `<b>GFS forecast winds aloft</b> (model forecast, not an observation)<br>${esc(p.hpa)} hPa · valid ${utcShort(p.valid)} · cycle ${utcShort(p.cycle)} · F${esc(p.fh)}<br>${esc(p.kt)} kt from ${esc(p.from)}°${p.tC!=null?` · ${esc(p.tC)} °C`:""}<br><i>NOAA GFS 1.0° subset via NOMADS grib filter. Not WAFS. Not for operational flight planning. Times UTC.</i>`}
function wxMetHtml(p){
  const taf=WX.st&&WX.st.taf&&WX.st.taf.find(t=>t.icao===p.icao);
  return `<b>METAR · measured observation</b><br>${esc(p.icao)} ${esc(p.name||"")}<br>${p.obsTime?esc(String(p.obsTime).replace("T"," ").slice(0,16))+" UTC":""}${p.fltCat?" · "+esc(p.fltCat):""}<br><code>${esc(p.raw||"")}</code>${taf?`<br><b>TAF · terminal forecast</b><br>Issued ${esc(String(taf.issueTime||"").replace("T"," ").slice(0,16))} UTC<br>Valid ${esc(String(taf.validFrom||"").slice(0,16))} → ${esc(String(taf.validTo||"").slice(0,16))}<br><code>${esc(taf.raw||"")}</code>`:"<br>TAF unavailable for this station in the current cache."}<br><i>Not for operational flight planning. NOAA/NWS AWC.</i>`}
function wxStatus(msg,err){
  const el=$("wxst");if(!el)return;
  const bits=[];
  if(msg)bits.push(msg);
  if(wxOn("haz")&&WX.haz){
    if(WX.haz.error)bits.push(WX.haz.error);
    else bits.push(`${WX.haz.counts&&WX.haz.counts.current||0} current advisories`+(WX.haz.expiredOmitted?` · ${WX.haz.expiredOmitted} expired omitted`:"" )+(WX.haz.stale?" · stale cache":""));
  }
  if(wxOn("met")&&WX.st){
    if(WX.st.error)bits.push(WX.st.error);
    else bits.push(`${(WX.st.metar||[]).length} METARs / ${(WX.st.taf||[]).length} TAFs`);
  }
  if(wxOn("wnd")){
    const w=WX.wnd;
    if(!w) bits.push("Loading GFS winds…");
    else if(w.available) bits.push(`GFS winds ${w.cycle_utc?w.cycle_utc.replace("T"," ").slice(0,16)+" UTC cycle":""} · forecast, not observed`);
    else bits.push("Forecast winds aloft unavailable: "+(w.reason||"no GFS grid").split(". ")[0]+".");
  }
  if(!bits.length){el.hidden=true;el.textContent="";return}
  el.hidden=false;el.classList.toggle("err",!!(err||(wxOn("haz")&&WX.haz&&WX.haz.error)||(wxOn("met")&&WX.st&&WX.st.error)||(wxOn("wnd")&&WX.wnd&&!WX.wnd.available)));
  el.textContent=bits.join(" · ")+" Not for operational flight planning. NOAA/NWS AWC. Times UTC.";
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
  const nlon=(w.lons||[]).length;
  for(let j=0;j<(w.lats||[]).length;j++) for(let i=0;i<nlon;i++){
    const k=j*nlon+i, u=rec.u[k], v=rec.v[k];
    if(u==null||v==null)continue;
    const spd=Math.sqrt(u*u+v*v), kt=Math.round(spd*1.94384);
    let to=Math.atan2(u,v)*180/Math.PI; if(to<0)to+=360;
    const from=(to+180)%360;
    feats.push({type:"Feature",properties:{kt,dir:Math.round(to),from:Math.round(from),hpa:lev,fh,valid:rec.valid_utc,cycle:rec.cycle_utc,tC:rec.tC?rec.tC[k]:null},geometry:{type:"Point",coordinates:[w.lons[i],w.lats[j]]}});
  }
  map.getSource("wxwnd").setData({type:"FeatureCollection",features:feats});
  applyWxVis();
}
function wxDrawMetar(){
  if(!map||!map.getSource("wxmet"))return;
  const rows=(WX.st&&WX.st.metar)||[];
  map.getSource("wxmet").setData({type:"FeatureCollection",features:rows.filter(m=>typeof m.lat==="number"&&typeof m.lon==="number").map(m=>({type:"Feature",properties:{icao:m.icao,name:m.name||"",fltCat:m.fltCat||"",raw:m.raw||"",obsTime:m.obsTime||""},geometry:{type:"Point",coordinates:[m.lon,m.lat]}}))});
}
function wxExtraIcao(){
  const a=SEL&&selAc(), {od}=a?routeEnds(a.cs||""):{};
  const iata={DOH:"OTHH",DXB:"OMDB",AUH:"OMAA",LHR:"EGLL",JFK:"KJFK",CDG:"LFPG",FRA:"EDDF",SIN:"WSSS",BKK:"VTBS",HKG:"VHHH",BOM:"VABB",DEL:"VIDP",SYD:"YSSY",MEL:"YMML",NRT:"RJAA",HND:"RJTT"};
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
  const [lon,lat]=dispLonLat(a.lat,a.lon,a.gs,a.trk,a.gnd||a.held);
  const {od}=routeEnds(a.cs);
  let rem=null;
  if(od&&typeof od.d.lat==="number") rem=typeof gc==="function"?gc([lat,lon],[od.d.lat,od.d.lon]):null;
  const needHaz=true, needSt=true;
  if(needHaz&&!WX.haz&&!WX.load.haz)wxLoad("haz");
  if(needSt&&!WX.st&&!WX.load.st)wxLoad("st");
  if(wxOn("wnd")&&!WX.wnd&&!WX.load.wnd)wxLoad("wnd");
  const h=WX.haz, st=WX.st, wnd=WX.wnd;
  let body="";
  body+=`<div class="spsec"><h3>En-route weather ${tg("na","Not operational")}</h3>`;
  if(!h) body+=`<p class="mu">Loading hazard advisories…</p>`;
  else if(h.error&&!(h.features&&h.features.features&&h.features.features.length)) body+=`<p class="mu warn">${esc(h.error)} This is an upstream/cache error, not a finding of no hazards.</p>`;
  else {
    const hit=wxHits(lon,lat,rem);
    const near=hit.at.slice(0,4);
    const route=hit.along.filter(f=>!hit.at.includes(f)).slice(0,4);
    if(h.stale) body+=`<p class="mu">Hazard cache is stale. ${esc(h.error||"")}</p>`;
    if(near.length) body+=`<p><b>Advisories at displayed position</b> (SIGMET/G-AIRMET polygons, not live turbulence)</p>`+near.map(f=>wxAdvLine(f)).join("");
    else body+=`<p class="mu">No current SIGMET/G-AIRMET polygon in this overlay contains the displayed position. That is not a clearance and is not “no weather”.</p>`;
    if(route.length) body+=`<p><b>Provisional remaining-route intersections</b> (estimated great-circle to destination, <em>not</em> a filed plan)</p>`+route.map(f=>wxAdvLine(f)).join("");
    else if(rem) body+=`<p class="mu">No current advisory polygon in this overlay intersects the estimated remaining great-circle. Intersections are provisional because the remaining route is not a filed flight plan.</p>`;
    else body+=`<p class="mu">Remaining-route intersection unavailable: destination is unknown, so there is no estimated great-circle.</p>`;
    if(h.counts) body+=`<p class="mu">${h.counts.current} current advisories in overlay · ${h.expiredOmitted||0} expired omitted · ${h.at?("fetched "+h.at.replace("T"," ").slice(0,16)+" UTC"):""}</p>`;
  }
  body+=wxStationBlock(st,od,lat,lon,a);
  body+=wxWindBlock(wnd,a,lat,lon);
  body+=`<p class="mu">Not for operational flight planning. NOAA/NWS Aviation Weather Center; origin meteorological authorities. Hide tracks does not change weather layers. Times UTC.</p></div>`;
  el.innerHTML=body;
}
function wxAdvLine(f){
  const p=f.properties||{};
  const prod=p.product==="isigmet"?"International SIGMET":p.product==="airsigmet"?"US SIGMET":p.product==="gairmet"?"US G-AIRMET":"Advisory";
  return `<div class="chip"><span>${esc(prod)} · advisory</span>${esc(p.origLabel||((p.hazard||"")+(p.qualifier?" "+p.qualifier:"")))}<div class="mu">${esc(p.rawHeader||p.firName||p.coverage||"")}${p.issueTime?`<br>Issued ${utcShort(p.issueTime)}`:""}<br>Valid ${utcShort(p.validFrom)} → ${utcShort(p.validTo)}</div></div>`;
}
function wxWindBlock(w,a,lat,lon){
  if(!w) return `<p class="mu">Forecast winds aloft: enable the toggle to load NOAA GFS (1° subset). Not loaded yet.</p>`;
  if(!w.available) return `<div class="scg">${na("Forecast winds aloft")}</div><p class="mu">${esc(w.reason||"Unavailable.")} This is not a finding of calm winds.</p>`;
  const alt=a&&!a.gnd&&!a.held?a.alt:null;
  const hpaWant=alt==null?300:alt>35000?200:alt>25000?300:alt>14000?500:850;
  const levs=w.levels||[];
  const hpa=levs.reduce((b,x)=>Math.abs(x-hpaWant)<Math.abs(b-hpaWant)?x:b, levs[0]||300);
  const fh=(w.times&&w.times[0]&&w.times[0].fh)||6;
  const rec=w.fields&&w.fields[fh+":"+hpa];
  if(!rec||!w.lats||!w.lons) return `<div class="scg">${na("Forecast winds aloft")}</div><p class="mu">GFS field ${hpa} hPa F${fh} is not in the decoded subset.</p>`;
  let bi=0,bj=0,bd=1e9;
  for(let j=0;j<w.lats.length;j++) for(let i=0;i<w.lons.length;i++){const d=(w.lats[j]-lat)**2+(w.lons[i]-lon)**2;if(d<bd){bd=d;bi=i;bj=j}}
  const k=bj*w.lons.length+bi, u=rec.u[k], v=rec.v[k];
  if(u==null||v==null) return `<div class="scg">${na("Forecast winds aloft")}</div><p class="mu">No GFS sample at this location (outside the 1° subset box).</p>`;
  const spd=Math.sqrt(u*u+v*v), kt=Math.round(spd*1.94384);
  let to=Math.atan2(u,v)*180/Math.PI; if(to<0)to+=360;
  const tC=rec.tC&&rec.tC[k];
  return `<div class="scg">${cell("GFS winds aloft (forecast)",`${hpa} hPa · ${kt} kt from ${Math.round((to+180)%360)}°${tC!=null?" · "+tC+" °C":""}<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">Nearest ${w.step_deg}° sample to displayed position · valid ${utcShort(rec.valid_utc)} · cycle ${utcShort(rec.cycle_utc)} F${fh}${alt==null?"":" · level from displayed altitude, not a sounding"}</div>`)}</div><p class="mu">NOAA GFS 1.0° via NOMADS grib filter (simple packing). Forecast, not a measured wind. Not WAFS and not live turbulence.</p>`;
}
function wxStationBlock(st,od,lat,lon,a){
  if(!st) return `<p class="mu">Loading METAR/TAF…</p>`;
  if(st.error&&!(st.metar&&st.metar.length)) return `<p class="mu">${esc(st.error)} Observation/forecast error, not “no weather”.</p>`;
  const want=[];
  const iata={DOH:"OTHH",DXB:"OMDB",AUH:"OMAA",LHR:"EGLL",JFK:"KJFK",CDG:"LFPG",FRA:"EDDF",SIN:"WSSS"};
  if(od){const o=od.o&&(od.o.icao||iata[od.oi]), d=od.d&&(od.d.icao||iata[od.di]); if(o)want.push(["Origin",o]); if(d)want.push(["Destination",d])}
  if(a&&(a.gnd||a.held)&&a.apt==="DOH")want.push(["Airport","OTHH"]);
  if(a&&(a.gnd||a.held)&&a.apt==="DXB")want.push(["Airport","OMDB"]);
  const rows=st.metar||[];
  let nearest=null, nd=1e9;
  for(const m of rows){if(typeof m.lat!=="number")continue;const d=hv(lat,lon,m.lat,m.lon);if(d<nd){nd=d;nearest=m}}
  if(nearest&&nd<250&&!want.some(w=>w[1]===nearest.icao)) want.push([`Nearest in cache (${Math.round(nd)} nm)`, nearest.icao]);
  if(!want.length&&nearest) want.push(["Nearest in cache", nearest.icao]);
  if(!want.length) return `<p class="mu">No METAR in the cached hub set for this position.</p>`;
  return want.map(([lab,id])=>{
    const m=rows.find(x=>x.icao===id), t=(st.taf||[]).find(x=>x.icao===id);
    const obs=m?cell(lab+" METAR (measured)",`${esc(id)} · ${esc(m.fltCat||"cat n/a")}<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">${esc(m.raw||"")}<br>${utcShort(m.obsTime)}</div>`):na(lab+" METAR (measured)");
    const fc=t?cell(lab+" TAF (forecast)",`${esc(id)}<div class="mu" style="margin:4px 0 0;font-size:11px;text-transform:none;letter-spacing:0">${esc(t.raw||"")}<br>Valid ${utcShort(t.validFrom)} → ${utcShort(t.validTo)}</div>`):na(lab+" TAF (forecast)");
    return `<div class="scg">${obs}${fc}</div>`;
  }).join("");
}
function syncWx(){
  ["haz","met","wnd"].forEach(k=>{const id={haz:"wxhaz",met:"wxmet",wnd:"wxwnd"}[k];if($(id))$(id).checked=wxOn(k);if(wxOn(k))wxLoad(k==="met"?"st":k)});
  applyWxVis();wxStatus();
}
