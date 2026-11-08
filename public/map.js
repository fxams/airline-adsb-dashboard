// Live map: FR24-style aircraft layer, trails, selection panel, real flown tracks. Data: adsb.lol (ODbL).
let SEL=null,TR={},CSR=null,TK=null,prof=null,lastFrame=0;
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
function utcClock(ms){const d=new Date(ms);return isNaN(+d)?null:d.toISOString().slice(0,16).replace("T"," ")+" UTC"}
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
const AMB="#ffc400",GND="#8a94a6",ALTC=["interpolate",["linear"],["get","alt"],0,"#9aa4b2",1000,"#ff5a36",10000,"#ffb000",20000,"#c6ff3a",30000,"#00e5ff",40000,"#b06bff"];
const R2=Math.PI/180,hv=(a,b,c,d)=>{const x=Math.sin((c-a)*R2/2)**2+Math.cos(a*R2)*Math.cos(c*R2)*Math.sin((d-b)*R2/2)**2;return 2*3440.065*Math.asin(Math.sqrt(Math.min(1,x)))};
function plane(){const s=48,c=document.createElement("canvas");c.width=c.height=s;const x=c.getContext("2d");x.fillStyle="#fff";x.beginPath();
 const p=[[24,2],[27,8],[27,19],[45,29],[45,33],[27,27],[27,38],[33,43],[33,46],[24,43],[15,46],[15,43],[21,38],[21,27],[3,33],[3,29],[21,19],[21,8]];p.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();return x.getImageData(0,0,s,s)}
function acF(){const mf=$("mf").value,ty=$("tyf").value.trim().toUpperCase();
 return (L?L.ac:[]).filter(a=>(mf==="all"||(mf==="other"?!["QTR","UAE"].includes(a[2]):a[2]===mf))&&(!ty||(a[3]||"").toUpperCase().startsWith(ty))).map(a=>{
  const [lon,lat]=dispLonLat(a[4],a[5],a[7],a[8],a[10]);
  return{type:"Feature",properties:{h:a[0],cs:a[1],a:a[2],t:a[3],alt:a[6],gs:a[7],trk:a[8],g:a[10],hl:["QTR","UAE"].includes(a[2])?1:0,s:a[0]===SEL?1:0},geometry:{type:"Point",coordinates:[lon,lat]}}})}
function drawLive(){if(!map||!map.getSource("live")||!L)return;const f=acF();map.getSource("live").setData({type:"FeatureCollection",features:f});
 if($("trl").checked){const tf=[];for(const x of f){const t=TR[x.properties.h];if(t&&t.length>1)tf.push({type:"Feature",properties:{a:x.properties.a},geometry:{type:"LineString",coordinates:[...t.slice(-12),x.geometry.coordinates]}})}map.getSource("trails").setData({type:"FeatureCollection",features:tf})}
 else map.getSource("trails").setData({type:"FeatureCollection",features:[]});applyTrackVis();if(SEL)selUpdate()}
function onPoll(){if(!L)return;for(const a of L.ac){const t=TR[a[0]]||(TR[a[0]]=[]),p=t[t.length-1];if(!p||p[0]!==a[5]||p[1]!==a[4])t.push([a[5],a[4]]);if(t.length>14)t.shift()}covDraw();
 const al=[...new Set(L.ac.map(a=>a[2]))].sort(),mf=$("mf"),v=mf.value;if(mf.options.length<4+al.length-2){mf.innerHTML=`<option value="all">All airlines</option><option value="QTR">QTR</option><option value="UAE">UAE</option><option value="other">Other airlines</option>`+al.filter(x=>!["QTR","UAE"].includes(x)).map(x=>`<option>${x}</option>`).join("");mf.value=v}drawLive()}
function initMap(){map=new maplibregl.Map({container:"map",style:"https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",center:[35,28],zoom:innerWidth<700?1.1:2,attributionControl:{compact:true}});
 map.addControl(new maplibregl.NavigationControl());
 map.on("load",async()=>{map.addImage("plane",plane(),{sdf:true});
  const cf=H.map.filter(r=>H.ap[r[1]]&&H.ap[r[2]]).map(r=>({type:"Feature",properties:{a:r[0],n:r[3],inf:r[4]||0,low:(r[3]<5||(r[4]||0)/r[3]>.5)?1:0,r:r[1]+"-"+r[2]},geometry:{type:"LineString",coordinates:gc(H.ap[r[1]],H.ap[r[2]])}}));
  map.addSource("cov",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addLayer({id:"cov",type:"fill",source:"cov",paint:{"fill-color":"#3aa0ff","fill-opacity":.06}});map.addSource("covb",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addLayer({id:"covb",type:"line",source:"covb",layout:{"line-join":"round",visibility:localStorage.cvb==="0"?"none":"visible"},paint:{"line-color":"#5cc8ff","line-width":["interpolate",["linear"],["zoom"],1,.8,6,1.6],"line-opacity":.85}});
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
  colorMode();
  map.on("click","live",e=>select(e.features[0].properties.h));
  map.on("click","arcs",e=>{const p=e.features[0].properties;new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<span style="color:#000">${p.a} ${p.r}: ${fmt(p.n)} flights${p.inf?` (${p.inf} with one end inferred)`:""}${p.low?" · low confidence":""}</span>`).addTo(map)});
  ["live","arcs"].forEach(l=>{map.on("mouseenter",l,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",l,()=>map.getCanvas().style.cursor="")});
  CSR=await fetch("/api/csroute").then(r=>r.json()).catch(()=>null);
  const tick=()=>{if(Date.now()-lastFrame>1000){lastFrame=Date.now();drawLive()}requestAnimationFrame(tick)};tick();onPoll();covDraw();setApt(localStorage.apt||"G");applyTrackVis()})}
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
 return{hex:g[0],cs:g[1]||g[0],al:g[2],typ:g[3],lat:g[4],lon:g[5],alt:0,gs:g[7],trk:g[6],reg:"",gnd:true,age:held?(g[12]||0)*60:g[9],held,heldMin:g[12],heldUtc:g[13]||"",st:g[8]||"ground",src:"ground"}}
function alName(code,dbName){return (L&&L.nm&&code&&L.nm[code])||dbName||""}
function apBox(ap,side){if(!ap)return `<div class="ode ${side}"><div class="iata">—</div><div class="city">Unavailable</div></div>`;
 const code=ap.iata||ap.icao||"—";return `<div class="ode ${side}"><div class="iata">${esc(code)}</div><div class="city">${esc(ap.city||"")}</div><div class="an">${esc(ap.name||(ap.iata||ap.icao?"":"Unavailable"))}</div></div>`}
function routeEnds(cs){const db=DB&&DB.found?{o:{iata:DB.origin.iata||"",icao:DB.origin.icao||"",name:DB.origin.name||"",city:DB.origin.city||"",lat:DB.origin.lat,lon:DB.origin.lon},d:{iata:DB.destination.iata||"",icao:DB.destination.icao||"",name:DB.destination.name||"",city:DB.destination.city||"",lat:DB.destination.lat,lon:DB.destination.lon},oi:DB.origin.iata||DB.origin.icao,di:DB.destination.iata||DB.destination.icao}:null;
 const hi0=odOf(cs),hi=hi0?{o:{iata:hi0.o,icao:"",name:"",city:hi0.O[2]||"",lat:hi0.O[0],lon:hi0.O[1]},d:{iata:hi0.d,icao:"",name:"",city:hi0.D[2]||"",lat:hi0.D[0],lon:hi0.D[1]},oi:hi0.o,di:hi0.d,n:hi0.n,tot:hi0.tot}:null;
 return{db,hi,od:db||hi}}
async function select(h){SEL=h;DB=null;SEL_T=[];openSp();gPaint();const ac0=selAc();const cs=ac0&&ac0.cs;
 if(cs)fetch("/api/route?cs="+encodeURIComponent(cs)).then(r=>r.json()).then(j=>{if(SEL===h){DB=j;selUpdate()}}).catch(()=>{if(SEL===h){DB={found:false};selUpdate()}});
 const r=await fetch("/api/track?hex="+h+"&t="+Date.now(),{cache:"no-store"}).then(r=>r.json()).catch(()=>({points:[]}));if(SEL!==h)return;SEL_T=r.points||[];selUpdate(true)}
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
 $("spsum").textContent=`${a.cs} · ${a.gnd||a.held?"ground":fmt(a.alt)+" ft"} · ${a.held?"held":a.gs+" kt"} · ${fresh}`;
 $("sp").dataset.hex=a.hex||"";
 const chips=[a.reg?`<div class="chip"><span>Registration</span>${esc(a.reg)}</div>`:"",a.typ?`<div class="chip"><span>Aircraft type</span>${esc(a.typ)}</div>`:"",a.hex?`<div class="chip"><span>Hex</span>${esc(String(a.hex).toUpperCase())}</div>`:""].filter(Boolean).join("");
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
function unsel(){SEL=null;SEL_T=[];DB=null;SEL_DRAW="";closeSp();if(map&&map.getSource("sel"))map.getSource("sel").setData({type:"FeatureCollection",features:[]});gPaint()}
function search(){const q=$("qs").value.trim().toUpperCase();if(!q||!L)return;const a=L.ac.find(x=>x[1]===q||(x[9]||"").toUpperCase()===q||x[0].toUpperCase()===q)||L.ac.find(x=>x[1].startsWith(q)||(x[9]||"").toUpperCase().replace("-","").startsWith(q.replace("-","")));
 if(a){$("mf").value="all";$("tyf").value="";select(a[0])}else $("qs").style.borderColor="#ff4d4d"}

function srcNote(db,hi){const h=hi?`${hi.oi}→${hi.di} (${hi.n}/${hi.tot} past flights)`:null;
 if(db&&hi)return (db.oi===hi.oi&&db.di===hi.di)?`Route from adsbdb.com, matches adsb.lol history ${h}. Crowd-sourced; may be stale. Not observed on this flight.`:`Route from adsbdb.com (${db.oi}→${db.di}); <b style="color:#ffb020">disagrees</b> with adsb.lol history ${h}. adsbdb routes are crowd-sourced and can be stale. Not observed on this flight.`;
 if(db)return "Route from adsbdb.com (no adsb.lol history for this callsign to cross-check). Crowd-sourced; may be stale. Not observed on this flight.";
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
 map.addLayer({id:"gnd",type:"symbol",source:"gnd",layout:{"icon-image":"gac","icon-size":.6,"icon-rotate":["get","tr"],"icon-rotation-alignment":"map","icon-allow-overlap":true,"text-field":["get","cs"],"text-size":11,"text-offset":[0,1.3],"text-allow-overlap":false,"text-font":["Open Sans Regular"],visibility:"none"},paint:{"icon-color":["case",["==",["get","s"],1],"#ffffff",["match",["get","st"],"parked","#9aa6b8","taxi","#ffc400","#ff4d6d"]],"icon-opacity":["match",["get","mode"],"held",.4,1],"icon-halo-color":"#000","icon-halo-width":["case",["==",["get","s"],1],2.6,1],"text-color":["match",["get","mode"],"held","#9aa6b8","#fff"],"text-opacity":["match",["get","mode"],"held",.7,1],"text-halo-color":"#000","text-halo-width":1.2}});
 map.on("click","gnd",e=>{const h=e.features[0].properties.h;if(h)select(h)});
 map.on("mouseenter","gnd",()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave","gnd",()=>map.getCanvas().style.cursor="")}
function setApt(a){APT=a;localStorage.apt=a;document.querySelectorAll("#aps button").forEach(b=>b.classList.toggle("on",b.dataset.a===a));if(!map)return;gSetup();const g=a!=="G";
 ["sat","gnd"].forEach(l=>map.setLayoutProperty(l,"visibility",g?"visible":"none"));$("gp").style.display=g?"block":"none";clearInterval(GT);
 if(g){map.flyTo({center:APTC[a],zoom:innerWidth<700?12.6:13.4,speed:2});gLoad();GT=setInterval(gLoad,30000)}else map.flyTo({center:[35,28],zoom:innerWidth<700?1.1:2,speed:2});applyTrackVis()}
async function gLoad(){const a=APT;if(a==="G")return;const j=await fetch("/api/ground?apt="+a).then(r=>r.json()).catch(()=>null);if(!j||a!==APT)return;
 const all=$("gall").checked,r=j.ac.filter(x=>all||x[2]==="QTR"||x[2]==="UAE"),live=r.filter(x=>x[11]!=="held"),held=r.filter(x=>x[11]==="held");
 GND_AC=j.ac;gPaint(r);
 $("gpt").textContent=`${a} (${j.name}): ${live.length} live · ${held.length} held last ground position${all?"":" (QTR/UAE)"} · ${j.time_utc.slice(11,19)} UTC${j.error?" · feed: "+j.source:""}`;
 const row=x=>{const held=x[11]==="held",ago=held?`held ${x[12]>=60?(x[12]/60).toFixed(1)+" h":x[12]+" min"} ago`:`${x[9]} s ago`;return`<tr class="${held?"held":""}"><td>${x[1]||x[0]}</td><td>${x[3]}</td><td>${x[8]}${held?" · held":""}</td><td>${held?"–":x[7]}</td><td>${ago}</td></tr>`};
 $("gpl").innerHTML="<tr><th>Callsign</th><th>Type</th><th>Status</th><th>kt</th><th>Last seen</th></tr>"+(r.length?r.sort((p,q)=>(p[11]==="held")-(q[11]==="held")||(p[1]<q[1]?-1:1)).map(row).join(""):'<tr><td colspan="5" class="mu">No live or held ground aircraft right now.</td></tr>')}
function gPaint(r){if(!map||!map.getSource("gnd"))return;const rows=r||GND_AC.filter(x=>$("gall").checked||x[2]==="QTR"||x[2]==="UAE");
 map.getSource("gnd").setData({type:"FeatureCollection",features:rows.map(x=>({type:"Feature",properties:{h:x[0],cs:x[1]||x[0],tr:x[6],st:x[8],mode:x[11]||"live",s:x[0]===SEL?1:0},geometry:{type:"Point",coordinates:[x[5],x[4]]}}))})}
