/**
 * scripts/build.js
 * ================
 * F1 SIM 2027 — JSX compile + minify pipeline
 * 
 * Pipeline:
 *   f1_simulator.jsx
 *     → sucrase (JSX → plain JS)
 *     → esbuild --minify (strip whitespace, mangle local vars)
 *     → patch into index.html (replaces the minified app block)
 * 
 * Usage:
 *   node scripts/build.js
 *   make build
 */

const fs   = require('fs');
const path = require('path');

// ── Paths ─────────────────────────────────────────────────────────────────
const ROOT       = path.join(__dirname, '..');
const SRC        = path.join(ROOT, 'f1_simulator.jsx');
const HTML       = path.join(ROOT, 'index.html');
const TMP_COMP   = '/tmp/f1sim_compiled.js';
const TMP_MINI   = '/tmp/f1sim_minified.js';

// ── Find sucrase and esbuild ──────────────────────────────────────────────
function findModule(name) {
  const candidates = [
    path.join(ROOT, 'node_modules', '.bin', name),
    `/home/${process.env.USER || 'claude'}/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/.bin/${name}`,
    `/home/${process.env.USER || 'claude'}/.npm-global/lib/node_modules/tsx/node_modules/.bin/${name}`,
    `/home/${process.env.USER || 'claude'}/.npm-global/lib/node_modules/.bin/${name}`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findSucrase() {
  const candidates = [
    path.join(ROOT, 'node_modules', '@mermaid-js', 'mermaid-cli', 'node_modules', 'sucrase'),
    `/home/${process.env.USER || 'claude'}/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/sucrase`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  return null;
}

// ── Build ─────────────────────────────────────────────────────────────────
function build() {
  console.log('▸ Reading source...');
  let jsx = fs.readFileSync(SRC, 'utf8');

  // Strip module syntax — the bundle runs inside an IIFE in index.html, not as an ES module
  jsx = jsx.replace(/^import\s+\{[^}]+\}\s+from\s+['"]react['"];\n?/m, '');
  jsx = jsx.replace(/^export default function F1Sim\(\)/m, 'function F1Sim()');

  // Handle localStorage-initialised driver/team state (build-time injection)
  // The source has the plain useState(DRIVERS) version; inject localStorage loading
  jsx = jsx.replace(
    '  const [drivers,setDrivers]=useState(DRIVERS);\n  const [teams,setTeams]=useState(TEAMS);',
    `  const [drivers,setDrivers]=useState(()=>{try{const s=localStorage.getItem("f1sim_drivers");return s?JSON.parse(s):DRIVERS;}catch{return DRIVERS;}});
  const [teams,setTeams]=useState(()=>{try{const s=localStorage.getItem("f1sim_teams");return s?JSON.parse(s):TEAMS;}catch{return TEAMS;}});`
  );

  // Inject Anthropic API key header into commentary fetch
  jsx = jsx.replace(
    'method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514"',
    'method:"POST",headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model:"claude-sonnet-4-20250514"'
  );

  // Check champTab declarations (debug guard)
  const champTabCount = (jsx.match(/const \[champTab,setChampTab\]/g) || []).length;
  console.log(`champTab declarations: ${champTabCount} ✅`);
  if (champTabCount > 1) {
    console.error('❌ Multiple champTab declarations — check source for duplicates');
    process.exit(1);
  }

  // ── Compile JSX ─────────────────────────────────────────────────────────
  console.log('▸ Compiling JSX...');
  const sucrase = findSucrase();
  if (!sucrase) {
    console.error('❌ sucrase not found. Run: npm install @mermaid-js/mermaid-cli or npm install sucrase');
    process.exit(1);
  }

  const { code: compiled } = sucrase.transform(jsx, {
    transforms: ['jsx'],
    jsxPragma:   'React.createElement',
    jsxFragmentPragma: 'React.Fragment',
    production: true,
  });

  const patched = compiled
    .replace(/__SUPABASE_URL__/g, process.env.SUPABASE_URL || 'https://YOUR_PROJECT.supabase.co')
    .replace(/__SUPABASE_KEY__/g, process.env.SUPABASE_KEY || '');

  fs.writeFileSync(TMP_COMP, patched);
  console.log(`Compiled: ${patched.length} chars ✅`);

  // ── Minify ───────────────────────────────────────────────────────────────
  console.log('▸ Minifying...');
  const esbuild = findModule('esbuild');
  if (!esbuild) {
    console.error('❌ esbuild not found. Run: npm install esbuild');
    process.exit(1);
  }

  const { execSync } = require('child_process');
  execSync(`cat ${TMP_COMP} | ${esbuild} --minify --loader=js > ${TMP_MINI}`);
  const minified = fs.readFileSync(TMP_MINI, 'utf8');
  const ratio = ((1 - minified.length / patched.length) * 100).toFixed(0);
  console.log(`Minified: ${minified.length} bytes (${ratio}% smaller) ✅`);

  // ── Patch into index.html ────────────────────────────────────────────────
  console.log('▸ Patching index.html...');
  let html = fs.readFileSync(HTML, 'utf8');

  const START_MARKER = '/* F1 SIM 2027.1 — compiled & minified */';
  const END_MARKER   = '\n})();';

  const start = html.indexOf(START_MARKER);
  const end   = html.indexOf(END_MARKER, start) + END_MARKER.length;

  if (start < 0 || end < END_MARKER.length) {
    console.error('❌ Could not find app JS block in index.html');
    process.exit(1);
  }

  const newBlock = `/* F1 SIM 2027.1 — compiled & minified */
(function(){
'use strict';
var useState=React.useState;
${minified}
try{
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(F1Sim));
}catch(e){
document.getElementById('root').innerHTML=
'<div style="padding:40px;font-family:monospace;background:#0C0C0F;min-height:100vh">'+
'<div style="font-size:22px;font-weight:700;color:#E8002D;margin-bottom:14px">F1 SIM — ERROR</div>'+
'<pre style="font-size:13px;white-space:pre-wrap;color:#FF6644">'+e.stack+'</pre></div>';
}
})();`;

  html = html.slice(0, start) + newBlock + html.slice(end);
  fs.writeFileSync(HTML, html);

  const sizeMB = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`✅ index.html updated — ${sizeMB}KB total`);
}

build();
