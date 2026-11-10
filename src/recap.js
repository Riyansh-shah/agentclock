// Weekly recap: a shareable card of your time with agents. Pure, no Node imports.
// Never includes project names, prompts or rules, so it's safe to post.
import { fmt, plural } from './report.js';

function lines(s) {
  return [
    ['Agents worked', fmt(s.agentTime)],
    ['Waited for my approval', fmt(s.blockedTime)],
    ['Typical run', fmt(s.median)],
    ['Longest run', fmt(s.longest)],
    ['Most agents at once', String(s.parallel.max)],
    ['Back after it finished', s.comeback.count ? `${fmt(s.comeback.median)} median` : '-'],
  ];
}

export function formatRecapText(s, { title } = {}) {
  const heading = `agentclock · recap · ${title}`;
  if (!s.runs) return `${heading}\n\n  No finished agent runs in this period yet.`;
  const rows = lines(s);
  const inner = 42;
  const pad = (text) => `│ ${text.padEnd(inner - 2)} │`;
  return [
    heading,
    `┌${'─'.repeat(inner)}┐`,
    pad(`My AI agents · ${title}`),
    pad(''),
    ...rows.map(([k, v]) => pad(`${k.padEnd(24)}${v}`)),
    pad(''),
    pad(`${plural(s.runs, 'run')} · measured with agentclock`),
    `└${'─'.repeat(inner)}┘`,
  ].join('\n');
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A 1200x630 card (the usual social preview size). */
export function recapSvg(s, { title } = {}) {
  const rows = lines(s);
  const cells = rows.map(([label, value], i) => {
    const x = 70 + (i % 3) * 360;
    const y = 250 + Math.floor(i / 3) * 170;
    return `<text x="${x}" y="${y}" class="v">${esc(value)}</text><text x="${x}" y="${y + 42}" class="l">${esc(label)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<style>
  text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .t { fill: #f8fafc; font-size: 46px; font-weight: 700; }
  .v { fill: #fbbf24; font-size: 60px; font-weight: 700; }
  .l { fill: #94a3b8; font-size: 26px; }
  .f { fill: #64748b; font-size: 24px; }
</style>
<rect width="1200" height="630" rx="28" fill="#0f172a"/>
<text x="70" y="120" class="t">My AI agents · ${esc(title)}</text>
${cells}
<text x="70" y="585" class="f">${esc(`${plural(s.runs, 'run')} · measured with agentclock`)}</text>
</svg>`;
}

/** A page showing the card, with a button that saves it as a PNG. */
export function recapHtml(s, { title } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>agentclock recap</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; background: #e2e8f0; font-family: system-ui, sans-serif; }
  svg { max-width: 95vw; height: auto; box-shadow: 0 10px 40px rgba(0,0,0,.25); border-radius: 28px; }
  button { font-size: 16px; padding: 10px 20px; border-radius: 8px; border: 0; background: #0f172a; color: #fff; cursor: pointer; }
</style></head>
<body>
${recapSvg(s, { title })}
<button id="save">Save as PNG</button>
<script>
document.getElementById('save').onclick = () => {
  const svg = new XMLSerializer().serializeToString(document.querySelector('svg'));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 630;
    c.getContext('2d').drawImage(img, 0, 0);
    c.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'agentclock-recap.png';
      a.click();
    });
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
};
</script>
</body></html>
`;
}
