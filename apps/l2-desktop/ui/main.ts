import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

type DeviceSettings = {
  l1Url: string;
  token: string;
  intervalMs: number;
};

type LoopStatus = {
  running: boolean;
  online: boolean;
  lastClaimAt: string | null;
  lastTaskId: string | null;
  lastKind: string | null;
  lastState: string | null;
  lastSummary: string | null;
  queueHint: string | null;
  error: string | null;
  pid: number | null;
};

const DEFAULT_L1 = 'https://mastra-l1.summersmile1984.workers.dev';

const app = document.querySelector('#app')!;
app.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="brand"><span class="dot" id="dot"></span><span>Mastra Desktop</span></div>
      <span class="pill" id="runtimePill">L2 idle</span>
      <div class="spacer"></div>
      <span class="pill" id="l1Pill">L1</span>
    </header>
    <div class="main">
      <section class="chat-shell">
        <iframe class="chat-frame" id="chatFrame" title="L1 chat" allow="clipboard-read; clipboard-write"></iframe>
      </section>
      <aside class="side">
        <div class="card">
          <h2>L2 Runtime</h2>
          <div class="row"><span class="k">Status</span><span class="v" id="stRunning">—</span></div>
          <div class="row"><span class="k">Last claim</span><span class="v" id="stClaim">—</span></div>
          <div class="row"><span class="k">Runtime</span><span class="v" id="stKind">—</span></div>
          <div class="row"><span class="k">Result</span><span class="v" id="stState">—</span></div>
          <div class="row"><span class="k">Queue</span><span class="v" id="stQueue">—</span></div>
          <div class="actions">
            <button class="primary" id="btnStart">Start claim</button>
            <button class="danger" id="btnStop" disabled>Stop</button>
          </div>
          <div class="hint" id="stSummary"></div>
        </div>
        <div class="card">
          <h2>Settings</h2>
          <label class="field">L1 URL
            <input id="inpL1" type="url" placeholder="${DEFAULT_L1}" />
          </label>
          <label class="field">Device / PUSH token
            <input id="inpToken" type="password" autocomplete="off" placeholder="device pairing token" />
          </label>
          <label class="field">Poll interval (ms)
            <input id="inpInterval" type="number" min="1000" step="500" value="2000" />
          </label>
          <div class="actions">
            <button id="btnSave">Save</button>
            <button id="btnReloadChat">Reload chat</button>
          </div>
          <div class="hint">
            Token is stored in <code>~/.config/mastra-l2/device.json</code> (never shown in docs/shots).
            macOS CUA needs Screen Recording + Accessibility for <code>cua-spacesd</code>.
            <br />
            <a href="#" id="linkScreen">Screen Recording help</a> ·
            <a href="#" id="linkAccess">Accessibility help</a>
          </div>
        </div>
        <div class="card">
          <h2>Log</h2>
          <div class="log" id="log"></div>
        </div>
      </aside>
    </div>
  </div>
`;

const el = {
  dot: document.querySelector('#dot') as HTMLElement,
  runtimePill: document.querySelector('#runtimePill') as HTMLElement,
  l1Pill: document.querySelector('#l1Pill') as HTMLElement,
  chatFrame: document.querySelector('#chatFrame') as HTMLIFrameElement,
  stRunning: document.querySelector('#stRunning') as HTMLElement,
  stClaim: document.querySelector('#stClaim') as HTMLElement,
  stKind: document.querySelector('#stKind') as HTMLElement,
  stState: document.querySelector('#stState') as HTMLElement,
  stQueue: document.querySelector('#stQueue') as HTMLElement,
  stSummary: document.querySelector('#stSummary') as HTMLElement,
  btnStart: document.querySelector('#btnStart') as HTMLButtonElement,
  btnStop: document.querySelector('#btnStop') as HTMLButtonElement,
  btnSave: document.querySelector('#btnSave') as HTMLButtonElement,
  btnReloadChat: document.querySelector('#btnReloadChat') as HTMLButtonElement,
  inpL1: document.querySelector('#inpL1') as HTMLInputElement,
  inpToken: document.querySelector('#inpToken') as HTMLInputElement,
  inpInterval: document.querySelector('#inpInterval') as HTMLInputElement,
  log: document.querySelector('#log') as HTMLElement,
  linkScreen: document.querySelector('#linkScreen') as HTMLAnchorElement,
  linkAccess: document.querySelector('#linkAccess') as HTMLAnchorElement,
};

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.log.textContent = `${line}\n${el.log.textContent || ''}`.slice(0, 4000);
}

function chatUrl(l1: string) {
  const base = l1.replace(/\/$/, '');
  return `${base}/app`;
}

function applySettings(s: DeviceSettings) {
  el.inpL1.value = s.l1Url || DEFAULT_L1;
  el.inpToken.value = s.token || '';
  el.inpInterval.value = String(s.intervalMs || 2000);
  el.l1Pill.textContent = new URL(s.l1Url || DEFAULT_L1).host;
  el.chatFrame.src = chatUrl(s.l1Url || DEFAULT_L1);
}

function renderStatus(st: LoopStatus) {
  el.btnStart.disabled = st.running;
  el.btnStop.disabled = !st.running;
  el.stRunning.textContent = st.running ? (st.online ? 'online' : 'starting…') : 'stopped';
  el.stClaim.textContent = st.lastClaimAt || '—';
  el.stKind.textContent = st.lastKind || '—';
  el.stState.textContent = st.lastState || '—';
  el.stQueue.textContent = st.queueHint || '—';
  el.stSummary.textContent = st.error
    ? `Error: ${st.error}`
    : st.lastSummary
      ? st.lastSummary
      : 'Claim loop idle. Start to pull sandbox tasks from L1.';
  el.dot.className = `dot ${st.running ? (st.lastState === 'working' || st.lastKind ? 'working' : 'online') : 'offline'}`;
  el.runtimePill.textContent = st.running
    ? `L2 ${st.lastKind || 'polling'}${st.pid ? ` · pid ${st.pid}` : ''}`
    : 'L2 idle';
}

async function loadSettings() {
  const s = await invoke<DeviceSettings>('get_settings');
  applySettings(s);
  log('settings loaded');
}

async function saveSettings() {
  const s: DeviceSettings = {
    l1Url: (el.inpL1.value || DEFAULT_L1).replace(/\/$/, ''),
    token: el.inpToken.value.trim(),
    intervalMs: Math.max(1000, Number(el.inpInterval.value) || 2000),
  };
  await invoke('save_settings', { settings: s });
  applySettings(s);
  log('settings saved');
}

async function refreshStatus() {
  try {
    const st = await invoke<LoopStatus>('get_loop_status');
    renderStatus(st);
  } catch (e) {
    log(`status error: ${e}`);
  }
}

el.btnSave.addEventListener('click', () => {
  saveSettings().catch((e) => log(String(e)));
});
el.btnReloadChat.addEventListener('click', () => {
  el.chatFrame.src = chatUrl(el.inpL1.value || DEFAULT_L1);
  log('chat reloaded');
});
el.btnStart.addEventListener('click', async () => {
  try {
    await saveSettings();
    await invoke('start_claim_loop');
    log('claim loop start requested');
    await refreshStatus();
  } catch (e) {
    log(String(e));
  }
});
el.btnStop.addEventListener('click', async () => {
  try {
    await invoke('stop_claim_loop');
    log('claim loop stop requested');
    await refreshStatus();
  } catch (e) {
    log(String(e));
  }
});

el.linkScreen.addEventListener('click', async (e) => {
  e.preventDefault();
  await openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});
el.linkAccess.addEventListener('click', async (e) => {
  e.preventDefault();
  await openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

const inTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
if (inTauri) {
  loadSettings()
    .then(refreshStatus)
    .catch((e) => {
      log(String(e));
      applySettings({ l1Url: DEFAULT_L1, token: '', intervalMs: 2000 });
    });
  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 1500);
} else {
  applySettings({ l1Url: DEFAULT_L1, token: '', intervalMs: 2000 });
  renderStatus({
    running: false,
    online: false,
    lastClaimAt: null,
    lastTaskId: null,
    lastKind: null,
    lastState: null,
    lastSummary: null,
    queueHint: 'browser preview',
    error: null,
    pid: null,
  });
  log('Vite preview (no Tauri bridge)');
}
