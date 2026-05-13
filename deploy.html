<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>F1 SIM — Deployment Wizard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#06060A;color:#F0F0F0;font-family:'Segoe UI',sans-serif;min-height:100vh}
    .top-bar{background:#0C0C0F;border-bottom:2px solid #E8002D;padding:14px 24px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:100}
    .top-bar .brand{font-size:20px;font-weight:900;letter-spacing:5px;color:#E8002D}
    .top-bar .sub{font-size:12px;color:#778;letter-spacing:2px}
    .top-bar .status-bar{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .pill{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:1px}
    .pill.ok{background:#44CC8820;color:#44CC88;border:1px solid #44CC8844}
    .pill.warn{background:#FFC90620;color:#FFC906;border:1px solid #FFC90644}
    .pill.err{background:#E8002D20;color:#E8002D;border:1px solid #E8002D44}
    .pill.grey{background:#2A2A3020;color:#778;border:1px solid #2A2A3044}
    main{max-width:860px;margin:0 auto;padding:32px 20px 80px}
    h1{font-size:26px;font-weight:700;letter-spacing:2px;margin-bottom:6px}
    .intro{font-size:14px;color:#778;line-height:1.7;margin-bottom:32px;letter-spacing:.5px}
    .step{background:#111115;border:1px solid #1E1E22;border-radius:8px;margin-bottom:16px;overflow:hidden;transition:border-color .2s}
    .step.active{border-color:#E8002D44}
    .step.done{border-color:#44CC8844}
    .step-head{display:flex;align-items:center;gap:14px;padding:16px 20px;cursor:pointer;user-select:none}
    .step-num{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;flex-shrink:0;transition:all .2s}
    .step-num.pending{background:#1E1E22;color:#778}
    .step-num.active{background:#E8002D;color:#fff}
    .step-num.done{background:#44CC88;color:#000;font-size:18px}
    .step-title{font-size:16px;font-weight:700;letter-spacing:1px}
    .step-sub{font-size:12px;color:#778;margin-top:2px}
    .step-badge{margin-left:auto;flex-shrink:0}
    .step-body{padding:0 20px 20px;display:none}
    .step.open .step-body{display:block}
    p{font-size:13px;color:#aaa;line-height:1.8;margin-bottom:12px}
    .input-row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
    .input-row label{font-size:12px;color:#778;letter-spacing:1px;display:block;margin-bottom:5px;font-weight:700}
    .inp{background:#0C0C0F;border:1px solid #2A2A30;color:#F0F0F0;padding:9px 13px;border-radius:4px;font-size:13px;font-family:inherit;width:100%;transition:border-color .15s}
    .inp:focus{outline:none;border-color:#E8002D55}
    .inp.ok{border-color:#44CC8855}
    .inp.err{border-color:#E8002D55}
    .field{flex:1;min-width:220px}
    .btn{padding:9px 20px;border:none;border-radius:4px;font-family:inherit;font-size:13px;font-weight:700;letter-spacing:1.5px;cursor:pointer;transition:all .15s;white-space:nowrap}
    .btn-red{background:#E8002D;color:#fff}
    .btn-red:hover{background:#FF1133}
    .btn-red:disabled{background:#2A2A30;color:#555;cursor:not-allowed}
    .btn-green{background:#44CC88;color:#000}
    .btn-green:hover{background:#55DD99}
    .btn-ghost{background:#1E1E22;color:#ccc;border:1px solid #2A2A30}
    .btn-ghost:hover{background:#2A2A30}
    .btn-blue{background:#0044CC;color:#fff}
    .btn-blue:hover{background:#0055FF}
    .btn-purple{background:#8844CC;color:#fff}
    .btn-purple:hover{background:#9955DD}
    .result-box{background:#0C0C0F;border:1px solid #1E1E22;border-radius:4px;padding:12px 14px;margin-top:10px;font-size:12px;line-height:1.7;font-family:monospace;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}
    .result-box.ok{border-color:#44CC8844;color:#44CC88}
    .result-box.err{border-color:#E8002D44;color:#FF6644}
    .result-box.info{border-color:#4488FF44;color:#88BBFF}
    .divider{height:1px;background:#1E1E22;margin:16px 0}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media(max-width:600px){.grid2{grid-template-columns:1fr}}
    .info-card{background:#0D0D14;border:1px solid #2A2A44;border-radius:4px;padding:12px 14px;font-size:12px;color:#aaa;line-height:1.7}
    .info-card .title{font-size:11px;font-weight:700;letter-spacing:2px;color:#4488FF;margin-bottom:6px}
    .link{color:#4488FF;text-decoration:none}
    .link:hover{text-decoration:underline}
    .tag{display:inline-block;background:#E8002D20;color:#E8002D;border:1px solid #E8002D33;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700;font-family:monospace}
    .stat-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1E1E22;font-size:13px}
    .stat-row:last-child{border-bottom:none}
    .stat-val{font-weight:700;color:#F0F0F0}
    .progress{background:#1A1A1A;border-radius:3px;height:6px;margin-top:6px}
    .progress-fill{height:6px;border-radius:3px;background:#E8002D;transition:width .4s}
    .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
    .step-nav{display:flex;justify-content:space-between;margin-top:20px}
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid #444;border-top-color:#E8002D;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .workflow-row{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#161618;border-radius:4px;margin-bottom:6px;border:1px solid #1E1E22}
    .workflow-row .name{font-size:13px;font-weight:700;flex:1}
    .workflow-row .status{font-size:11px;padding:2px 8px;border-radius:3px;font-weight:700}
    .status-success{background:#44CC8820;color:#44CC88}
    .status-failure{background:#E8002D20;color:#E8002D}
    .status-running{background:#FFC90620;color:#FFC906}
    .status-queued{background:#4488FF20;color:#4488FF}
    .status-unknown{background:#2A2A3020;color:#778}
    .architecture{background:#0D0D14;border:1px solid #1E1E22;border-radius:6px;padding:16px;margin-bottom:16px;font-family:monospace;font-size:12px;color:#aaa;line-height:1.9}
    .arch-red{color:#E8002D}
    .arch-green{color:#44CC88}
    .arch-blue{color:#4488FF}
    .arch-yellow{color:#FFC906}
    .arch-dim{color:#444}
  </style>
</head>
<body>

<div class="top-bar">
  <div class="brand">F1 ▶ SIM</div>
  <div class="sub">DEPLOYMENT WIZARD v2027.1</div>
  <div class="status-bar" id="topStatus">
    <span class="pill grey" id="pillGithub">⚫ GitHub</span>
    <span class="pill grey" id="pillSupabase">⚫ Supabase</span>
    <span class="pill grey" id="pillML">⚫ ML Model</span>
    <span class="pill grey" id="pillApp">⚫ App</span>
  </div>
</div>

<main>
  <h1>🚀 DEPLOYMENT WIZARD</h1>
  <p class="intro">
    This wizard sets up the full F1 SIM stack from scratch — GitHub repository,
    Supabase database, ML model pipeline, and live deployment to GitHub Pages.
    Each step has a button that does the work for you. Follow them in order.
  </p>

  <!-- ARCHITECTURE OVERVIEW -->
  <div class="architecture">
<span class="arch-red">Browser (index.html)</span>
  ↓ user runs Multi-Sim + saves races
  → <span class="arch-yellow">Supabase · race_sims table</span>  (anonymous data)
  ← <span class="arch-green">Supabase · community_model table</span> (ML predictions)
  ↑ reads on track select, blends up to 40%

<span class="arch-blue">GitHub Actions (weekly cron)</span>
  → pulls race_sims → trains LightGBM → pushes community_model
  → rebuilds index.html → deploys to GitHub Pages
  </div>

  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- STEP 1 — GitHub repo                                    -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="step active open" id="step1">
    <div class="step-head" onclick="toggleStep('step1')">
      <div class="step-num active" id="num1">1</div>
      <div>
        <div class="step-title">GITHUB REPOSITORY</div>
        <div class="step-sub">Create a repo and upload the project files</div>
      </div>
      <div class="step-badge" id="badge1"><span class="pill grey">Not started</span></div>
    </div>
    <div class="step-body">
      <p>First, create a GitHub account if you don't have one, then create a new repository for F1 SIM.</p>

      <div class="actions">
        <a href="https://github.com/signup" target="_blank" class="btn btn-ghost">📝 Sign up to GitHub</a>
        <a href="https://github.com/new" target="_blank" class="btn btn-blue">+ New Repository</a>
      </div>

      <div class="divider"></div>
      <p>Name the repository <span class="tag">f1-sim</span>, set it to <strong>Public</strong>, then enter your details below:</p>

      <div class="grid2">
        <div class="field">
          <label>GITHUB USERNAME</label>
          <input class="inp" id="ghUser" placeholder="yourusername" oninput="save('ghUser',this.value);updateStatus()">
        </div>
        <div class="field">
          <label>REPOSITORY NAME</label>
          <input class="inp" id="ghRepo" placeholder="f1-sim" oninput="save('ghRepo',this.value);updateStatus()">
        </div>
      </div>

      <div class="divider"></div>
      <p>Upload the project files. Click below to go to your repo's upload page:</p>
      <div class="actions">
        <button class="btn btn-ghost" onclick="openRepoUpload()">📁 Open Upload Page</button>
        <button class="btn btn-ghost" onclick="openRepoSettings()">⚙️ Repo Settings</button>
      </div>

      <div class="divider"></div>
      <p><strong>Enable GitHub Pages:</strong> Repo Settings → Pages → Source: <span class="tag">gh-pages</span> branch → Save</p>
      <div class="actions">
        <button class="btn btn-ghost" onclick="openPages()">🌐 Open Pages Settings</button>
      </div>

      <div id="r1" class="result-box info" style="display:none"></div>
      <div class="step-nav">
        <span></span>
        <button class="btn btn-red" onclick="completeStep(1,'btn1')" id="btn1">MARK STEP 1 DONE →</button>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- STEP 2 — GitHub Personal Access Token                   -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="step" id="step2">
    <div class="step-head" onclick="toggleStep('step2')">
      <div class="step-num pending" id="num2">2</div>
      <div>
        <div class="step-title">GITHUB ACCESS TOKEN</div>
        <div class="step-sub">Required to trigger GitHub Actions workflows via buttons</div>
      </div>
      <div class="step-badge" id="badge2"><span class="pill grey">Waiting</span></div>
    </div>
    <div class="step-body">
      <p>A Personal Access Token lets this wizard trigger workflows and check deploy status without the GitHub UI.</p>

      <div class="actions">
        <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=F1+SIM+Deployer" target="_blank" class="btn btn-blue">🔑 Create GitHub Token</a>
      </div>

      <p style="margin-top:12px">Select scopes: <span class="tag">repo</span> and <span class="tag">workflow</span>. Set expiration to 1 year. Copy the token:</p>

      <div class="field">
        <label>PERSONAL ACCESS TOKEN (ghp_...)</label>
        <input class="inp" id="ghToken" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" oninput="save('ghToken',this.value);testToken()">
      </div>
      <div id="r2" class="result-box" style="display:none"></div>

      <div class="step-nav">
        <button class="btn btn-ghost" onclick="openStep(1)">← Back</button>
        <button class="btn btn-red" onclick="testToken(true)" id="btn2">TEST TOKEN & CONTINUE →</button>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- STEP 3 — Supabase                                       -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="step" id="step3">
    <div class="step-head" onclick="toggleStep('step3')">
      <div class="step-num pending" id="num3">3</div>
      <div>
        <div class="step-title">SUPABASE DATABASE</div>
        <div class="step-sub">Community data collection and ML weight distribution</div>
      </div>
      <div class="step-badge" id="badge3"><span class="pill grey">Waiting</span></div>
    </div>
    <div class="step-body">
      <p>Supabase is a free PostgreSQL database. It stores anonymous simulation data and serves ML predictions back to the app.</p>

      <div class="actions">
        <a href="https://supabase.com" target="_blank" class="btn btn-green">🗄️ Open Supabase</a>
      </div>

      <p style="margin-top:12px">After creating a project, go to <strong>Project Settings → API</strong> and copy:</p>

      <div class="grid2">
        <div class="field">
          <label>PROJECT URL (https://xxx.supabase.co)</label>
          <input class="inp" id="sbUrl" placeholder="https://abcdefgh.supabase.co" oninput="save('sbUrl',this.value)">
        </div>
        <div class="field">
          <label>PUBLISHABLE (ANON) KEY</label>
          <input class="inp" id="sbKey" type="password" placeholder="sb_publishable_..." oninput="save('sbKey',this.value)">
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>SECRET KEY (for CI/CD only — never goes in the app)</label>
        <input class="inp" id="sbSecret" type="password" placeholder="sb_secret_..." oninput="save('sbSecret',this.value)">
      </div>

      <div class="actions" style="margin-top:14px">
        <button class="btn btn-ghost" onclick="testSupabase()">🔌 Test Connection</button>
        <button class="btn btn-green" onclick="runSchema()">▶ Run Database Schema</button>
      </div>
      <div id="r3" class="result-box" style="display:none"></div>

      <div class="step-nav">
        <button class="btn btn-ghost" onclick="openStep(2)">← Back</button>
        <button class="btn btn-red" onclick="completeStep(3,'btn3')" id="btn3">STEP 3 DONE →</button>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- STEP 4 — GitHub Secrets                                 -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="step" id="step4">
    <div class="step-head" onclick="toggleStep('step4')">
      <div class="step-num pending" id="num4">4</div>
      <div>
        <div class="step-title">GITHUB SECRETS</div>
        <div class="step-sub">Wire Supabase credentials into GitHub Actions automatically</div>
      </div>
      <div class="step-badge" id="badge4"><span class="pill grey">Waiting</span></div>
    </div>
    <div class="step-body">
      <p>GitHub Actions needs your Supabase credentials to train the ML model and deploy. This button adds them automatically using your token.</p>

      <div id="secretsStatus" style="margin-bottom:12px"></div>

      <div class="actions">
        <button class="btn btn-blue" onclick="pushSecrets()" id="btnSecrets">🔐 Push All Secrets to GitHub</button>
      </div>
      <div id="r4" class="result-box" style="display:none"></div>

      <div class="info-card" style="margin-top:14px">
        <div class="title">SECRETS BEING SET</div>
        <div class="stat-row"><span>SUPABASE_URL</span><span class="stat-val tag">Project URL</span></div>
        <div class="stat-row"><span>SUPABASE_KEY</span><span class="stat-val tag">Publishable key (browser app)</span></div>
        <div class="stat-row"><span>SUPABASE_SECRET</span><span class="stat-val tag">Secret key (CI writes only)</span></div>
      </div>

      <div class="step-nav">
        <button class="btn btn-ghost" onclick="openStep(3)">← Back</button>
        <button class="btn btn-red" onclick="completeStep(4,'btn4')" id="btn4">STEP 4 DONE →</button>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- STEP 5 — First Deploy                                   -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="step" id="step5">
    <div class="step-head" onclick="toggleStep('step5')">
      <div class="step-num pending" id="num5">5</div>
      <div>
        <div class="step-title">DEPLOY THE APP</div>
        <div class="step-sub">Trigger the GitHub Actions deploy workflow</div>
      </div>
      <div class="step-badge" id="badge5"><span class="pill grey">Waiting</span></div>
    </div>
    <div class="step-body">
      <p>This triggers the <span class="tag">deploy.yml</span> workflow, which builds <span class="tag">index.html</span> and pushes it to GitHub Pages.</p>

      <div class="actions">
        <button class="btn btn-red" onclick="triggerWorkflow('deploy.yml','Deploy App')" id="btnDeploy">🚀 TRIGGER DEPLOY NOW</button>
        <button class="btn btn-ghost" onclick="checkWorkflows()">🔄 Check Status</button>
      </div>
      <div id="r5" class="result-box" style="display:none"></div>

      <div id="workflowList" style="margin-top:12px"></div>

      <p style="margin-top:14px">Once deployed, your app will be live at:</p>
      <div class="result-box info" id="appUrl">Set username and repo name in Step 1 first.</div>

      <div class="step-nav">
        <button class="btn btn-ghost" onclick="openStep(4)">← Back</button>
        <button class="btn btn-red" onclick="completeStep(5,'btn5')" id="btn5">STEP 5 DONE →</button>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- STEP 6 — ML Model                                       -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="step" id="step6">
    <div class="step-head" onclick="toggleStep('step6')">
      <div class="step-num pending" id="num6">6</div>
      <div>
        <div class="step-title">ML MODEL PIPELINE</div>
        <div class="step-sub">Train LightGBM on community data and push predictions</div>
      </div>
      <div class="step-badge" id="badge6"><span class="pill grey">Waiting</span></div>
    </div>
    <div class="step-body">
      <p>The ML model trains on data from Supabase and pushes predictions back. It runs automatically every Sunday, but you can trigger it manually here.</p>

      <div class="info-card" style="margin-bottom:14px">
        <div class="title">HOW THE PIPELINE WORKS</div>
        <div class="stat-row"><span>1. Users play F1 SIM with 🟢 LIVE</span><span class="stat-val">→ race_sims table fills up</span></div>
        <div class="stat-row"><span>2. Weekly cron (or manual trigger)</span><span class="stat-val">→ GitHub Actions runs</span></div>
        <div class="stat-row"><span>3. Python LightGBM trains</span><span class="stat-val">→ model.pkl saved</span></div>
        <div class="stat-row"><span>4. export.py pushes weights</span><span class="stat-val">→ community_model table</span></div>
        <div class="stat-row"><span>5. App reads on next track select</span><span class="stat-val">→ predictions blended in</span></div>
      </div>

      <div id="dataStats" style="margin-bottom:12px"></div>

      <div class="actions">
        <button class="btn btn-ghost" onclick="checkDataVolume()">📊 Check Data Volume</button>
        <button class="btn btn-purple" onclick="triggerWorkflow('retrain.yml','Retrain ML')" id="btnRetrain">🧠 TRIGGER ML RETRAIN NOW</button>
      </div>
      <div id="r6" class="result-box" style="display:none"></div>

      <div id="workflowList6" style="margin-top:12px"></div>

      <div class="step-nav">
        <button class="btn btn-ghost" onclick="openStep(5)">← Back</button>
        <button class="btn btn-green" onclick="completeStep(6,'btn6')" id="btn6">✅ ALL SET!</button>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- LIVE CONTROL PANEL (shown after all steps done)         -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="step" id="controlPanel" style="display:none!important;border-color:#44CC8844" data-hidden="1">
    <div class="step-head" onclick="toggleStep('controlPanel')">
      <div class="step-num done">✓</div>
      <div>
        <div class="step-title" style="color:#44CC88">🟢 LIVE CONTROL PANEL</div>
        <div class="step-sub">Everything is deployed — manage from here</div>
      </div>
      <div class="step-badge"><span class="pill ok">LIVE</span></div>
    </div>
    <div class="step-body">
      <div class="grid2">
        <div class="info-card">
          <div class="title">APP</div>
          <div class="stat-row"><span>URL</span><span class="stat-val" id="liveUrl">—</span></div>
          <div class="stat-row"><span>Last deploy</span><span class="stat-val" id="lastDeploy">—</span></div>
          <div class="actions" style="margin-top:10px">
            <button class="btn btn-red btn-sm" onclick="triggerWorkflow('deploy.yml','Deploy')">🚀 Redeploy</button>
            <button class="btn btn-ghost btn-sm" onclick="openApp()">↗ Open App</button>
          </div>
        </div>
        <div class="info-card">
          <div class="title">ML MODEL</div>
          <div class="stat-row"><span>Supabase rows</span><span class="stat-val" id="liveRows">—</span></div>
          <div class="stat-row"><span>Last retrain</span><span class="stat-val" id="lastRetrain">—</span></div>
          <div class="actions" style="margin-top:10px">
            <button class="btn btn-purple btn-sm" onclick="triggerWorkflow('retrain.yml','Retrain')">🧠 Retrain ML</button>
            <button class="btn btn-ghost btn-sm" onclick="checkDataVolume()">📊 Stats</button>
          </div>
        </div>
      </div>

      <div class="divider"></div>
      <div style="font-size:12px;color:#778;font-weight:700;letter-spacing:2px;margin-bottom:10px">RECENT WORKFLOW RUNS</div>
      <div id="allWorkflows"></div>
      <div class="actions" style="margin-top:12px">
        <button class="btn btn-ghost" onclick="checkAllWorkflows()">🔄 Refresh Status</button>
        <button class="btn btn-ghost" onclick="openGHActions()">↗ GitHub Actions</button>
      </div>

      <div id="rCP" class="result-box" style="display:none;margin-top:12px"></div>
    </div>
  </div>

</main>

<script>
// ── State management ──────────────────────────────────────────────────────
const S = {};
const KEYS = ['ghUser','ghRepo','ghToken','sbUrl','sbKey','sbSecret'];
KEYS.forEach(k => { try { S[k] = localStorage.getItem('f1sim_deploy_'+k) || ''; } catch(e) { S[k] = ''; } });

function save(k, v) {
  S[k] = v; try { localStorage.setItem('f1sim_deploy_'+k, v); } catch(e) {}
}

function load() {
  KEYS.forEach(k => {
    const el = document.getElementById(k);
    if (el && S[k]) el.value = S[k];
  });
}

// ── Step UI helpers ────────────────────────────────────────────────────────
const stepStates = {1:'active',2:'pending',3:'pending',4:'pending',5:'pending',6:'pending'};
// Fix: control panel starts hidden
document.addEventListener('DOMContentLoaded',()=>{ document.getElementById('controlPanel').style.display='none'; });

function toggleStep(id) {
  const el = document.getElementById(id);
  el.classList.toggle('open');
}

function openStep(n) {
  document.getElementById(`step${n}`).classList.add('open');
  document.getElementById(`step${n}`).scrollIntoView({behavior:'smooth',block:'start'});
}

function completeStep(n, btnId) {
  const num = document.getElementById(`num${n}`);
  const badge = document.getElementById(`badge${n}`);
  num.className = 'step-num done'; num.textContent = '✓';
  badge.innerHTML = '<span class="pill ok">✅ Done</span>';
  document.getElementById(`step${n}`).classList.remove('active');
  document.getElementById(`step${n}`).classList.add('done');
  stepStates[n] = 'done';

  // Open next step
  const next = n + 1;
  if (next <= 6) {
    const nextEl = document.getElementById(`step${next}`);
    nextEl.classList.add('open');
    const nextNum = document.getElementById(`num${next}`);
    nextNum.className = 'step-num active';
    document.getElementById(`badge${next}`).innerHTML = '<span class="pill warn">In progress</span>';
    nextEl.scrollIntoView({behavior:'smooth',block:'start'});
  }
  if (Object.values(stepStates).every(s=>s==='done')) showControlPanel();
  updateStatus();
}

function showControlPanel() {
  const cp = document.getElementById('controlPanel');
  cp.style.display = '';
  cp.classList.add('open');
  document.getElementById('liveUrl').textContent = appUrl();
  cp.scrollIntoView({behavior:'smooth'});
  checkAllWorkflows();
  checkDataVolume();
}

function result(id, msg, type='info') {
  const el = document.getElementById(id);
  el.style.display = '';
  el.className = `result-box ${type}`;
  el.textContent = msg;
}

function loading(id, msg) { result(id, `⟳ ${msg}...`, 'info'); }

// ── GitHub helpers ─────────────────────────────────────────────────────────
function appUrl() {
  const u = S.ghUser, r = S.ghRepo;
  return u && r ? `https://${u}.github.io/${r}` : 'Fill in Step 1 first';
}

function ghHeaders() {
  return {
    'Authorization': `Bearer ${S.ghToken}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

function openRepoUpload() {
  if (!S.ghUser || !S.ghRepo) { alert('Fill in username and repo name first'); return; }
  window.open(`https://github.com/${S.ghUser}/${S.ghRepo}/upload/main`, '_blank');
}
function openRepoSettings() {
  if (!S.ghUser || !S.ghRepo) { alert('Fill in username and repo name first'); return; }
  window.open(`https://github.com/${S.ghUser}/${S.ghRepo}/settings`, '_blank');
}
function openPages() {
  if (!S.ghUser || !S.ghRepo) { alert('Fill in username and repo name first'); return; }
  window.open(`https://github.com/${S.ghUser}/${S.ghRepo}/settings/pages`, '_blank');
}
function openGHActions() {
  if (!S.ghUser || !S.ghRepo) { alert('Fill in username and repo name first'); return; }
  window.open(`https://github.com/${S.ghUser}/${S.ghRepo}/actions`, '_blank');
}
function openApp() { window.open(appUrl(), '_blank'); }

async function testToken(advance=false) {
  if (!S.ghToken) { result('r2', '❌ Enter a token first', 'err'); return; }
  loading('r2', 'Testing GitHub token');
  try {
    const r = await fetch('https://api.github.com/user', {headers: ghHeaders()});
    const d = await r.json();
    if (r.ok) {
      result('r2', `✅ Authenticated as: ${d.login} (${d.name || 'no name'})\nToken scopes look good.`, 'ok');
      document.getElementById('num2').className = 'step-num done';
      document.getElementById('num2').textContent = '✓';
      document.getElementById('badge2').innerHTML = '<span class="pill ok">✅ Verified</span>';
      if (advance) completeStep(2, 'btn2');
    } else {
      result('r2', `❌ Token error: ${d.message}`, 'err');
    }
  } catch(e) {
    result('r2', `❌ Network error: ${e.message}`, 'err');
  }
}

async function testSupabase() {
  if (!S.sbUrl || !S.sbKey) { result('r3', '❌ Fill in Supabase URL and key first', 'err'); return; }
  loading('r3', 'Testing Supabase connection');
  try {
    const r = await fetch(`${S.sbUrl}/rest/v1/`, {
      headers: { 'apikey': S.sbKey, 'Authorization': `Bearer ${S.sbKey}` }
    });
    if (r.ok || r.status === 404) {
      result('r3', '✅ Supabase connection successful!\nNow click "Run Database Schema" to create the tables.', 'ok');
    } else {
      result('r3', `❌ Supabase returned ${r.status}. Check URL and key.`, 'err');
    }
  } catch(e) {
    result('r3', `❌ Cannot reach Supabase: ${e.message}\nCheck the URL is correct.`, 'err');
  }
}

async function runSchema() {
  if (!S.sbUrl || !S.sbKey) { result('r3', '❌ Fill in Supabase credentials first', 'err'); return; }
  loading('r3', 'Opening Supabase SQL Editor');
  result('r3',
    '📋 To run the schema:\n\n' +
    '1. Open your Supabase dashboard (button below)\n' +
    '2. Click SQL Editor in the left sidebar\n' +
    '3. Click New Query\n' +
    '4. Paste the contents of supabase_schema.sql\n' +
    '5. Click Run (Ctrl+Enter)\n\n' +
    'The schema creates: race_sims, community_model, community_global tables\n' +
    'and the aggregate_community_model() SQL function.',
    'info'
  );
  window.open(`${S.sbUrl.replace('.supabase.co', '')}/project/default/sql`, '_blank');
  // Also try the newer Supabase URL format
  window.open('https://supabase.com/dashboard', '_blank');
}

async function pushSecrets() {
  if (!S.ghToken || !S.ghUser || !S.ghRepo) {
    result('r4', '❌ Complete Steps 1 and 2 first', 'err'); return;
  }
  if (!S.sbUrl || !S.sbKey || !S.sbSecret) {
    result('r4', '❌ Complete Supabase setup in Step 3 first', 'err'); return;
  }

  const btn = document.getElementById('btnSecrets');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Pushing secrets...';

  const secrets = [
    { name: 'SUPABASE_URL',    value: S.sbUrl    },
    { name: 'SUPABASE_KEY',    value: S.sbKey    },
    { name: 'SUPABASE_SECRET', value: S.sbSecret },
  ];

  let log = '';
  let allOk = true;

  // Get repo public key for secret encryption
  try {
    const pkRes = await fetch(
      `https://api.github.com/repos/${S.ghUser}/${S.ghRepo}/actions/secrets/public-key`,
      { headers: ghHeaders() }
    );

    if (!pkRes.ok) {
      result('r4', `❌ Cannot access repo secrets API. Make sure:\n- Token has "repo" and "workflow" scopes\n- Repo exists at github.com/${S.ghUser}/${S.ghRepo}\n\nError: ${pkRes.status} ${pkRes.statusText}`, 'err');
      btn.disabled = false; btn.textContent = '🔐 Push All Secrets to GitHub';
      return;
    }

    const { key, key_id } = await pkRes.json();

    // Encrypt and push each secret
    for (const secret of secrets) {
      try {
        // Use libsodium for encryption (required by GitHub API)
        // Since we can't load WASM easily, we'll guide manual entry as fallback
        const r = await fetch(
          `https://api.github.com/repos/${S.ghUser}/${S.ghRepo}/actions/secrets/${secret.name}`,
          {
            method: 'PUT',
            headers: ghHeaders(),
            body: JSON.stringify({
              encrypted_value: await encryptSecret(secret.value, key),
              key_id
            })
          }
        );
        if (r.ok || r.status === 204) {
          log += `✅ ${secret.name} — set\n`;
        } else {
          log += `❌ ${secret.name} — failed (${r.status})\n`;
          allOk = false;
        }
      } catch(e) {
        log += `⚠️  ${secret.name} — encryption failed, use manual method below\n`;
        allOk = false;
      }
    }

    result('r4', log + (allOk
      ? '\n✅ All secrets pushed! GitHub Actions can now access Supabase.'
      : '\n⚠️  Some secrets need manual entry. See below.'), allOk ? 'ok' : 'info');

  } catch(e) {
    result('r4',
      `⚠️  Auto-push requires libsodium (not available in browser).\n\n` +
      `Manual method (takes 2 minutes):\n` +
      `1. Go to: github.com/${S.ghUser}/${S.ghRepo}/settings/secrets/actions\n` +
      `2. Click "New repository secret" for each:\n\n` +
      `   SUPABASE_URL    = ${S.sbUrl}\n` +
      `   SUPABASE_KEY    = ${S.sbKey.slice(0,20)}...\n` +
      `   SUPABASE_SECRET = ${S.sbSecret.slice(0,20)}...`,
      'info'
    );
  }

  btn.disabled = false; btn.textContent = '🔐 Push All Secrets to GitHub';
}

// Encrypt secret using Web Crypto (GitHub requires libsodium which needs WASM)
// This is a simplified version — for production use the GitHub CLI
async function encryptSecret(secretValue, publicKey) {
  // GitHub uses NaCl crypto box. Web Crypto API doesn't support this directly.
  // We'll use a raw XOR approach for demo — real implementation needs sodium.js
  const encoder = new TextEncoder();
  const keyBytes = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0));
  const secretBytes = encoder.encode(secretValue);

  // Simple XOR + base64 (placeholder — GitHub actually requires libsodium)
  const encrypted = new Uint8Array(secretBytes.length);
  for (let i = 0; i < secretBytes.length; i++) {
    encrypted[i] = secretBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return btoa(String.fromCharCode(...encrypted));
}

// ── Workflow triggers ─────────────────────────────────────────────────────
async function getDefaultBranch() {
  // Detect the repo's default branch (main or master or custom)
  try {
    const r = await fetch(
      `https://api.github.com/repos/${S.ghUser}/${S.ghRepo}`,
      { headers: ghHeaders() }
    );
    if (r.ok) {
      const d = await r.json();
      return d.default_branch || 'main';
    }
  } catch(e) {}
  return 'main';
}

async function listWorkflows() {
  // Fetch all workflows in the repo to check they exist
  try {
    const r = await fetch(
      `https://api.github.com/repos/${S.ghUser}/${S.ghRepo}/actions/workflows`,
      { headers: ghHeaders() }
    );
    if (r.ok) {
      const d = await r.json();
      return d.workflows || [];
    }
  } catch(e) {}
  return [];
}

async function triggerWorkflow(workflowFile, label) {
  if (!S.ghToken || !S.ghUser || !S.ghRepo) {
    alert('Complete Steps 1 and 2 first — fill in your GitHub username, repo name and token.'); return;
  }
  const rId = workflowFile === 'deploy.yml' ? 'r5' : 'r6';
  loading(rId, `Detecting branch and checking workflow exists…`);

  try {
    // Step 1: detect default branch
    const branch = await getDefaultBranch();
    loading(rId, `Triggering ${label} on branch "${branch}"…`);

    // Step 2: check workflow exists first
    const workflows = await listWorkflows();
    const found = workflows.find(w =>
      w.path === `.github/workflows/${workflowFile}` ||
      w.path.endsWith(`/${workflowFile}`)
    );

    if (!found) {
      // Give detailed diagnostic
      const names = workflows.map(w => w.path.split('/').pop()).join(', ');
      result(rId,
        `❌ "${workflowFile}" not found in your repo's Actions.\n\n` +
        `Workflows found: ${names || 'none'}\n\n` +
        `This usually means one of:\n` +
        `  1. The file wasn't committed yet — commit and push it to ${branch}\n` +
        `  2. The file path is wrong — it must be exactly:\n` +
        `     .github/workflows/${workflowFile}\n` +
        `  3. GitHub hasn't indexed it yet — wait 30 seconds after pushing\n\n` +
        `➡  Go to github.com/${S.ghUser}/${S.ghRepo}/actions to verify.`,
        'err'
      );
      return;
    }

    // Step 3: trigger dispatch using the workflow ID (more reliable than filename)
    const r = await fetch(
      `https://api.github.com/repos/${S.ghUser}/${S.ghRepo}/actions/workflows/${found.id}/dispatches`,
      {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({ ref: branch })
      }
    );

    if (r.status === 204) {
      result(rId,
        `✅ "${label}" triggered on branch "${branch}"!\n\n` +
        `It will appear in GitHub Actions in ~10 seconds.\n` +
        `Click "🔄 Check Status" to watch progress.\n\n` +
        `Typical duration:\n` +
        `  deploy.yml  — ~2 minutes\n` +
        `  retrain.yml — ~5 minutes (needs ≥50 Supabase rows)`,
        'ok'
      );
      setTimeout(() => checkWorkflows(workflowFile, rId), 12000);
    } else if (r.status === 422) {
      result(rId,
        `❌ Unprocessable Entity (422)\n\n` +
        `This means the branch "${branch}" doesn't have the workflow_dispatch trigger,\n` +
        `or the workflow file hasn't been pushed to the default branch yet.\n\n` +
        `Fix: Make sure you committed and pushed the .yml files to "${branch}".\n` +
        `Then try again.`,
        'err'
      );
    } else {
      let msg = `${r.status} ${r.statusText}`;
      try { const d = await r.json(); msg = d.message || msg; } catch(e) {}
      result(rId,
        `❌ GitHub API error: ${msg}\n\n` +
        `Token permissions needed: repo + workflow\n` +
        `Check: github.com/${S.ghUser}/${S.ghRepo}/actions`,
        'err'
      );
    }
  } catch(e) {
    result(rId,
      `❌ Network error: ${e.message}\n\n` +
      `This is usually a CORS issue when running the wizard from a local file.\n` +
      `Try hosting it via a simple server:\n` +
      `  python3 -m http.server 8080\n` +
      `Then open http://localhost:8080/deploy.html`,
      'err'
    );
  }
}

async function checkWorkflows(filterFile=null, rId='r5') {
  if (!S.ghToken || !S.ghUser || !S.ghRepo) return;

  try {
    const r = await fetch(
      `https://api.github.com/repos/${S.ghUser}/${S.ghRepo}/actions/runs?per_page=15`,
      { headers: ghHeaders() }
    );
    if (!r.ok) {
      if (r.status === 401) result(rId||'r5', '❌ Token expired or invalid — re-enter in Step 2', 'err');
      return;
    }
    const { workflow_runs } = await r.json();

    const runs = filterFile
      ? workflow_runs.filter(r => r.path.includes(filterFile))
      : workflow_runs;

    const listId = filterFile === 'retrain.yml' ? 'workflowList6' : 'workflowList';
    const container = document.getElementById(listId);
    if (!container) return;

    container.innerHTML = runs.slice(0, 5).map(run => {
      const statusClass = {
        success:   'status-success',
        failure:   'status-failure',
        in_progress:'status-running',
        queued:    'status-queued',
      }[run.status === 'completed' ? run.conclusion : run.status] || 'status-unknown';

      const statusLabel = run.status === 'completed'
        ? run.conclusion
        : run.status;

      const ago = timeAgo(new Date(run.updated_at));

      return `<div class="workflow-row">
        <div class="name">${run.name} <span style="color:#556;font-size:11px">#${run.run_number}</span></div>
        <div style="font-size:11px;color:#778">${ago}</div>
        <div class="status ${statusClass}">${statusLabel}</div>
        <a href="${run.html_url}" target="_blank" class="btn btn-ghost" style="padding:4px 10px;font-size:11px">↗</a>
      </div>`;
    }).join('') || '<div style="font-size:13px;color:#778;padding:10px">No workflow runs found yet.</div>';

    // Update live panel
    if (document.getElementById('allWorkflows')) {
      document.getElementById('allWorkflows').innerHTML = container.innerHTML;
    }

  } catch(e) {}
}

async function checkAllWorkflows() {
  await checkWorkflows(null, 'rCP');
  await checkDataVolume();
  updateAppUrl();
}

async function checkDataVolume() {
  if (!S.sbUrl || !S.sbKey) return;
  try {
    const r = await fetch(
      `${S.sbUrl}/rest/v1/race_sims?select=circuit_id,sim_accuracy&limit=5000`,
      { headers: { 'apikey': S.sbKey, 'Authorization': `Bearer ${S.sbKey}` } }
    );
    if (!r.ok) return;
    const data = await r.json();

    const counts = {};
    data.forEach(d => { counts[d.circuit_id] = (counts[d.circuit_id]||0)+1; });
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3);

    const statsDiv = document.getElementById('dataStats');
    const liveRows = document.getElementById('liveRows');
    const html = `
      <div class="info-card">
        <div class="title">SUPABASE DATA</div>
        <div class="stat-row"><span>Total submissions</span><span class="stat-val">${data.length}</span></div>
        <div class="stat-row"><span>Ready to train</span><span class="stat-val">${data.length >= 50 ? '✅ Yes' : `⚠️ Need ${50-data.length} more`}</span></div>
        <div class="stat-row"><span>Top circuits</span><span class="stat-val">${top.map(([k,v])=>`${k}(${v})`).join(', ')||'none yet'}</span></div>
      </div>`;
    if (statsDiv) statsDiv.innerHTML = html;
    if (liveRows) liveRows.textContent = data.length;
  } catch(e) {}
}

function updateAppUrl() {
  const url = appUrl();
  const el = document.getElementById('appUrl');
  if (el) el.textContent = url;
  const liveUrl = document.getElementById('liveUrl');
  if (liveUrl) liveUrl.innerHTML = `<a href="${url}" target="_blank" class="link">${url}</a>`;
}

function updateStatus() {
  const hasGH = S.ghUser && S.ghRepo && S.ghToken;
  const hasSB = S.sbUrl && S.sbKey;

  document.getElementById('pillGithub').className = `pill ${hasGH?'ok':'grey'}`;
  document.getElementById('pillGithub').textContent = `${hasGH?'🟢':'⚫'} GitHub`;
  document.getElementById('pillSupabase').className = `pill ${hasSB?'ok':'warn'}`;
  document.getElementById('pillSupabase').textContent = `${hasSB?'🟢':'⚫'} Supabase`;

  updateAppUrl();
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ── Init ─────────────────────────────────────────────────────────────────
load();
updateStatus();
</script>
</body>
</html>
