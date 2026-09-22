const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadTokens } = require('./token-loader.js');

// ═══════════════════════════════════════════════════════════════
// بيانات الحسابات (يتم تعبئتها من GitHub في الأسفل)
// ═══════════════════════════════════════════════════════════════
let TOKEN_HOST = '';
let TOKEN_GUEST = '';
const USER_ID_HOST = 80055399;
const USER_ID_GUEST = 51660277;
const GROUP_ID = 18432094;

// ═══════════════════════════════════════════════════════════════
// الإعدادات
// ═══════════════════════════════════════════════════════════════
const MIN_WAIT_AFTER_DISCONNECT = 1500;
const MAX_WAIT_START = 40000;
const MAX_PLAY_TIME = 5 * 60 * 1000;
const POLL_INTERVAL = 200;
const MAX_LOBBY_ATTEMPTS = 3;
const WAIT_AFTER_NAVIGATE = 3000;
const WAIT_AFTER_JOIN = 1000;
const WAIT_AFTER_CLOSE = 2500;
const WAIT_AFTER_INJECT = 1000;
const WAIT_AFTER_LEAVE = 2000;

// ═══════════════════════════════════════════════════════════════
// إعدادات اللعبة
// ═══════════════════════════════════════════════════════════════
const EXPERIENCE_ID = 6;
const LOBBY_TYPE_ID = 5;
const EXPERIENCE_BUILD_VERSION = "4.8.17";
const EXPERIENCE_PATH = `/experience/xo_battles/${EXPERIENCE_BUILD_VERSION}/index.html`;

// ═══════════════════════════════════════════════════════════════
// إحداثيات النقرات
// ═══════════════════════════════════════════════════════════════
const CLICKS_GUEST = [
    { x: 200, y: 271 },
    { x: 200, y: 338 },
    { x: 200, y: 390 }
];
const CLICKS_HOST = [
    { x: 353, y: 350 },
    { x: 360, y: 397 },
    { x: 312, y: 389 }
];
const DELAY_BETWEEN_CLICKS = 40;
const DELAY_AFTER_GUEST = 60;
const DELAY_AFTER_HOST = 100;
const TARGET_CYCLE_MS = 500;

// ═══════════════════════════════════════════════════════════════
// رؤوس HTTP
// ═══════════════════════════════════════════════════════════════
const baseHeaders = {
    "Host": "experience.palringo.com",
    "Connection": "keep-alive",
    "experience-id": String(EXPERIENCE_ID),
    "experience-build-type": "release",
    "experience-build-version": EXPERIENCE_BUILD_VERSION,
    "language-id": "1",
    "user-agent": "Mozilla/5.0 (Linux; Android 13; NTH-NX9 Build/HONORNTH-N29; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.124 Mobile Safari/537.36",
    "content-type": "application/json",
    "Accept": "*/*",
    "Origin": "https://experiences.wolfservices.production.wolf.live",
    "X-Requested-With": "com.palringo.android"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function deleteTempDir(dir) {
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// API: الجلسات
// ═══════════════════════════════════════════════════════════════
async function createSession(token, name) {
    console.log(`[${name}] إنشاء الجلسة...`);
    const headers = { ...baseHeaders, "authorization": `Bearer ${token}` };
    const body = {
        experienceId: EXPERIENCE_ID,
        experienceBuildType: "release",
        experienceBuildVersion: EXPERIENCE_BUILD_VERSION,
        platform: "android",
        contextType: "group",
        contextId: GROUP_ID,
        screenState: "full",
        screenStatePreviously: "full",
        data: ""
    };
    try {
        const res = await fetch("https://experience.palringo.com/experience/session", {
            method: "POST", headers, body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.token) throw new Error("no token");
        await fetch(`https://experience.palringo.com/experience/session/token/${data.token}`, {
            method: "PUT", headers, body: JSON.stringify(body)
        });
        console.log(`[${name}] ✅ جاهزة`);
        return data.token;
    } catch (e) {
        console.error(`[${name}] خطأ:`, e.message);
        return null;
    }
}

async function deleteSession(token, st) {
    try {
        const res = await fetch(`https://experience.palringo.com/experience/session/token/${st}`, {
            method: "DELETE",
            headers: { ...baseHeaders, "authorization": `Bearer ${token}` }
        });
        return res.status === 204;
    } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════════
// API: مغادرة اللوبي من الحسابين
// ═══════════════════════════════════════════════════════════════
async function leaveFromBothAccounts(lobbyId) {
    console.log(`🚪 مغادرة ${lobbyId} من الحسابين...`);

    try {
        const r1 = await fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/user`, {
            method: "DELETE",
            headers: { ...baseHeaders, "authorization": `Bearer ${TOKEN_HOST}` }
        });
        console.log(`   [المنشئ] leave → ${r1.status}`);
    } catch (e) {}

    try {
        const r2 = await fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/user`, {
            method: "DELETE",
            headers: { ...baseHeaders, "authorization": `Bearer ${TOKEN_GUEST}` }
        });
        console.log(`   [الضيف] leave → ${r2.status}`);
    } catch (e) {}

    try {
        const r3 = await fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/close`, {
            method: "POST",
            headers: { ...baseHeaders, "authorization": `Bearer ${TOKEN_HOST}`, "content-length": "0" }
        });
        console.log(`   [المنشئ] close → ${r3.status}`);
    } catch (e) {}

    await sleep(WAIT_AFTER_LEAVE);
}

// ═══════════════════════════════════════════════════════════════
// API: إنشاء لوبي
// ═══════════════════════════════════════════════════════════════
async function createLobbyRaw(token) {
    const res = await fetch("https://experience.palringo.com/lobby", {
        method: "POST",
        headers: { ...baseHeaders, "authorization": `Bearer ${token}` },
        body: JSON.stringify({
            typeId: LOBBY_TYPE_ID,
            groupId: GROUP_ID,
            visibility: "global",
            access: "public",
            displayName: "❌ XO Battles",
            data: "",
            ownerUserData: "",
            ownerPlayerIp: "0.0.0.0"
        })
    });
    if (res.ok) {
        const data = await res.json();
        return { ok: true, id: data.id };
    }
    const text = await res.text();
    let errorData = {};
    try { errorData = JSON.parse(text); } catch (e) {}
    return { ok: false, status: res.status, error: errorData };
}

async function closeLobby(token, lobbyId) {
    const headers = { ...baseHeaders, "authorization": `Bearer ${token}`, "content-length": "0" };
    try {
        const res = await fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/close`, {
            method: "POST", headers
        });
        console.log(`🎮 close → ${res.status}`);
        return res.ok;
    } catch (e) {
        console.error("❌ close:", e.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// API: Rematch — مرة واحدة فقط + معالجة code 55
// ═══════════════════════════════════════════════════════════════
async function rematchLobby(token, lobbyId) {
    const headers = { ...baseHeaders, "authorization": `Bearer ${token}` };
    const body = JSON.stringify({ data: "", userData: "" });
    try {
        const res = await fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/rematch`, {
            method: "POST", headers, body
        });

        if (!res.ok) {
            const text = await res.text();
            let err = {};
            try { err = JSON.parse(text); } catch (e) {}

            console.log(`⚠️ Rematch فشل: ${res.status} code=${err.code} ${(err.message || '').slice(0, 100)}`);

            if (err.code === 55) {
                console.log(`💡 اللوبي ${lobbyId} مفتوح → نستخدمه مباشرة`);
                return lobbyId;
            }

            if (err.code === 5) {
                const m = (err.message || '').match(/Lobby, id (\d+)/);
                if (m && m[1] === String(lobbyId)) {
                    console.log(`💡 اللوبي ${lobbyId} هو العالق → نستخدمه`);
                    return lobbyId;
                }
            }

            return null;
        }

        const data = await res.json();
        console.log(`🔄 Rematch → ${data.id}`);
        return data.id;
    } catch (e) {
        console.error("❌ Rematch:", e.message);
        return null;
    }
}

async function joinLobby(token, lobbyId, accountName = "guest") {
    const headers = { ...baseHeaders, "authorization": `Bearer ${token}` };
    const body = JSON.stringify({ data: "", playerIp: "0.0.0.0" });
    try {
        const res = await fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/user`, {
            method: "POST", headers, body
        });
        if (res.status === 200) {
            console.log(`✅ [${accountName}] انضم إلى ${lobbyId}`);
            return true;
        }
        console.log(`⚠️ [${accountName}] فشل الانضمام: ${res.status}`);
        return false;
    } catch (e) {
        console.error(`❌ [${accountName}] joinLobby:`, e.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// إنشاء لوبي ذكي
// ═══════════════════════════════════════════════════════════════
async function createLobbySmart(token, oldLobbyId = null) {
    if (oldLobbyId) {
        console.log(`🔄 Rematch (مرة واحدة) على ${oldLobbyId}...`);
        const newId = await rematchLobby(token, oldLobbyId);
        if (newId) {
            return { id: newId, usedRematch: true };
        }

        console.log(`⚠️ Rematch فشل → مغادرة فورية من الحسابين`);
        await leaveFromBothAccounts(oldLobbyId);
    }

    for (let i = 1; i <= MAX_LOBBY_ATTEMPTS; i++) {
        console.log(`📄 محاولة إنشاء لوبي ${i}/${MAX_LOBBY_ATTEMPTS}...`);
        const result = await createLobbyRaw(token);

        if (result.ok) {
            console.log(`✅ لوبي جديد: ${result.id}`);
            return { id: result.id, usedRematch: false };
        }

        const errorMsg = result.error?.message || '';
        const m = errorMsg.match(/Lobby, id (\d+)/);
        const stuckId = m ? m[1] : null;

        if (stuckId && errorMsg.includes('already in')) {
            console.log(`⚠️ عالق في ${stuckId} → مغادرة فورية`);
            await leaveFromBothAccounts(stuckId);
        } else {
            console.log(`⚠️ محاولة ${i}: ${result.status} ${errorMsg.slice(0, 80)}`);
            await sleep(2000);
        }
    }

    console.log(`❌ فشل إنشاء لوبي`);
    return null;
}

// ═══════════════════════════════════════════════════════════════
// المتصفح
// ═══════════════════════════════════════════════════════════════
async function navigateToLobby(page, token, lobbyId) {
    await page.setExtraHTTPHeaders({
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://experiences.wolfservices.production.wolf.live',
        'X-Requested-With': 'com.palringo.android'
    });
    const url = `https://experiences.wolfservices.production.wolf.live${EXPERIENCE_PATH}?groupId=${GROUP_ID}&lobbyId=${lobbyId}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
}

async function navigateToMainPage(page, token) {
    await page.setExtraHTTPHeaders({
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://experiences.wolfservices.production.wolf.live',
        'X-Requested-With': 'com.palringo.android'
    });
    const url = `https://experiences.wolfservices.production.wolf.live${EXPERIENCE_PATH}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
}

// ═══════════════════════════════════════════════════════════════
// WS Monitor
// ═══════════════════════════════════════════════════════════════
async function installWebSocketMonitor(page) {
    await page.evaluateOnNewDocument(() => {
        window.__gameMonitor = {
            startTime: Date.now(),
            connectTime: null,
            disconnectTime: null,
            connectCount: 0,
            disconnectCount: 0,
            recvCount: 0,
            sendCount: 0,
            connected: false,
            allWsUrls: []
        };
        const OrigWS = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            const M = window.__gameMonitor;
            const isGameWs = /edgegap\.net/i.test(url);

            M.allWsUrls.push({ url, isGameWs, t: Date.now() });
            console.log(`🔌 ${isGameWs ? '🎮 GAME' : '⚙️ LOBBY'}: ${url.slice(0, 60)}...`);

            const ws = new OrigWS(url, protocols);

            ws.addEventListener('open', () => {
                if (!isGameWs) return;
                M.connectTime = Date.now();
                M.connectCount++;
                M.connected = true;
                console.log(`🎮 [${((Date.now()-M.startTime)/1000).toFixed(1)}s] WS اللعبة متصل #${M.connectCount}`);
            });

            ws.addEventListener('close', (e) => {
                if (!isGameWs) return;
                M.disconnectTime = Date.now();
                M.disconnectCount++;
                M.connected = false;
                console.log(`🏁 [${((Date.now()-M.startTime)/1000).toFixed(1)}s] WS اللعبة انفصل #${M.disconnectCount} code=${e.code}`);
            });

            ws.addEventListener('message', () => {
                if (!isGameWs) return;
                M.recvCount++;
            });

            const origSend = ws.send.bind(ws);
            ws.send = function(data) {
                if (!isGameWs) return origSend(data);
                M.sendCount++;
                return origSend(data);
            };

            return ws;
        };
        for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = OrigWS[k];
        window.WebSocket.prototype = OrigWS.prototype;
    });
}

async function getMonitor(page) {
    try {
        return await page.evaluate(() => {
            if (!window.__gameMonitor) return null;
            const M = window.__gameMonitor;
            return {
                connected: M.connected,
                connectCount: M.connectCount,
                disconnectCount: M.disconnectCount,
                recvCount: M.recvCount,
                sendCount: M.sendCount
            };
        });
    } catch (e) { return null; }
}

async function resetMonitor(page) {
    try {
        await page.evaluate(() => {
            if (window.__gameMonitor) {
                window.__gameMonitor.connected = false;
                window.__gameMonitor.connectCount = 0;
                window.__gameMonitor.disconnectCount = 0;
                window.__gameMonitor.connectTime = null;
                window.__gameMonitor.disconnectTime = null;
                window.__gameMonitor.recvCount = 0;
                window.__gameMonitor.sendCount = 0;
                window.__gameMonitor.allWsUrls = [];
                window.__gameMonitor.startTime = Date.now();
            }
        });
    } catch (e) {}
}

async function injectData(page, token, userId, lobbyId) {
    await page.evaluate((token, userId, groupId, lobbyId) => {
        window.Gamepad = {
            _listeners: {},
            on: function(e, cb) { if (!this._listeners[e]) this._listeners[e] = []; this._listeners[e].push(cb); },
            emit: function(e, d) { try { if (e === 'setUserData') { const p = typeof d === 'string' ? JSON.parse(d) : d; window.__userData = p; setTimeout(() => window.postMessage({ type: 'experienceStateChanged', args: { experienceState: 'ready' } }, '*'), 200); } } catch(x) {} },
            localEmit: function(e, d) { try { if (e === 'setUserData') { const p = typeof d === 'string' ? JSON.parse(d) : d; window.__userData = p; setTimeout(() => window.postMessage({ type: 'experienceStateChanged', args: { experienceState: 'ready' } }, '*'), 200); } } catch(x) {} },
            showKeyboard: function(){}, hideKeyboard: function(){}, setKeyboardEnabled: function(){}, showPane: function(){}, hidePane: function(){}, setPaneEnabled: function(){}, openPopup: function(){}, openPopupWithActions: function(){}, requestInGamePurchase: function(){}, loadExternalUrl: function(){}
        };
        window.WebViewChannel = {
            postMessage: function(message) {
                try {
                    const data = JSON.parse(message);
                    if (data.type === 'setUserData') {
                        window.__userData = data.args;
                        setTimeout(() => window.postMessage({ type: 'experienceStateChanged', args: { experienceState: 'ready' } }, '*'), 200);
                        setTimeout(() => window.postMessage({ type: 'screenStateChanged', args: { screenState: 'full' } }, '*'), 800);
                    }
                } catch (e) {}
            }
        };
        const userData = {
            platform: 'android', contextType: 'group', contextID: groupId.toString(),
            clientToken: token, expSessionToken: token, externalLink: '', launchData: '',
            userId: userId, lobbyId: lobbyId
        };
        window.postMessage({ type: 'setUserData', args: userData }, '*');
        window.Gamepad.localEmit('setUserData', userData);
        window.Gamepad.emit('setUserData', userData);
    }, token, userId, GROUP_ID, lobbyId);
}

// ═══════════════════════════════════════════════════════════════
// النقرات
// ═══════════════════════════════════════════════════════════════
async function clickSequence(page, clicks) {
    for (const [i, c] of clicks.entries()) {
        await page.mouse.click(c.x, c.y);
        if (i < clicks.length - 1) await sleep(DELAY_BETWEEN_CLICKS);
    }
}

async function performFullCycle(pageGuest, pageHost) {
    await clickSequence(pageGuest, CLICKS_GUEST);
    await sleep(DELAY_AFTER_GUEST);
    await clickSequence(pageHost, CLICKS_HOST);
    await sleep(DELAY_AFTER_HOST);
}

// ═══════════════════════════════════════════════════════════════
// انتظار بدء اللعبة
// ═══════════════════════════════════════════════════════════════
async function waitForGameStart(page1, page2, maxWait) {
    console.log(`⏳ انتظار بدء اللعبة (edgegap WS)...`);
    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < maxWait) {
        const m1 = await getMonitor(page1);
        const m2 = await getMonitor(page2);
        const m = m1?.connectCount > 0 ? m1 : (m2?.connectCount > 0 ? m2 : null);

        if (m && m.connected && m.connectCount >= 1) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`✅ بدأت اللعبة بعد ${elapsed}s`);
            return true;
        }

        const elapsed = Math.floor((Date.now() - start) / 1000);
        if (elapsed >= lastLog + 5) {
            lastLog = elapsed;
            console.log(`   [${elapsed}s] p1:${m1?.connected}|${m1?.connectCount} p2:${m2?.connected}|${m2?.connectCount}`);
        }
        await sleep(POLL_INTERVAL);
    }
    console.log(`❌ لم تبدأ خلال ${maxWait/1000}s`);
    return false;
}

// ═══════════════════════════════════════════════════════════════
// انتظار نهاية اللعبة
// ═══════════════════════════════════════════════════════════════
async function waitForGameEnd(page1, page2, maxWait) {
    console.log(`🎮 اللعب حتى النهاية...`);
    const start = Date.now();
    let clicks = 0;
    let lastLog = 0;

    while (Date.now() - start < maxWait) {
        const m = await getMonitor(page1);
        if (!m) { await sleep(100); continue; }

        if (!m.connected && m.disconnectCount >= 1) {
            await sleep(700);
            const m2 = await getMonitor(page1);
            if (m2 && !m2.connected && m2.disconnectCount >= 1) {
                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                console.log(`🏆 انتهت اللعبة (${clicks} نقرة، ${elapsed}s)`);
                return { ended: true, clicks };
            }
        }

        if (m.connected) {
            const cycleStart = Date.now();
            clicks++;
            if (clicks % 10 === 1) {
                const elapsed = Math.floor((Date.now() - start) / 1000);
                console.log(`   🎯 ${clicks} نقرة (${elapsed}s)`);
            }
            await performFullCycle(page2, page1);
            const elapsed = Date.now() - cycleStart;
            const remaining = TARGET_CYCLE_MS - elapsed;
            if (remaining > 0) await sleep(remaining);
        } else {
            await sleep(100);
        }

        const elapsed = Math.floor((Date.now() - start) / 1000);
        if (elapsed >= lastLog + 10) {
            lastLog = elapsed;
            console.log(`   ⏱️ ${elapsed}s | connected=${m.connected} clicks=${clicks}`);
        }
    }

    console.log(`⏹️ انتهت المدة (${clicks} نقرة)`);
    return { ended: false, clicks };
}

// ═══════════════════════════════════════════════════════════════
// لعب جولة واحدة
// ═══════════════════════════════════════════════════════════════
async function playOneRound(page1, page2, lobbyId) {
    console.log(`🌐 توجيه الصفحات للوبي ${lobbyId}...`);
    await Promise.all([
        navigateToLobby(page1, TOKEN_HOST, lobbyId),
        navigateToLobby(page2, TOKEN_GUEST, lobbyId)
    ]);
    await sleep(WAIT_AFTER_NAVIGATE);

    console.log(`🚪 انضمام الضيف...`);
    await joinLobby(TOKEN_GUEST, lobbyId, "الضيف");
    await sleep(WAIT_AFTER_JOIN);

    console.log(`🎮 close (بدء اللعبة)...`);
    const closed = await closeLobby(TOKEN_HOST, lobbyId);
    if (!closed) return { started: false, reason: 'close_failed' };
    await sleep(WAIT_AFTER_CLOSE);

    console.log(`💉 حقن البيانات...`);
    await Promise.all([
        injectData(page1, TOKEN_HOST, USER_ID_HOST, lobbyId),
        injectData(page2, TOKEN_GUEST, USER_ID_GUEST, lobbyId)
    ]);
    await sleep(WAIT_AFTER_INJECT);

    await resetMonitor(page1);
    await resetMonitor(page2);

    const started = await waitForGameStart(page1, page2, MAX_WAIT_START);
    if (!started) return { started: false, reason: 'no_ws' };

    const result = await waitForGameEnd(page1, page2, MAX_PLAY_TIME);
    return { started: true, ended: result.ended, clicks: result.clicks };
}

// ═══════════════════════════════════════════════════════════════
// RunContext
// ═══════════════════════════════════════════════════════════════
class RunContext {
    constructor() {
        this.browser1 = null;
        this.browser2 = null;
        this.tempDir1 = null;
        this.tempDir2 = null;
        this.page1 = null;
        this.page2 = null;
        this.sessionHost = null;
        this.sessionGuest = null;
    }

    async init() {
        this.tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-'));
        this.tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-'));

        console.log("🚀 فتح المتصفحين...");
        this.browser1 = await puppeteer.launch({
            headless: 'new', userDataDir: this.tempDir1,
            args: ['--disable-web-security', '--no-sandbox', '--disable-setuid-sandbox',
                   '--window-size=600,600', '--disable-session-crashed-bubble',
                   '--disable-features=TranslateUI', '--disable-dev-shm-usage']
        });
        this.browser2 = await puppeteer.launch({
            headless: 'new', userDataDir: this.tempDir2,
            args: ['--disable-web-security', '--no-sandbox', '--disable-setuid-sandbox',
                   '--window-size=600,600', '--disable-session-crashed-bubble',
                   '--disable-features=TranslateUI', '--disable-dev-shm-usage']
        });

        await this.recreateSessions();
        await this.recreatePages();
    }

    async recreateSessions() {
        if (this.sessionHost) try { await deleteSession(TOKEN_HOST, this.sessionHost); } catch (e) {}
        if (this.sessionGuest) try { await deleteSession(TOKEN_GUEST, this.sessionGuest); } catch (e) {}

        console.log("\n========== إنشاء الجلسات ==========");
        for (let i = 1; i <= 5; i++) {
            this.sessionHost = await createSession(TOKEN_HOST, "المنشئ");
            if (this.sessionHost) break;
            console.log(`⚠️ فشل جلسة المنشئ (${i}/5) → انتظار 10s`);
            await sleep(10000);
        }
        if (!this.sessionHost) throw new Error("فشل جلسة المنشئ");

        for (let i = 1; i <= 5; i++) {
            this.sessionGuest = await createSession(TOKEN_GUEST, "الضيف");
            if (this.sessionGuest) break;
            console.log(`⚠️ فشل جلسة الضيف (${i}/5) → انتظار 10s`);
            await sleep(10000);
        }
        if (!this.sessionGuest) throw new Error("فشل جلسة الضيف");
    }
