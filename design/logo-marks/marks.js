export const G = { gold:['#FFC94A','#E08A12'], amber:['#FFB627','#E0700A'], ink:['#2A1E0C','#0D0803'] }
export const MAT = { white:['#FFFFFF','#FBF3E3','#E3CCA4'], ink:['#4E3A1C','#2A1B0A','#120B04'], gold:['#FFE38A','#F2B02A','#C9780F'] }
const grad=(id,[a,b])=>`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="64"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`
const rad=(id,[a,b,c])=>`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="20" cy="14" r="54"><stop offset="0" stop-color="${a}"/><stop offset=".48" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient>`
const B='M20 13 H34 A9 9 0 0 1 34 31 H20 Z M20 31 H34 A10 10 0 0 1 34 51 H20 Z M27 19 H34 A3 3 0 0 1 34 25 H27 Z M27 37 H34 A4 4 0 0 1 34 45 H27 Z'
export function paints(o,u){
  const sil=o.mode==='sil'
  return { sil,
    defs: sil?'':`<defs>${grad(u+'g',G[o.ground])}${rad(u+'m',MAT[o.subj])}${rad(u+'a',MAT[o.accent||'white'])}
      <filter id="${u}b" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.5"/></filter>
      <filter id="${u}h" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation=".7"/></filter></defs>`,
    ground: sil?'#fff':`url(#${u}g)`, subj: sil?'#000':`url(#${u}m)`, acc: sil?'#000':`url(#${u}a)`,
    extr: o.extr||MAT[o.subj][2],
    hole: sil?'#fff':(o.hole==='dark'?MAT.ink[1]:`url(#${u}g)`),
    tile: o.bare?'':`<rect width="64" height="64" rx="${o.rx??14}" fill="${sil?'#fff':`url(#${u}g)`}"/>`,
    shadow:(cx,cy,rx,ry)=>sil?'':`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#000" opacity=".26" filter="url(#${u}b)"/>`,
    hi:(cx,cy,rx,ry,op=.5)=>sil?'':`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" opacity="${op}" filter="url(#${u}h)"/>`,
    ao:(cx,cy,r,op=.45)=>sil?'':`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${MAT[o.subj][2]}" opacity="${op}"/>`,
  }
}
// the locomotive, as parts in its native 64 box; body/detail are paints, stroke draws a keyline pass
export function trainParts(body,detail,stroke){
  const st=stroke?` stroke="${stroke.color}" stroke-width="${stroke.w}" stroke-linejoin="round"`:''
  return `<g fill="${body}"${st}>
    <rect x="10.5" y="12.5" width="10" height="4" rx="2"/><rect x="12" y="15" width="7" height="12" rx="1.5"/>
    <rect x="33.5" y="16.5" width="21" height="4" rx="2"/><rect x="36" y="19" width="16" height="21" rx="3"/>
    <rect x="9" y="26" width="29" height="14" rx="7"/>
    <rect x="7.5" y="40" width="48" height="3.4" rx="1.7"/>
    <circle cx="30" cy="47.5" r="6"/><circle cx="16" cy="48.5" r="4.5"/><circle cx="46" cy="48.5" r="4.5"/>
  </g>`+(stroke?'':`
  <g fill="${detail}"><circle cx="30" cy="47.5" r="2.3"/><circle cx="16" cy="48.5" r="1.7"/><circle cx="46" cy="48.5" r="1.7"/></g>
  <rect x="40" y="22.5" width="9" height="8" rx="2" fill="${detail}"/>
  <g fill="${detail}"><circle cx="15.5" cy="8.5" r="4"/><circle cx="21" cy="6" r="2.6"/><circle cx="26" cy="5.2" r="1.7"/></g>`)
}
export function trainSide(o,u){
  const p=paints(o,u)
  return p.defs+p.tile+p.shadow(32,57.5,22,2.4)+trainParts(p.subj,p.acc)+p.hi(14,28.5,5.5,2.4,.38)+p.hi(40,21.5,2.4,1.4,.55)
}
export function steamPin(o,u){
  const p=paints(o,u)
  return p.defs+p.tile+p.shadow(33,59.5,8,2)+`
  <g fill="${p.subj}" stroke="${p.subj}" stroke-width="1.6" stroke-linejoin="round">
    <path d="M19.5 31 C19.5 31 21 40 33 56 C45 40 46.5 31 46.5 31 Z"/>
    <circle cx="22.5" cy="29" r="8"/><circle cx="31" cy="21" r="11"/><circle cx="42" cy="28.5" r="9"/>
  </g>
  ${p.ao(32.5,28,6.7)}<circle cx="32.5" cy="28" r="5.3" fill="${p.hole}"/>
  ${p.hi(26,15,4.6,3,.5)}`
}
export function reliefB(o,u){
  const p=paints(o,u)
  return p.defs+p.tile+p.shadow(33,59.5,15,2.4)+`
  <g transform="translate(32 32) scale(1.3) translate(-32 -32)">
    ${p.sil?'':`<path fill-rule="evenodd" d="${B}" fill="${p.extr}" transform="translate(1 1.3)"/>`}
    <path fill-rule="evenodd" d="${B}" fill="${p.subj}"/>
  </g>
  ${p.hi(21.5,13.5,4.5,3,.5)}`
}
// Round-3 flat locomotive, gold on the ink gradient (gallery #21), developed with the window, hubs and steam
export function flatTrain(o,u){
  const p=paints(o,u), body=p.sil?'#000':(o.subj==='gold'?'#F5B324':'#1A1206'), detail=p.sil?'#000':'#FFF8EC'
  return p.defs+p.tile+trainParts(body,detail)
}
