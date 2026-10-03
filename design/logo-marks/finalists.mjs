import { circleA, mascot } from './circle.js'
import { trainSide, reliefB, flatTrain } from './marks.js'
let n=0
const uid=()=>'f'+(n++)+'_'
const svg=(fn,o,s,l='')=>`<svg viewBox="0 0 64 64" width="${s}" height="${s}"${l?` role="img" aria-label="${l}"`:' aria-hidden="true"'}>${fn(o,uid())}</svg>`
const MC={ground:'gold',subj:'ink',accent:'white',keyline:true}
export const MARKS=[
  {key:'f1',tag:'F1',label:'Monument Circle with the train',was:31,fn:circleA,o:MC,og:'gold',
   why:'Best overall; strongest Boiler and Indy identity.',dev:'Monument redrawn from the real one: broader three-tier base, slimmer shaft, the crown under the sphere, Victory with the torch up. A third puff of steam trails the train.'},
  {key:'f2',tag:'F2',label:'Boilermaker Special',was:28,fn:trainSide,o:{ground:'gold',subj:'ink',accent:'white'},og:'gold',
   why:'Fun, student-focused, and very recognizable.',dev:'Unchanged apart from the trailing puff, so the locomotive is one drawing everywhere.'},
  {key:'f3',tag:'F3',label:'Relief B',was:22,fn:reliefB,o:{ground:'gold',subj:'ink',extr:'#B8720E'},og:'gold',
   why:'Cleanest and most professional-looking app icon.',dev:'Unchanged. It is also the favicon that pairs with every other finalist, since none of the pictures survive 16px.'},
  {key:'f4',tag:'F4',label:'Monument Circle with a boilermaker',was:33,fn:circleA,o:{...MC,figure:true,fs:.56},og:'gold',
   why:'Strong BoilerIndy concept and good mascot potential.',dev:'Same monument as F1. The boilermaker got two dot eyes and a smile that show from about 120px up and vanish below, so the small-size silhouette is unchanged.'},
  {key:'f5',tag:'F5',label:'Boilermaker Special, gold on ink',was:21,fn:flatTrain,o:{ground:'ink',subj:'gold'},og:'ink',
   why:'Simple, bold, and works well at small sizes.',dev:'Kept flat, no shading or shadow, but given the cab window, the wheel hubs and the steam in cream so it matches F2 detail for detail.'},
  {key:'m',tag:'Bonus',label:'The boilermaker on his own',was:null,fn:mascot,o:{ground:'gold',subj:'ink',accent:'white'},og:'gold',
   why:'Not voted on. Here because F4 drew the "mascot potential" comment.',dev:'The F4 figure at full size: a mascot for the splash screen, empty states and merch, with F1 or F4 staying the app icon.'},
]
const BI={ground:'gold',subj:'ink',extr:'#B8720E'}, BG={ground:'ink',subj:'gold',extr:'#6E4108'}
const neigh=[['#5B6473','●'],['#3F6EA6','■'],['#2F8F6A','■']]
const phone=(m,cls)=>`<div class="ph ${cls}"><div class="ic">${svg(m.fn,m.o,60)}<span>BoilerIndy</span></div>${neigh.map(([c,g])=>`<div class="ic"><i style="background:${c}">${g}</i><span>App</span></div>`).join('')}</div>`
const kit=(m)=>`<section class="kit" id="${m.key}">
<h2><b>${m.tag}</b>${m.label}${m.was?`<span class="was">was #${m.was}</span>`:''}</h2>
<p class="why">“${m.why}”</p>
<p class="dev">${m.dev}</p>
<div class="kitrow">
  <div class="big">${svg(m.fn,m.o,200,m.label)}</div>
  <div class="col"><span class="lab">At size</span><div class="sizes">${svg(m.fn,m.o,60)}${svg(m.fn,m.o,32)}${svg(m.fn,m.o,16)}</div>
    <span class="lab">Browser tab pairing</span><div class="sizes">${svg(reliefB,m.og==='ink'?BG:BI,32)}${svg(reliefB,m.og==='ink'?BG:BI,16)}<span class="cap">relief B at 32 and 16</span></div></div>
  <div class="col"><span class="lab">On a phone</span><div class="phones">${phone(m,'dk')}${phone(m,'lt')}</div></div>
</div>
<div class="kitrow2">
  <img src="logos/finalists/${m.key}-lockup.png" width="560" height="120" alt="${m.label} lockup with the BoilerIndy wordmark">
  <img src="logos/finalists/${m.key}-og.png" width="600" height="315" alt="${m.label} social preview card">
</div>
</section>`
export function html(){
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>BoilerIndy finalists</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#17140f;color:#F2ECDF;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1180px;margin:0 auto;padding:32px 16px 80px}
h1{font-size:clamp(26px,4vw,38px);margin:0 0 6px;letter-spacing:-.02em}
.sub{color:#B7A98C;margin:0 0 6px;max-width:680px}
a{color:#F5B324}
.kit{padding:30px 0;border-top:1px solid rgba(242,236,223,.12)}
h2{font-size:22px;margin:0 0 6px;letter-spacing:-.01em;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h2 b{height:26px;padding:0 9px;border-radius:13px;background:#F5B324;color:#1A1206;font-size:13px;display:inline-flex;align-items:center}
.was{font-size:13px;color:#B7A98C;font-weight:400}
.why{margin:0 0 4px;color:#F2ECDF;font-style:italic}
.dev{margin:0 0 18px;color:#B7A98C;max-width:720px}
.kitrow{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}
.kitrow2{display:flex;gap:18px;flex-wrap:wrap;margin-top:18px;align-items:flex-start}
.kitrow2 img{max-width:100%;height:auto;border-radius:14px;display:block}
.col{display:flex;flex-direction:column;gap:8px}
.lab{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#B7A98C}
.sizes{display:flex;gap:12px;align-items:flex-end;margin-bottom:8px}
.cap{font-size:12px;color:#B7A98C;align-self:center}
svg{display:block}
.phones{display:flex;gap:12px;flex-wrap:wrap}
.ph{display:grid;grid-template-columns:repeat(4,60px);gap:10px 8px;padding:14px 12px 10px;border-radius:18px}
.ph.dk{background:linear-gradient(160deg,#1B1F2A,#0B0C10);color:#fff}.ph.lt{background:linear-gradient(160deg,#E9EEF5,#CFD8E6);color:#111}
.ic{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:9.5px}
.ic i{width:60px;height:60px;border-radius:13.5px;display:flex;align-items:center;justify-content:center;font-style:normal;color:rgba(255,255,255,.85);font-size:20px}
</style>
</head>
<body>
<main>
<header>
<h1>BoilerIndy finalists</h1>
<p class="sub">Your top five, developed into full kits: the icon at every size, the browser-tab pairing, how it sits on a phone, the wordmark lockup and the social card. Reply with F1 to F5.</p>
<p class="sub"><a href="logos.html">Back to all 48 candidates</a></p>
</header>
${MARKS.map(kit).join('')}
</main>
</body>
</html>
`}
// PNG sources (rendered with the real wordmark face; the page itself cannot load web fonts)
const FONT='<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;800&display=swap" rel="stylesheet">'
export const lockupHtml=(m)=>`<!doctype html><meta charset=utf-8>${FONT}<style>body{margin:0;background:#17140f;width:560px;height:120px;display:flex;align-items:center;gap:18px;padding:0 24px;box-sizing:border-box;font-family:'Plus Jakarta Sans',sans-serif}span{font-size:46px;font-weight:800;letter-spacing:-.025em;color:#FFF8EC;line-height:1}span b{color:#F5B324;font-weight:800}</style>${svg(m.fn,m.o,72)}<span>Boiler<b>Indy</b></span>`
export const ogHtml=(m)=>{
  const gold=m.og==='gold'
  return `<!doctype html><meta charset=utf-8>${FONT}<style>body{margin:0;width:600px;height:315px;background:linear-gradient(135deg,${gold?'#FFC94A,#E08A12':'#2A1E0C,#0D0803'});display:flex;align-items:center;gap:22px;padding:0 42px;box-sizing:border-box;font-family:'Plus Jakarta Sans',sans-serif}
.copy{display:flex;flex-direction:column;gap:9px}.name{font-size:52px;font-weight:800;letter-spacing:-.03em;line-height:1;color:${gold?'#1A1206':'#FFF8EC'}}.name b{color:${gold?'#FFFFFF':'#F5B324'}}
.tag{font-size:15px;font-weight:600;color:${gold?'#3A2810':'#C9BBA0'};max-width:290px;line-height:1.4}.dom{font-size:13px;font-weight:700;letter-spacing:.04em;color:${gold?'#7A4A08':'#F5B324'}}</style>
${svg(m.fn,{...m.o,bare:true},190)}<div class="copy"><span class="name">Boiler<b>Indy</b></span><span class="tag">Your Purdue Indianapolis campus companion. Schedule, dining, transit, board, and more.</span><span class="dom">boilerindy.app</span></div>`
}
