// Live map: FR24-style aircraft layer, trails, selection panel, real flown tracks. Data: adsb.lol (ODbL).
let SEL=null,TR={},CSR=null,TK=null,prof=null,lastFrame=0;
const AMB="#ffc400",GND="#8a94a6",ALTC=["interpolate",["linear"],["get","alt"],0,"#9aa4b2",1000,"#ff5a36",10000,"#ffb000",20000,"#c6ff3a",30000,"#00e5ff",40000,"#b06bff"];
const R2=Math.PI/180,hv=(a,b,c,d)=>{const x=Math.sin((c-a)*R2/2)**2+Math.cos(a*R2)*Math.cos(c*R2)*Math.sin((d-b)*R2/2)**2;return 2*3440.065*Math.asin(Math.sqrt(Math.min(1,x)))};
function plane(){const s=48,c=document.createElement("canvas");c.width=c.height=s;const x=c.getContext("2d");x.fillStyle="#fff";x.beginPath();
 const p=[[24,2],[27,8],[27,19],[45,29],[45,33],[27,27],[27,38],[33,43],[33,46],[24,43],[15,46],[15,43],[21,38],[21,27],[3,33],[3,29],[21,19],[21,8]];p.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();return x.getImageData(0,0,s,s)}
function acF(){const mf=$("mf").value,ty=$("tyf").value.trim().toUpperCase(),now=Date.now(),age=L&&L.at?Math.min(90,(now-new Date(L.at))/1000):0;
 return (L?L.ac:[]).filter(a=>(mf==="all"||(mf==="other"?!["QTR","UAE"].includes(a[2]):a[2]===mf))&&(!ty||(a[3]||"").toUpperCase().startsWith(ty))).map(a=>{let lon=a[5],lat=a[4];
  if(!a[10]&&a[7]>40){const d=a[7]*age/3600/60,t=a[8]*R2;lat+=d*Math.cos(t);lon+=d*Math.sin(t)/Math.cos(lat*R2)} // dead reckoning between refreshes (estimate)
  return{type:"Feature",properties:{h:a[0],cs:a[1],a:a[2],t:a[3],alt:a[6],gs:a[7],trk:a[8],g:a[10],hl:["QTR","UAE"].includes(a[2])?1:0,s:a[0]===SEL?1:0},geometry:{type:"Point",coordinates:[lon,lat]}}})}
function drawLive(){if(!map||!map.getSource("live")||!L)return;const f=acF();map.getSource("live").setData({type:"FeatureCollection",features:f});
 if($("trl").checked){const tf=[];for(const x of f){const t=TR[x.properties.h];if(t&&t.length>1)tf.push({type:"Feature",properties:{a:x.properties.a},geometry:{type:"LineString",coordinates:[...t.slice(-12),x.geometry.coordinates]}})}map.getSource("trails").setData({type:"FeatureCollection",features:tf})}
 else map.getSource("trails").setData({type:"FeatureCollection",features:[]});if(SEL)selUpdate()}
function onPoll(){if(!L)return;for(const a of L.ac){const t=TR[a[0]]||(TR[a[0]]=[]),p=t[t.length-1];if(!p||p[0]!==a[5]||p[1]!==a[4])t.push([a[5],a[4]]);if(t.length>14)t.shift()}covDraw();
 const al=[...new Set(L.ac.map(a=>a[2]))].sort(),mf=$("mf"),v=mf.value;if(mf.options.length<4+al.length-2){mf.innerHTML=`<option value="all">All airlines</option><option value="QTR">QTR</option><option value="UAE">UAE</option><option value="other">Other airlines</option>`+al.filter(x=>!["QTR","UAE"].includes(x)).map(x=>`<option>${x}</option>`).join("");mf.value=v}drawLive()}
function initMap(){map=new maplibregl.Map({container:"map",style:"https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",center:[35,28],zoom:innerWidth<700?1.1:2,attributionControl:{compact:true}});
 map.addControl(new maplibregl.NavigationControl());
 map.on("load",async()=>{map.addImage("plane",plane(),{sdf:true});
  const cf=H.map.filter(r=>H.ap[r[1]]&&H.ap[r[2]]).map(r=>({type:"Feature",properties:{a:r[0],n:r[3],inf:r[4]||0,low:(r[3]<5||(r[4]||0)/r[3]>.5)?1:0,r:r[1]+"-"+r[2]},geometry:{type:"LineString",coordinates:gc(H.ap[r[1]],H.ap[r[2]])}}));
  map.addSource("cov",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addLayer({id:"cov",type:"fill",source:"cov",paint:{"fill-color":"#3aa0ff","fill-opacity":.09}});
  map.addSource("arcs",{type:"geojson",data:{type:"FeatureCollection",features:cf}});
  map.addLayer({id:"arcs",type:"line",source:"arcs",layout:{visibility:"none"},paint:{"line-color":["match",["get","a"],"QTR",C1,C2],"line-width":["interpolate",["linear"],["get","n"],1,.3,1600,1.4],"line-opacity":["case",["==",["get","low"],1],.12,.35],"line-dasharray":[2,2]}});
  TK=await fetch("/api/tracks").then(r=>r.json()).catch(()=>({f:[]}));
  const ts=$("tks");ts.innerHTML=`<option value="">Off</option><option value="QTR">All QTR (${TK.day})</option><option value="UAE">All UAE (${TK.day})</option>`+TK.f.map((f,i)=>[f.a+" "+f.o+"-"+f.d,i]).sort().map(([l,i])=>`<option value="${i}">${l}</option>`).join("");
  map.addSource("tk",{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addSource("tkgc",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"tkgc",type:"line",source:"tkgc",paint:{"line-color":"#ffffff","line-opacity":.45,"line-width":1,"line-dasharray":[3,3]}});
  map.addLayer({id:"tk",type:"line",source:"tk",paint:{"line-color":["match",["get","a"],"QTR",C1,C2],"line-width":1.1,"line-opacity":.6}});
  map.addSource("trails",{type:"geojson",lineMetrics:true,data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"trails",type:"line",source:"trails",paint:{"line-width":1.6,"line-gradient":["interpolate",["linear"],["line-progress"],0,"rgba(255,196,0,0)",1,"rgba(255,196,0,.75)"]}});
  map.addSource("sel",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"sel-rem",type:"line",source:"sel",filter:["==",["get","k"],"rem"],paint:{"line-color":"#ffffff","line-width":1.6,"line-dasharray":[2,2],"line-opacity":.8}});
  map.addLayer({id:"sel-flown",type:"line",source:"sel",filter:["==",["get","k"],"flown"],paint:{"line-color":"#ffe14d","line-width":3}});
  map.addLayer({id:"sel-ap",type:"circle",source:"sel",filter:["==",["get","k"],"ap"],paint:{"circle-radius":5,"circle-color":"#0b1222","circle-stroke-color":"#fff","circle-stroke-width":2}});
  map.addLayer({id:"sel-apl",type:"symbol",source:"sel",filter:["==",["get","k"],"ap"],layout:{"text-field":["get","n"],"text-size":12,"text-offset":[0,1.2],"text-font":["Open Sans Regular"]},paint:{"text-color":"#fff","text-halo-color":"#000","text-halo-width":1}});
  map.addSource("live",{type:"geojson",data:{type:"FeatureCollection",features:[]},cluster:true,clusterMaxZoom:3,clusterRadius:40});
  map.addLayer({id:"cl",type:"circle",source:"live",filter:["has","point_count"],paint:{"circle-color":"rgba(255,196,0,.25)","circle-stroke-color":AMB,"circle-stroke-width":1,"circle-radius":["interpolate",["linear"],["get","point_count"],2,10,300,26]}});
  map.addLayer({id:"cln",type:"symbol",source:"live",filter:["has","point_count"],layout:{"text-field":["get","point_count_abbreviated"],"text-size":11,"text-font":["Open Sans Regular"]},paint:{"text-color":"#fff"}});
  map.addLayer({id:"live",type:"symbol",source:"live",filter:["!",["has","point_count"]],layout:{"icon-image":"plane","icon-size":["interpolate",["linear"],["zoom"],3,["case",["==",["get","hl"],1],.42,.32],8,["case",["==",["get","hl"],1],.7,.55]],"icon-rotate":["get","trk"],"icon-rotation-alignment":"map","icon-allow-overlap":true,"icon-ignore-placement":true,"symbol-sort-key":["get","hl"]},
   paint:{"icon-color":AMB,"icon-halo-color":"#000","icon-halo-width":["case",["==",["get","s"],1],0,.6]}});
  colorMode();
  map.on("click","cl",e=>{const c=e.features[0];map.getSource("live").getClusterExpansionZoom(c.properties.cluster_id).then(z=>map.easeTo({center:c.geometry.coordinates,zoom:z}))});
  map.on("click","live",e=>select(e.features[0].properties.h));
  map.on("click","arcs",e=>{const p=e.features[0].properties;new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<span style="color:#000">${p.a} ${p.r}: ${fmt(p.n)} flights${p.inf?` (${p.inf} with one end inferred)`:""}${p.low?" · low confidence":""}</span>`).addTo(map)});
  ["live","cl","arcs"].forEach(l=>{map.on("mouseenter",l,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",l,()=>map.getCanvas().style.cursor="")});
  CSR=await fetch("/api/csroute").then(r=>r.json()).catch(()=>null);
  const tick=()=>{if(Date.now()-lastFrame>1000){lastFrame=Date.now();drawLive()}requestAnimationFrame(tick)};tick();onPoll();covDraw()})}
function colorMode(){if(!map.getLayer("live"))return;const m=$("cm").value;
 map.setPaintProperty("live","icon-color",["case",["==",["get","s"],1],"#ffffff",["==",["get","g"],1],GND,m==="alt"?ALTC:["match",["get","a"],"QTR",C1,"UAE",C2,AMB]]);
 $("lgc").innerHTML=m==="alt"?`<b>Altitude</b> <i style="background:#ff5a36"></i>&lt;10k <i style="background:#ffb000"></i>10–20k <i style="background:#c6ff3a"></i>20–30k <i style="background:#00e5ff"></i>30–40k <i style="background:#b06bff"></i>40k+ ft`:`<i style="background:${C1}"></i>QTR <i style="background:${C2}"></i>UAE <i style="background:${AMB}"></i>other airlines`}
function tkDraw(){const v=$("tks").value;let f=v===""?[]:(v==="QTR"||v==="UAE")?TK.f.filter(x=>x.a===v):[TK.f[+v]];
 map.getSource("tk").setData({type:"FeatureCollection",features:f.map(x=>({type:"Feature",properties:{a:x.a},geometry:{type:"MultiLineString",coordinates:x.seg}}))});
 const g=f.length===1&&H.ap[f[0].o]&&H.ap[f[0].d]?[{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:gc(H.ap[f[0].o],H.ap[f[0].d])}}]:[];map.getSource("tkgc").setData({type:"FeatureCollection",features:g});
 $("tki").textContent=f.length===1?`${f[0].cs} ${f[0].reg} ${f[0].t} · ${f[0].o}→${f[0].d}${f[0].inf?" (one end inferred)":""} · ${new Date(f[0].t0*1000).toISOString().slice(0,16).replace("T"," ")} UTC · gaps = no receiver coverage`:f.length?`${f.length} flights on ${TK.day}`:""}
function odOf(cs){const r=CSR&&CSR.cs[cs];if(!r)return null;const[o,d]=r[0].split("-"),A=CSR.ap;return A[o]&&A[d]?{o,d,O:A[o],D:A[d],n:r[1],tot:r[2]}:null}
async function select(h){SEL=h;DB=null;const ac0=L&&L.ac.find(x=>x[0]===h);if(ac0)fetch('/api/route?cs='+encodeURIComponent(ac0[1])).then(r=>r.json()).then(j=>{if(SEL===h){DB=j;selUpdate()}}).catch(()=>{});$("sp").style.display="block";const r=await fetch("/api/track?hex="+h+"&t="+Date.now(),{cache:"no-store"}).then(r=>r.json()).catch(()=>({points:[]}));SEL_T=r.points;selUpdate(true)}
let SEL_T=[],DB=null;
function selUpdate(first){const a=L&&L.ac.find(x=>x[0]===SEL);if(!a){unsel();return}
 const pos=[a[5],a[4]],hi=odOf(a[1]),db=DB&&DB.found?{o:DB.origin.iata||DB.origin.icao,d:DB.destination.iata||DB.destination.icao,O:[DB.origin.lat,DB.origin.lon,DB.origin.city],D:[DB.destination.lat,DB.destination.lon,DB.destination.city]}:null,od=db||hi,F=[],P=SEL_T.length?SEL_T:[[Date.now(),a[5],a[4],a[6],a[7],a[12]]];
 F.push({type:"Feature",properties:{k:"flown"},geometry:{type:"LineString",coordinates:[...P.map(p=>[p[1],p[2]]),pos]}});
 let pr="";if(od){F.push({type:"Feature",properties:{k:"rem"},geometry:{type:"LineString",coordinates:gc([a[4],a[5]],od.D)}}),F.push({type:"Feature",properties:{k:"ap",n:od.o},geometry:{type:"Point",coordinates:[od.O[1],od.O[0]]}},{type:"Feature",properties:{k:"ap",n:od.d},geometry:{type:"Point",coordinates:[od.D[1],od.D[0]]}});
  const fl=hv(od.O[0],od.O[1],a[4],a[5]),rm=hv(a[4],a[5],od.D[0],od.D[1]),pc=Math.max(0,Math.min(100,100*fl/(fl+rm))),gs=a[7]>120?a[7]:450,el=fl/gs,eta=new Date(Date.now()+rm/gs*3600e3);
  pr=`<div class="pg"><span>${od.o}<small>${od.O[2]||""}</small></span><div class="bar"><div style="width:${pc}%"></div><b style="left:${pc}%">✈</b></div><span>${od.d}<small>${od.D[2]||""}</small></span></div>
  <div class="kv"><div>Flown*<b>${fmt(Math.round(fl))} nm</b></div><div>Remaining*<b>${fmt(Math.round(rm))} nm</b></div><div>Elapsed*<b>${Math.floor(el)}h ${Math.round(el%1*60)}m</b></div><div>Time left*<b>${Math.floor(rm/gs)}h ${Math.round(rm/gs%1*60)}m</b></div><div>ETA* UTC<b>${a[10]?"—":eta.toISOString().slice(11,16)}</b></div></div>
  <p class="mu">${srcNote(db,hi)} Remaining route drawn as an estimated great circle (dashed). *Estimates: distances are great-circle; ETA = remaining ÷ current ground speed.</p>`}
 else pr=`<p class="mu">${DB?'Origin/destination unknown: adsbdb has no route for this callsign and there is no route history for it (history covers QTR/UAE only). ADS-B does not broadcast origin/destination.':'Looking up route in adsbdb…'}</p>`;
 map.getSource("sel").setData({type:"FeatureCollection",features:F});
 $("spb").innerHTML=`<div class="sh"><b style="font-size:20px">${a[1]}</b> <span class="pill">${a[2]}</span> ${a[3]||"?"} · ${a[9]||"reg ?"} · hex ${a[0]}</div>
 <div class="kv"><div>Altitude<b>${a[10]?"on ground":fmt(a[6])+" ft"}</b></div><div>Ground speed<b>${a[7]} kt</b></div><div>Vertical rate<b>${a[12]>0?"+":""}${fmt(a[12]||0)} fpm</b></div><div>Track<b>${a[8]}°</b></div><div>Position age<b>${a[11]} s</b></div></div>${pr}`;
 $("prof").style.display=P.length<2?"none":"";if(P.length>=2)ch("prof",{grid:{left:44,right:36,top:12,bottom:46},legend:{bottom:0,itemWidth:12,itemHeight:6,textStyle:{color:"#cfe3ff",fontSize:10},data:["Altitude ft","Ground speed kt","Vertical rate fpm"]},xAxis:ax({type:"time",axisLabel:{fontSize:9,hideOverlap:true}}),yAxis:[ax({type:"value",axisLabel:{fontSize:9}}),ax({type:"value",axisLabel:{fontSize:9},splitLine:{show:false}})],
  series:[{name:"Altitude ft",type:"line",showSymbol:false,areaStyle:{opacity:.15},color:"#ffe14d",data:P.map(p=>[p[0],p[3]]),markPoint:{symbol:"circle",symbolSize:7,label:{show:false},data:[{coord:[P[P.length-1][0],P[P.length-1][3]]}]}},
  {name:"Ground speed kt",type:"line",yAxisIndex:1,showSymbol:false,color:C1,data:P.map(p=>[p[0],p[4]])},{name:"Vertical rate fpm",type:"line",yAxisIndex:1,showSymbol:false,color:C2,data:P.map(p=>[p[0],(p[5]||0)/10])}]});
 $("spn").textContent=`Profile: ${P.length} positions recorded by this server (UTC, since it began tracking this aircraft; max ~3 h).`;
 if(first)map.easeTo({center:pos,zoom:Math.max(map.getZoom(),4)})}
function unsel(){SEL=null;$("sp").style.display="none";map.getSource("sel").setData({type:"FeatureCollection",features:[]})}
function search(){const q=$("qs").value.trim().toUpperCase();if(!q||!L)return;const a=L.ac.find(x=>x[1]===q||(x[9]||"").toUpperCase()===q||x[0].toUpperCase()===q)||L.ac.find(x=>x[1].startsWith(q)||(x[9]||"").toUpperCase().replace("-","").startsWith(q.replace("-","")));
 if(a){$("mf").value="all";$("tyf").value="";select(a[0])}else $("qs").style.borderColor="#ff4d4d"}

function srcNote(db,hi){const h=hi?`${hi.o}→${hi.d} (${hi.n}/${hi.tot} past flights)`:null;
 if(db&&hi)return (db.o===hi.o&&db.d===hi.d)?`Route from adsbdb.com, matches adsb.lol history ${h}.`:`Route from adsbdb.com (${db.o}→${db.d}); <b style="color:#ffb000">disagrees</b> with adsb.lol history ${h}. adsbdb routes are crowd-sourced and can be stale.`;
 if(db)return "Route from adsbdb.com (no adsb.lol history for this callsign to cross-check).";
 return DB?`adsbdb has no route for this callsign; estimated from adsb.lol history ${h}.`:`Estimated from adsb.lol history ${h}; checking adsbdb…`}
let COVT=0;async function covDraw(){if(!map||!map.getSource("cov")||Date.now()-COVT<300000)return;COVT=Date.now();const j=await fetch("/api/coverage").then(r=>r.json()).catch(()=>null);if(!j)return;
 map.getSource("cov").setData({type:"FeatureCollection",features:j.cells.map(([a,o])=>({type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[o,a],[o+2,a],[o+2,a+2],[o,a+2],[o,a]]]}}))});$("covn").textContent=`${j.cells.length} 2° cells with receptions in the last ${j.window_h} h`}
