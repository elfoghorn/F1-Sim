# 🏎️ F1 SIM — 2027 Season Simulator

A full Formula 1 season simulator with Q1/Q2/Q3 qualifying, sprint races, mental stats, good/bad track preferences, AI-powered Croft & Brundle commentary, and a full championship tracker.

---

## 🚀 Deploy to GitHub Pages (5 minutes)

### Step 1 — Create a GitHub Repository

1. Go to [github.com](https://github.com) and sign in
2. Click the **+** button (top right) → **New repository**
3. Name it something like `f1-sim` or `f1-simulator`
4. Set it to **Public**
5. Click **Create repository**

### Step 2 — Upload the file

**Option A — Via the GitHub website (easiest):**
1. On your new repo page, click **"uploading an existing file"**
2. Drag and drop `index.html` onto the page
3. Scroll down, click **Commit changes**

**Option B — Via Git:**
```bash
git init
git add index.html
git commit -m "Add F1 SIM"
git remote add origin https://github.com/YOUR_USERNAME/f1-sim.git
git push -u origin main
```

### Step 3 — Enable GitHub Pages

1. Go to your repo on GitHub
2. Click **Settings** (top tab)
3. Click **Pages** (left sidebar, under "Code and automation")
4. Under **Source**, select **Deploy from a branch**
5. Set Branch to **main** and folder to **/ (root)**
6. Click **Save**

### Step 4 — Get your URL

After about 1–2 minutes your app will be live at:
```
https://YOUR_USERNAME.github.io/f1-sim/
```

GitHub will show you the exact URL in the Pages settings once it's deployed.

---

## 🔑 Anthropic API Key (for AI Commentary)

The Croft & Brundle AI commentary requires a personal Anthropic API key.

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up / log in
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-...`)
5. In the F1 SIM app, go to **COMMENTARY** and paste it in the key field
6. Click **SAVE KEY** — it's stored in your browser's localStorage

> Your API key is **never** sent anywhere except directly to Anthropic's API. It's stored locally in your browser only.

---

## 🎮 Features

| Feature | Description |
|---|---|
| **24 Tracks** | Full 2027 season calendar |
| **Q1 / Q2 / Q3** | Proper 3-segment qualifying with eliminations |
| **⚡ Sprint Weekends** | 6 sprint tracks — China, Miami, Austria, USA, Brazil, Qatar |
| **Mental Stat** | 1–10 scale affects pace, consistency and DNF probability |
| **Good/Bad Tracks** | 3 favourite + 3 difficult circuits per driver (±5 pace) |
| **AI Commentary** | Lap-by-lap Croft & Brundle dialogue via Claude AI |
| **Stage Download** | Save each commentary stage as a PNG image |
| **Championship** | Full season points tracker with undo & reset |

---

## 🛠️ Tech

- **React 18** (loaded via CDN — no npm or build step needed)
- **Babel Standalone** (JSX transpiled in the browser)
- **Anthropic API** (claude-sonnet-4 for commentary generation)
- **HTML5 Canvas** (for PNG stage downloads)
- Single `index.html` file — no dependencies to install

---

## 📝 Notes

- The app state resets on page refresh (no backend persistence)
- First load may take 1–2 seconds while Babel compiles the JSX
- Works best on desktop (wide layout)
- All driver/team data is 2026/2027 season spec (editable in the Garage)

## 🔐 Access PIN

The app is protected by a 4-digit PIN gate.

**Default PIN: `2027`**

Enter it using the on-screen keypad or your keyboard. It's remembered for the browser session.

### Changing the PIN

Find this line near the top of the `<script>` block in `index.html`:
```js
const F1_PIN_ENC = '70727075'; // XOR(0x42) of "2027"
```

To encode a new PIN, run in your browser console:
```js
'YOUR_PIN'.split('').map(c=>(c.charCodeAt(0)^0x42).toString(16).padStart(2,'0')).join('')
```
Replace `70727075` with the result.

---

## 📱 Install as an App (PWA)

F1 SIM is a **Progressive Web App** — it can be installed and run like a native desktop app.

### How to install (GitHub Pages)
1. Open the app URL in Opera, Chrome, or Edge
2. Look for the **Install** icon in the address bar (or the ⬇ INSTALL APP button at the bottom right)
3. Click **Install** — the app gets its own desktop icon and taskbar entry
4. It opens in its own window with no browser chrome, works offline

### How to install (local file)
- Double-click `index.html` to open it directly — no server needed
- The PWA install button only appears when served over HTTPS, but the app works fully from `file://`

---

## 🔒 Code Protection

The application JavaScript is:
- **Minified** — all whitespace and comments stripped (27% smaller)
- **Mangled** — internal variable names are shortened to single characters
- **No source maps** — the original code cannot be reconstructed from the bundle

The `f1_simulator.jsx` source file contains full JSDoc comments and section headers (10 sections) for reference.

The Anthropic API key is stored in browser `localStorage` only — it is never transmitted anywhere except directly to `api.anthropic.com`.

