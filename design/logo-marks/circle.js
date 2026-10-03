import { G, MAT, paints, trainParts } from './marks.js'
// Soldiers' and Sailors' Monument, v1 as voted on: three-step base, tapered shaft, knob, small Victory.
function monumentV1(p,{x=32,y=44,h=40}={}){
  const s=h/40
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="${p.subj}">
    <rect x="-9" y="-2.8" width="18" height="2.8" rx=".7"/><rect x="-6.5" y="-5.4" width="13" height="2.9" rx=".7"/><rect x="-4.4" y="-7.8" width="8.8" height="2.6" rx=".6"/>
    <path d="M-3.6 -7.8 L3.6 -7.8 L2 -30.5 L-2 -30.5 Z"/><path d="M-3 -30.5 L3 -30.5 L2.3 -33 L-2.3 -33 Z"/>
    <circle cx="0" cy="-33.8" r="1.6"/><path d="M-1.2 -35 L1.2 -35 L.95 -38.6 L-.95 -38.6 Z"/><circle cx="0" cy="-39.5" r="1.2"/>
    <path d="M.6 -37.8 L2.5 -40.7" stroke="${p.subj}" stroke-width=".9" stroke-linecap="round"/>
  </g>${p.sil?'':`<circle cx="${x+2.8*s}" cy="${y-41.2*s}" r="${.7*s}" fill="${p.acc}"/>`}`
}
// v2: broad three-tier base, slim tapered shaft, a flared crown under the sphere, Victory with the torch
// raised and the sword down. Local height 44.6 with the base line at y=0; s=h/40.
function monument(p,{x=32,y=44,h=40}={}){
  const s=h/40, k=p.subj
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="${k}">
    <rect x="-11" y="-2.4" width="22" height="2.4" rx=".6"/>
    <rect x="-8" y="-5" width="16" height="2.8" rx=".6"/>
    <rect x="-5.2" y="-8" width="10.4" height="3.2" rx=".6"/>
    <path d="M-3.4 -8 L3.4 -8 L2.1 -29 L-2.1 -29 Z"/>
    <path d="M-3.1 -29 L3.1 -29 L2.6 -31.6 L-2.6 -31.6 Z"/>
    <rect x="-2.1" y="-33.4" width="4.2" height="1.9" rx=".4"/>
    <circle cx="0" cy="-34.6" r="1.45"/>
    <rect x="-1.1" y="-37.6" width="2.2" height="2.2" rx=".3"/>
    <path d="M-1.35 -37.6 L1.35 -37.6 L.95 -41.2 L-.95 -41.2 Z"/>
    <circle cx="0" cy="-42.3" r="1.15"/>
    <path d="M.5 -40.1 L2.4 -43.3" stroke="${k}" stroke-width=".95" stroke-linecap="round"/>
    <path d="M-.9 -39.6 L-2.1 -37" stroke="${k}" stroke-width=".7" stroke-linecap="round"/>
  </g>${p.sil?'':`<circle cx="${x+2.7*s}" cy="${y-44*s}" r="${.72*s}" fill="${p.acc}"/>`}`
}
// keyline: the ground gradient re-expressed in the group's local space, so the outline matches the tile behind it
const keyGrad=(id,[ga,gb],x,y,s)=>`<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${(0-x)/s}" y1="${(0-y)/s}" x2="${(64-x)/s}" y2="${(64-y)/s}"><stop offset="0" stop-color="${ga}"/><stop offset="1" stop-color="${gb}"/></linearGradient></defs>`
// wheelKey: 1 = full keyline on the wheels (floats above the road), 0 = none (sinks into it),
// a fraction = that share of the body keyline, which lets the wheels sit on the road with a defined edge
function train(p,{x,y,s,body,detail,keyline,ground,u,tilt=0,wheelKey=.5}){
  const b=body||p.subj, d=detail||p.acc
  let key=''
  if(keyline&&!p.sil){
    const id=u+'k', paint=`url(#${id})`, w=2.6/s
    key=keyGrad(id,ground,x,y,s)+trainBodyOnly(paint,{color:paint,w})
      +(wheelKey>0?`<g fill="${paint}" stroke="${paint}" stroke-width="${w*wheelKey}"><circle cx="30" cy="47.5" r="6"/><circle cx="16" cy="48.5" r="4.5"/><circle cx="46" cy="48.5" r="4.5"/></g>`:'')
  }
  return `<g transform="translate(${x} ${y}) scale(${s}) rotate(${tilt} 31.5 53)">${key}${trainParts(b,d)}</g>`
}
// keyline pass for the body only
function trainBodyOnly(body,stroke){
  return `<g fill="${body}" stroke="${stroke.color}" stroke-width="${stroke.w}" stroke-linejoin="round">
    <rect x="10.5" y="12.5" width="10" height="4" rx="2"/><rect x="12" y="15" width="7" height="12" rx="1.5"/>
    <rect x="33.5" y="16.5" width="21" height="4" rx="2"/><rect x="36" y="19" width="16" height="21" rx="3"/>
    <rect x="9" y="26" width="29" height="14" rx="7"/>
    <rect x="7.5" y="40" width="48" height="3.4" rx="1.7"/>
  </g>`
}
// An original boilermaker figure (not Purdue Pete): hard hat, stocky overalls, hammer over the shoulder,
// cream face with two dot eyes and a smile that only show at large sizes. Local box 34 by 42, feet on y=42.
function figParts(body,detail,stroke){
  const st=stroke?` stroke="${stroke.color}" stroke-width="${stroke.w}" stroke-linejoin="round"`:''
  const face=stroke?body:detail
  return `<g fill="${body}"${st}>
    <circle cx="13" cy="15.5" r="6" fill="${face}"/>
    ${stroke?'':`<circle cx="10.9" cy="15.3" r=".95"/><circle cx="15.1" cy="15.3" r=".95"/><path d="M11.3 18.3 Q13 19.8 14.7 18.3" fill="none" stroke="${body}" stroke-width=".8" stroke-linecap="round"/>`}
    <path d="M5 9.6 A8 8 0 0 1 21 9.6 Z"/><rect x="2.5" y="8.6" width="21" height="3" rx="1.5"/>
    <rect x="4.5" y="20.5" width="17" height="14.5" rx="5"/>
    <rect x="6.5" y="33" width="5.5" height="8" rx="2"/><rect x="14" y="33" width="5.5" height="8" rx="2"/>
    <rect x="5.5" y="39" width="7" height="3" rx="1.5"/><rect x="13.5" y="39" width="7" height="3" rx="1.5"/>
    <rect x="1.5" y="22" width="4.5" height="11" rx="2.25"/>
    <rect x="-2.25" y="-6" width="4.5" height="12" rx="2.25" transform="translate(22.5 19.5) rotate(32)"/>
    <rect x="-1.1" y="-6" width="2.2" height="12" rx="1.1" transform="translate(27 8.5) rotate(20)"/>
    <rect x="-4" y="-2" width="8" height="4" rx="1.2" transform="translate(29.5 2.5) rotate(20)"/>
  </g>`
}
export function figure(p,{x,y,s,keyline,ground,u}){
  let key=''
  if(keyline&&!p.sil){ const id=u+'k'; key=keyGrad(id,ground,x,y,s)+figParts(`url(#${id})`,`url(#${id})`,{color:`url(#${id})`,w:2.6/s}) }
  return `<g transform="translate(${x} ${y}) scale(${s})">${key}${figParts(p.subj,p.acc)}</g>`
}
// Monument Circle: plaza disc + ring in perspective, monument centred, train or figure on the front-right arc.
// o.ts train scale, o.fs figure scale, o.disc plaza opacity, o.keyline, o.twoTone, o.noTrain, o.figure, o.v1 (old monument)
export function circleA(o,u){
  const p=paints(o,u), rk=p.sil?'#000':p.subj, ts=o.ts??.4, disc=o.disc??.14, cx=o.tx??46
  const band=o.band??6, lift=o.lift??1.2
  const ry=46+8.5*Math.sqrt(1-Math.pow((cx-32)/24,2))
  const tx=cx-31.5*ts, ty=ry-53*ts+lift, fs=o.fs??.5, fx=46-13*fs, fy=ry-42*fs+lift*.7
  const tr=o.noTrain?'':o.figure?figure(p,{x:fx,y:fy,s:fs,keyline:o.keyline,ground:G[o.ground],u})
    :train(p,{x:tx,y:ty,s:ts,keyline:o.keyline,ground:G[o.ground],u,tilt:o.tilt??-12,wheelKey:o.wheelKey??.5,body:o.twoTone&&!p.sil?p.acc:undefined,detail:o.twoTone&&!p.sil?p.subj:undefined})
  const stripe=(o.stripe&&!p.sil)?`<ellipse cx="32" cy="46" rx="24" ry="8.5" fill="none" stroke="${p.ground}" stroke-width=".9" opacity=".55" stroke-dasharray="2.2 2.6"/>`:''
  const stripeFront=(o.stripe&&!p.sil)?`<path d="M8 46 A24 8.5 0 0 0 56 46" fill="none" stroke="${p.ground}" stroke-width=".9" opacity=".55" stroke-dasharray="2.2 2.6"/>`:''
  return p.defs+p.tile+p.shadow(32,60,22,2.2)+`
  ${disc&&!p.sil?`<ellipse cx="32" cy="46" rx="24" ry="8.5" fill="${p.subj}" opacity="${disc}"/>`:''}
  <ellipse cx="32" cy="46" rx="24" ry="8.5" fill="none" stroke="${rk}" stroke-width="${band}"/>${stripe}
  ${o.v1?monumentV1(p,{x:32,y:47,h:42}):monument(p,{x:32,y:47,h:38.5})}
  <path d="M8 46 A24 8.5 0 0 0 56 46" fill="none" stroke="${rk}" stroke-width="${band}"/>${stripeFront}
  ${tr}
  ${p.hi(30,23,1.3,6,.28)}`
}
// the figure alone, as a mascot mark
export function mascot(o,u){
  const p=paints(o,u), s=o.fs??1.05, x=32-16*s, y=60-42*s
  return p.defs+p.tile+p.shadow(32,60,14,2.2)+figure(p,{x,y,s,u})+p.hi(x+8*s,y+13*s,2.2*s,1.4*s,.45)
}
