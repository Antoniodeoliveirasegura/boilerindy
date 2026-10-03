// One SVG, two colourways: the light group shows by default, the dark group under prefers-color-scheme: dark.
// Works wherever the SVG is rendered as a document that evaluates media queries (tab favicons in Chromium
// and Firefox, inline SVG, most <img> contexts); PNG exports are made per scheme by the render script.
export function adaptive(fn,lightOpts,darkOpts,{rx=14}={}){
  const light=fn({...lightOpts,rx},'L_'), dark=fn({...darkOpts,rx},'D_')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<style>.dark{display:none}@media (prefers-color-scheme: dark){.light{display:none}.dark{display:inline}}</style>
<g class="light">${light}</g>
<g class="dark">${dark}</g>
</svg>
`
}
