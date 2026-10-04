const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadTokens } = require('./token-loader.js');

// ═══════════════════════════════════════════════════════════════
// بيانات الحسابات
// ═══════════════════════════════════════════════════════════════
let TOKEN_HOST = '';
let TOKEN_GUEST = '';
const USER_ID_HOST = 80055399;
const USER_ID_GUEST = 51660277;
const GROUP_ID = 18432094;

// ═══════════════════════════════════════════════════════════════
// الإعدادات
// ═══════════════════════════════════════════════════════════════
const MIN_WAIT_AFTER_DISCONNECT = 1200;
const MAX_WAIT_START = 40000;
const MAX_PLAY_TIME = 5 * 60 * 1000;
const POLL_INTERVAL = 150;
const MAX_LOBBY_ATTEMPTS = 3;
const MAX_STUCK_ATTEMPTS = 3;
const WAIT_AFTER_NAVIGATE = 2200;
const WAIT_AFTER_JOIN = 700;
const WAIT_AFTER_CLOSE = 2000;
const WAIT_AFTER_INJECT = 700;
const WAIT_AFTER_LEAVE = 1200;
const END_CONFIRM_WAIT = 2500;
const MIN_DRAGS_FOR_REAL_GAME = 5;
const VERIFY_MEMBERS_DELAY = 800;

const SKIP_VIDEOS = true;

// ═══════════════════════════════════════════════════════════════
// مُسرِّع الوقت داخل اللعبة (Unity WebGL)
// ═══════════════════════════════════════════════════════════════
const TIME_SCALE = 3;

// ═══════════════════════════════════════════════════════════════
// إعدادات اللعبة
// ═══════════════════════════════════════════════════════════════
const EXPERIENCE_ID = 9;
const LOBBY_TYPE_ID = 13;
const EXPERIENCE_BUILD_VERSION = "4.8.14";
const EXPERIENCE_PATH = `/experience/golden_goal/${EXPERIENCE_BUILD_VERSION}/index.html`;
const LOBBY_DISPLAY_NAME = "ㅤ⚽ Penalty Shootout ㅤ";

// ═══════════════════════════════════════════════════════════════
// السحب — إحداثيات ثابتة (بدون تعلّم)
// ═══════════════════════════════════════════════════════════════
const GUEST_DRAG_FROM = { x: 300, y: 338 };
const GUEST_DRAG_TO   = { x: 264, y: 470 };
const HOST_DRAG_FROM  = { x: 300, y: 338 };
const HOST_DRAG_TO    = { x: 264, y: 300 };
const DRAG_INTERVAL = 250; // كل 250ms دورة سحب للحسابين (متوازي)

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

const _stuckLobbyAttempts = new Map();

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
// API: التحقق من أعضاء اللوبي
// ═══════════════════════════════════════════════════════════════
async function getLobbyMembers(lobbyId) {
    const urls = [
        `https://experience.palringo.com/lobby/id/${lobbyId}`,
        `https://experience.palringo.com/lobby/id/${lobbyId}/users`,
        `https://experience.palringo.com/lobby/id/${lobbyId}/user`
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url, {
                headers: { ...baseHeaders, authorization: `Bearer ${TOKEN_HOST}` }
            });
            if (!res.ok) continue;
            const data = await res.json();
            const arr = data.users || data.members || data.userList || data.players;
            if (Array.isArray(arr)) {
                return arr.map(u => Number(u.userId ?? u.id ?? u.user_id ?? 0)).filter(Boolean);
            }
            if (arr && typeof arr === 'object') {
                return Object.values(arr).map(u => Number(u.userId ?? u.id ?? 0)).filter(Boolean);
            }
        } catch (e) {}
    }
    return null;
}

async function verifyOnlyOurAccounts(lobbyId) {
    const ids = await getLobbyMembers(lobbyId);
    if (!ids) return null;
    const ours = new Set([USER_ID_HOST, USER_ID_GUEST]);
    const strangers = ids.filter(id => !ours.has(id));
    if (strangers.length > 0) {
        console.log(`⚠️ أعضاء غرباء في اللوبي: ${strangers.join(',')}`);
        return false;
    }
    return true;
}

// ═══════════════════════════════════════════════════════════════
// API: تفكيك اللوبي
// ═══════════════════════════════════════════════════════════════
async function leaveFromBothAccounts(lobbyId) {
    console.log(`🚪 تفكيك اللوبي ${lobbyId}...`);

    const hostHeaders = {
        ...baseHeaders,
        "authorization": `Bearer ${TOKEN_HOST}`,
        "content-length": "0"
    };

    await Promise.all([
        fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/user`, {
            method: "DELETE",
            headers: { ...baseHeaders, "authorization": `Bearer ${TOKEN_GUEST}` }
        }).then(r => console.log(`   [الضيف] leave → ${r.status}`)).catch(() => {}),
        fetch(`https://experience.palringo.com/lobby/id/${lobbyId}`, {
            method: "DELETE", headers: hostHeaders
        }).then(r => console.log(`   [المنشئ] DELETE → ${r.status}`)).catch(() => {})
    ]);

    await Promise.all([
        fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/close`, {
            method: "POST", headers: hostHeaders
        }).then(r => console.log(`   [المنشئ] close → ${r.status}`)).catch(() => {}),
        fetch(`https://experience.palringo.com/lobby/id/${lobbyId}/user`, {
            method: "DELETE",
            headers: { ...baseHeaders, "authorization": `Bearer ${TOKEN_HOST}` }
        }).then(r => console.log(`   [المنشئ] leave → ${r.status}`)).catch(() => {})
    ]);

    await sleep(WAIT_AFTER_LEAVE);
    return true;
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
            displayName: LOBBY_DISPLAY_NAME,
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

            if (err.code === 55) return lobbyId;
            if (err.code === 5) {
                const m = (err.message || '').match(/Lobby, id (\d+)/);
                if (m && m[1] === String(lobbyId)) return lobbyId;
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

async function createLobbySmart(token, oldLobbyId = null) {
    if (oldLobbyId) {
        console.log(`🔄 Rematch على ${oldLobbyId}...`);
        const newId = await rematchLobby(token, oldLobbyId);
        if (newId) return { id: newId, usedRematch: true };
        console.log(`⚠️ Rematch فشل → مغادرة فورية`);
        await leaveFromBothAccounts(oldLobbyId);
    }

    for (let i = 1; i <= MAX_LOBBY_ATTEMPTS; i++) {
        console.log(`📄 محاولة إنشاء لوبي ${i}/${MAX_LOBBY_ATTEMPTS}...`);
        const result = await createLobbyRaw(token);

        if (result.ok) {
            _stuckLobbyAttempts.clear();
            console.log(`✅ لوبي جديد: ${result.id}`);
            return { id: result.id, usedRematch: false };
        }

        const errorMsg = result.error?.message || '';
        const m = errorMsg.match(/Lobby, id (\d+)/);
        const stuckId = m ? m[1] : null;

        if (stuckId && errorMsg.includes('already in')) {
            const tries = (_stuckLobbyAttempts.get(stuckId) || 0) + 1;
            _stuckLobbyAttempts.set(stuckId, tries);
            console.log(`⚠️ عالق في ${stuckId} (${tries}/${MAX_STUCK_ATTEMPTS})`);

            if (tries >= MAX_STUCK_ATTEMPTS) {
                _stuckLobbyAttempts.delete(stuckId);
                return null;
            }
            await leaveFromBothAccounts(stuckId);
        } else {
            console.log(`⚠️ محاولة ${i}: ${result.status} ${errorMsg.slice(0, 80)}`);
            await sleep(1500);
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
// ⏩ مُسرِّع الوقت
// ═══════════════════════════════════════════════════════════════
async function installTimeAccelerator(page, scale = TIME_SCALE) {
    await page.evaluateOnNewDocument((scale) => {
        if (window.__timeAccelInstalled) return;
        window.__timeAccelInstalled = true;

        const _perfNow = performance.now.bind(performance);
        const _dateNow = Date.now.bind(Date);
        const t0Perf = _perfNow();
        const t0Date = _dateNow();

        try {
            Object.defineProperty(performance, 'now', {
                configurable: true,
                value: () => t0Perf + (_perfNow() - t0Perf) * scale
            });
        } catch (e) {}

        try {
            Date.now = () => t0Date + (_dateNow() - t0Date) * scale;
        } catch (e) {}

        const _raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) =>
            _raf((t) => {
                const scaled = t0Perf + (t - t0Perf) * scale;
                cb(scaled);
            });

        const _st = window.setTimeout;
        const _si = window.setInterval;
        window.setTimeout = (fn, ms, ...a) =>
            _st(fn, Math.max(1, (typeof ms === 'number' ? ms : 0) / scale), ...a);
        window.setInterval = (fn, ms, ...a) =>
            _si(fn, Math.max(1, (typeof ms === 'number' ? ms : 0) / scale), ...a);

        console.log(`⏩ TimeAccelerator ON (×${scale})`);
    }, scale);
}

// ═══════════════════════════════════════════════════════════════
// تسريع الفيديوهات
// ═══════════════════════════════════════════════════════════════
async function installVideoSkip(page) {
    if (!SKIP_VIDEOS) return;
    await page.evaluateOnNewDocument(() => {
        window.__videosSkipped = 0;
        const done = new WeakSet();

        const nuke = (v) => {
            if (!v || done.has(v)) return;
            done.add(v);
            window.__videosSkipped++;
            try {
                v.muted = true;
                try { v.playbackRate = 16; } catch (e) {}
                try { v.playbackRate = 100; } catch (e) {}
                try { v.defaultPlaybackRate = 100; } catch (e) {}

                const jump = () => {
                    try {
                        const d = v.duration;
                        if (isFinite(d) && d > 0) {
                            if (v.currentTime < d) v.currentTime = d;
                        } else {
                            v.currentTime = 1e9;
                        }
                    } catch (e) {}
                };
                jump();

                let n = 0;
                const iv = setInterval(() => { jump(); if (++n > 200) clearInterval(iv); }, 10);

                setTimeout(() => {
                    try {
                        v.dispatchEvent(new Event('ended', { bubbles: true }));
                        v.dispatchEvent(new Event('timeupdate', { bubbles: true }));
                        v.dispatchEvent(new Event('canplaythrough', { bubbles: true }));
                    } catch (e) {}
                }, 30);
            } catch (e) {}
        };

        const _play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            if (this.tagName === 'VIDEO') { nuke(this); return Promise.resolve(); }
            return _play.apply(this, arguments);
        };

        const _load = HTMLMediaElement.prototype.load;
        HTMLMediaElement.prototype.load = function () {
            const r = _load.apply(this, arguments);
            if (this.tagName === 'VIDEO') nuke(this);
            return r;
        };

        new MutationObserver((muts) => {
            for (const m of muts) for (const nd of m.addedNodes) {
                if (nd.nodeType !== 1) continue;
                if (nd.tagName === 'VIDEO') nuke(nd);
                else if (nd.querySelectorAll) nd.querySelectorAll('video').forEach(nuke);
            }
        }).observe(document.documentElement || document, { childList: true, subtree: true });

        setInterval(() => {
            document.querySelectorAll('video').forEach((v) => {
                if (!done.has(v)) nuke(v);
                else {
                    try {
                        const d = v.duration;
                        if (isFinite(d) && d > 0 && v.currentTime < d - 0.01) v.currentTime = d;
                    } catch (e) {}
                }
            });
        }, 20);
    });
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

            const ws = new OrigWS(url, protocols);

            ws.addEventListener('open', () => {
                if (!isGameWs) return;
                M.connectTime = Date.now();
                M.connectCount++;
                M.connected = true;
                console.log(`🎮 WS اللعبة متصل #${M.connectCount}`);
            });

            ws.addEventListener('close', () => {
                if (!isGameWs) return;
                M.disconnectTime = Date.now();
                M.disconnectCount++;
                M.connected = false;
                console.log(`🏁 WS اللعبة انفصل #${M.disconnectCount}`);
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
                const M = window.__gameMonitor;
                M.connected = false;
                M.connectCount = 0;
                M.disconnectCount = 0;
                M.connectTime = null;
                M.disconnectTime = null;
                M.recvCount = 0;
                M.sendCount = 0;
                M.allWsUrls = [];
                M.startTime = Date.now();
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
// السحب — إحداثيات ثابتة (متوازي 100%)
// ═══════════════════════════════════════════════════════════════
async function performDrag(page, accountName, fromX, fromY, toX, toY) {
    try {
        await page.mouse.move(fromX, fromY);
        await sleep(60);
        await page.mouse.down();
        await sleep(100);
        await page.mouse.move(toX, toY, { steps: 8 });
        await sleep(100);
        await page.mouse.up();
    } catch (e) {
        console.error(`[${accountName}] خطأ سحب:`, e.message);
    }
}

async function performFullCycle(pageGuest, pageHost) {
    // ⚡ الاثنان معاً في نفس اللحظة — ما في انتظار تسلسلي
    await Promise.all([
        performDrag(pageGuest, "الضيف",
            GUEST_DRAG_FROM.x, GUEST_DRAG_FROM.y,
            GUEST_DRAG_TO.x,   GUEST_DRAG_TO.y),
        performDrag(pageHost, "المنشئ",
            HOST_DRAG_FROM.x, HOST_DRAG_FROM.y,
            HOST_DRAG_TO.x,   HOST_DRAG_TO.y)
    ]);
}

// ═══════════════════════════════════════════════════════════════
// انتظار بدء اللعبة
// ═══════════════════════════════════════════════════════════════
async function waitForGameStart(page1, page2, maxWait) {
    console.log(`⏳ انتظار بدء اللعبة...`);
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        const [m1, m2] = await Promise.all([getMonitor(page1), getMonitor(page2)]);
        const m = m1?.connectCount > 0 ? m1 : (m2?.connectCount > 0 ? m2 : null);

        if (m && m.connected && m.connectCount >= 1) {
            console.log(`✅ بدأت بعد ${((Date.now() - start) / 1000).toFixed(1)}s`);
            return true;
        }
        await sleep(POLL_INTERVAL);
    }
    console.log(`❌ لم تبدأ خلال ${maxWait/1000}s`);
    return false;
}

// ═══════════════════════════════════════════════════════════════
// حلقة اللعب — سحب متوازي بدون حجب الحلقة
// ═══════════════════════════════════════════════════════════════
async function waitForGameEnd(page1, page2, maxWait) {
    console.log(`🎮 اللعب حتى النهاية...`);
    const start = Date.now();
    let drags = 0;
    let lastDragTime = 0;
    let inFlight = false;

    while (Date.now() - start < maxWait) {
        const m = await getMonitor(page1);
        if (!m) { await sleep(80); continue; }

        if (!m.connected && m.disconnectCount >= 1) {
            await sleep(END_CONFIRM_WAIT);
            const m2 = await getMonitor(page1);
            if (m2 && !m2.connected && m2.disconnectCount >= 1) {
                console.log(`🏆 انتهت اللعبة (${drags} دورة، ${((Date.now()-start)/1000).toFixed(1)}s)`);
                return { ended: true, drags };
            }
        }

        if (m.connected && !inFlight) {
            const now = Date.now();
            if (now - lastDragTime >= DRAG_INTERVAL) {
                lastDragTime = now;
                drags++;
                inFlight = true;
                // ⚡ نطلق الدورة بدون حجب الحلقة — نرجع نراقب فوراً
                performFullCycle(page2, page1).finally(() => { inFlight = false; });
            }
        }
        await sleep(80);
    }

    console.log(`⏹️ انتهت المدة (${drags} دورة)`);
    return { ended: false, drags };
}

// ═══════════════════════════════════════════════════════════════
// لعب جولة واحدة
// ═══════════════════════════════════════════════════════════════
async function playOneRound(page1, page2, lobbyId) {
    const T = { s: Date.now() };
    const lap = (k) => { T[k] = Date.now(); };
    const d = (a, b) => ((T[b] - T[a]) / 1000).toFixed(1) + 's';

    console.log(`🌐 توجيه الصفحات للوبي ${lobbyId}...`);
    await Promise.all([
        navigateToLobby(page1, TOKEN_HOST, lobbyId),
        navigateToLobby(page2, TOKEN_GUEST, lobbyId)
    ]);
    lap('nav');
    await sleep(WAIT_AFTER_NAVIGATE);

    const lobbyEntryTime = Date.now();
    console.log(`⏱️ [قياس] بدأ من لحظة الدخول للوبي`);

    console.log(`🚪 انضمام الضيف...`);
    await joinLobby(TOKEN_GUEST, lobbyId, "الضيف");
    await sleep(WAIT_AFTER_JOIN);

    console.log(`🔎 التحقق من أعضاء اللوبي...`);
    await sleep(VERIFY_MEMBERS_DELAY);
    const membersOk = await verifyOnlyOurAccounts(lobbyId);
    if (membersOk === false) {
        console.log(`🛑 يوجد لاعب غريب → خروج فوري`);
        await leaveFromBothAccounts(lobbyId);
        return { started: false, reason: 'stranger_in_lobby' };
    }
    if (membersOk === null) {
        console.log(`⚠️ تعذر التحقق من الأعضاء → متابعة`);
    } else {
        console.log(`✅ الأعضاء صحيحون`);
    }

    console.log(`🎮 close...`);
    const closed = await closeLobby(TOKEN_HOST, lobbyId);
    if (!closed) return { started: false, reason: 'close_failed' };
    lap('close');
    await sleep(WAIT_AFTER_CLOSE);

    console.log(`💉 حقن البيانات...`);
    await Promise.all([
        injectData(page1, TOKEN_HOST, USER_ID_HOST, lobbyId),
        injectData(page2, TOKEN_GUEST, USER_ID_GUEST, lobbyId)
    ]);
    lap('inject');
    await sleep(WAIT_AFTER_INJECT);

    await Promise.all([
        resetMonitor(page1),
        resetMonitor(page2)
    ]);

    const started = await waitForGameStart(page1, page2, MAX_WAIT_START);
    lap('ws');
    if (!started) {
        const totalTime = ((Date.now() - lobbyEntryTime) / 1000).toFixed(1);
        console.log(`⏱️ [قياس] لم تبدأ — زمن من الدخول: ${totalTime}s`);
        return { started: false, reason: 'no_ws', totalTime };
    }

    const result = await waitForGameEnd(page1, page2, MAX_PLAY_TIME);
    lap('end');

    const totalTime = ((Date.now() - lobbyEntryTime) / 1000).toFixed(1);
    let vids = '-';
    try { vids = await page2.evaluate(() => window.__videosSkipped || 0); } catch (e) {}

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`⏱️ الأزمنة: تحميل=${d('s','nav')} | →close=${d('nav','close')} | close→حقن=${d('close','inject')} | حقن→WS=${d('inject','ws')} | لعب=${d('ws','end')}`);
    console.log(`🏁 ⏱️ الوقت الكلي من الدخول للوبي حتى نهاية المباراة: ${totalTime}s`);
    console.log(`🎬 فيديوهات مُسرَّعة: ${vids}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (result.ended && result.drags < MIN_DRAGS_FOR_REAL_GAME) {
        return { started: false, reason: 'too_short', totalTime };
    }
    return { started: true, ended: result.ended, drags: result.drags, totalTime };
}

// ═══════════════════════════════════════════════════════════════
// RunContext
// ═══════════════════════════════════════════════════════════════
class RunContext {
    constructor() {
        this.browser = null;
        this.tempDir = null;
        this.ctx1 = null;
        this.ctx2 = null;
        this.page1 = null;
        this.page2 = null;
        this.sessionHost = null;
        this.sessionGuest = null;
    }

    async init() {
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-'));

        console.log("🚀 فتح المتصفح (واحد فقط)...");
        this.browser = await puppeteer.launch({
            headless: 'new',
            userDataDir: this.tempDir,
            args: [
                '--disable-web-security', '--no-sandbox', '--disable-setuid-sandbox',
                '--window-size=600,600', '--disable-session-crashed-bubble',
                '--disable-features=TranslateUI', '--disable-dev-shm-usage',
                '--autoplay-policy=no-user-gesture-required',
                '--mute-audio'
            ]
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
            console.log(`⚠️ فشل جلسة المنشئ (${i}/5)`);
            await sleep(6000);
        }
        if (!this.sessionHost) throw new Error("فشل جلسة المنشئ");

        for (let i = 1; i <= 5; i++) {
            this.sessionGuest = await createSession(TOKEN_GUEST, "الضيف");
            if (this.sessionGuest) break;
            console.log(`⚠️ فشل جلسة الضيف (${i}/5)`);
            await sleep(6000);
        }
        if (!this.sessionGuest) throw new Error("فشل جلسة الضيف");
    }

    async recreatePages() {
        if (this.page1) try { await this.page1.close(); } catch (e) {}
        if (this.page2) try { await this.page2.close(); } catch (e) {}
        if (this.ctx1) try { await this.ctx1.close(); } catch (e) {}
        if (this.ctx2) try { await this.ctx2.close(); } catch (e) {}

        console.log("📄 تجهيز الصفحات (سياقان معزولان)...");
        const createCtx = this.browser.createBrowserContext
            ? () => this.browser.createBrowserContext()
            : () => this.browser.createIncognitoBrowserContext();

        this.ctx1 = await createCtx();
        this.ctx2 = await createCtx();

        const UA = 'Mozilla/5.0 (Linux; Android 13; NTH-NX9 Build/HONORNTH-N29; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.124 Mobile Safari/537.36';

        this.page1 = await this.ctx1.newPage();
        this.page2 = await this.ctx2.newPage();

        await this.page1.setViewport({ width: 600, height: 600 });
        await this.page2.setViewport({ width: 600, height: 600 });
        await this.page1.setUserAgent(UA);
        await this.page2.setUserAgent(UA);

        await installTimeAccelerator(this.page1, TIME_SCALE);
        await installTimeAccelerator(this.page2, TIME_SCALE);
        await installWebSocketMonitor(this.page1);
        await installWebSocketMonitor(this.page2);
        await installVideoSkip(this.page1);
        await installVideoSkip(this.page2);
    }

    async cleanup() {
        if (this.sessionHost) try { await deleteSession(TOKEN_HOST, this.sessionHost); } catch (e) {}
        if (this.sessionGuest) try { await deleteSession(TOKEN_GUEST, this.sessionGuest); } catch (e) {}
        if (this.tempDir) deleteTempDir(this.tempDir);
        try { if (this.browser) await this.browser.close(); } catch (e) {}
    }

    async softRestart() {
        console.log("\n♻️ إعادة تشغيل ناعمة (بدون إغلاق المتصفح)...");
        try { await this.recreateSessions(); } catch (e) {
            console.error("❌ فشل تجديد الجلسات:", e.message);
            throw e;
        }
        await this.recreatePages();
        _stuckLobbyAttempts.clear();
    }
}

// ═══════════════════════════════════════════════════════════════
// الدورة الرئيسية
// ═══════════════════════════════════════════════════════════════
async function runForever() {
    const ctx = new RunContext();
    await ctx.init();

    let stopping = false;
    process.on('SIGINT', async () => {
        if (stopping) return;
        stopping = true;
        console.log("\n🛑 إيقاف — تنظيف...");
        await ctx.cleanup();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        if (stopping) return;
        stopping = true;
        await ctx.cleanup();
        process.exit(0);
    });

    console.log("\n========== فتح الصفحات الرئيسية ==========");
    await Promise.all([
        navigateToMainPage(ctx.page1, TOKEN_HOST),
        navigateToMainPage(ctx.page2, TOKEN_GUEST)
    ]);
    await sleep(1500);

    let lobbyId = null;
    let round = 0;
    let wins = 0;
    let consecutiveFailures = 0;

    const softRestartAndReopen = async () => {
        await ctx.softRestart();
        await Promise.all([
            navigateToMainPage(ctx.page1, TOKEN_HOST),
            navigateToMainPage(ctx.page2, TOKEN_GUEST)
        ]);
        await sleep(1500);
    };

    while (true) {
        try {
            if (!lobbyId) {
                const setup = await createLobbySmart(TOKEN_HOST, null);
                if (!setup) {
                    consecutiveFailures++;
                    console.log(`⚠️ فشل إنشاء لوبي (${consecutiveFailures} متتالي)`);

                    if (consecutiveFailures >= 3) {
                        console.log("♻️ إعادة تشغيل ناعمة...");
                        await softRestartAndReopen();
                        consecutiveFailures = 0;
                    } else {
                        await sleep(3000);
                    }
                    continue;
                }
                lobbyId = setup.id;
                consecutiveFailures = 0;
            }

            round++;
            console.log(`\n══════════ الجولة ${round} (${wins} فوز) - لوبي ${lobbyId} ══════════`);

            const result = await playOneRound(ctx.page1, ctx.page2, lobbyId);

            if (result.reason === 'stranger_in_lobby') {
                console.log(`🔁 لوبي ملوّث بغريب → إنشاء لوبي جديد مباشرة`);
                const setup = await createLobbySmart(TOKEN_HOST, null);
                lobbyId = setup ? setup.id : null;
                if (setup) consecutiveFailures = 0;
                else consecutiveFailures++;
                continue;
            }

            if (!result.started) {
                console.log(`⚠️ فشل البدء (${result.reason})`);
                await leaveFromBothAccounts(lobbyId);

                consecutiveFailures++;
                const setup = await createLobbySmart(TOKEN_HOST, null);
                if (setup) {
                    lobbyId = setup.id;
                    consecutiveFailures = 0;
                } else {
                    lobbyId = null;
                    if (consecutiveFailures >= 3) {
                        await softRestartAndReopen();
                        consecutiveFailures = 0;
                    }
                }
                continue;
            }

            consecutiveFailures = 0;
            if (result.ended) wins++;

            await sleep(MIN_WAIT_AFTER_DISCONNECT);
            console.log(`\n🔄 تجهيز الجولة ${round + 1}...`);

            const setup = await createLobbySmart(TOKEN_HOST, lobbyId);
            if (!setup) {
                const fresh = await createLobbySmart(TOKEN_HOST, null);
                if (fresh) {
                    lobbyId = fresh.id;
                    console.log(`♻️ لوبي جديد جاهز`);
                } else {
                    console.log("🛑 فشل الحصول على لوبي → إعادة تشغيل ناعمة");
                    try { await softRestartAndReopen(); } catch (e) {
                        console.error("❌ فشل:", e.message);
                        await sleep(10000);
                    }
                    lobbyId = null;
                    consecutiveFailures = 0;
                }
            } else {
                lobbyId = setup.id;
                console.log(`♻️ جاهز (${setup.usedRematch ? 'Rematch ✅' : 'لوبي جديد'})`);
            }

        } catch (err) {
            console.error(`\n❌ خطأ في الجولة ${round}:`, err.message);
            consecutiveFailures++;

            if (consecutiveFailures >= 3) {
                console.log(`♻️ ${consecutiveFailures} إخفاقات → إعادة تشغيل ناعمة...`);
                try { await softRestartAndReopen(); } catch (e) {
                    console.error("❌ فشل:", e.message);
                    await sleep(10000);
                }
                consecutiveFailures = 0;
                lobbyId = null;
            } else {
                await sleep(5000);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// نقطة البداية
// ═══════════════════════════════════════════════════════════════
(async () => {
    console.log('📥 تحميل التوكنات...');
    try {
        const tokens = await loadTokens();
        TOKEN_HOST = tokens.TOKEN_HOST;
        TOKEN_GUEST = tokens.TOKEN_GUEST;
    } catch (e) {
        console.error('❌ فشل تحميل التوكنات:', e.message);
        process.exit(1);
    }

    if (!TOKEN_HOST) throw new Error('❌ TOKEN_HOST مفقود');
    if (!TOKEN_GUEST) throw new Error('❌ TOKEN_GUEST مفقود');

    console.log(`✅ TOKEN_HOST  (${USER_ID_HOST})  → ***${TOKEN_HOST.slice(-4)}`);
    console.log(`✅ TOKEN_GUEST (${USER_ID_GUEST}) → ***${TOKEN_GUEST.slice(-4)}\n`);

    let attempt = 0;
    while (true) {
        attempt++;
        try {
            console.log(`\n${'═'.repeat(60)}`);
            console.log(`🚀 بدء التشغيل (محاولة #${attempt})`);
            console.log(`${'═'.repeat(60)}\n`);
            await runForever();
        } catch (e) {
            console.error(`❌ انهيار #${attempt}:`, e.message);
            console.error(e.stack);
            console.log(`⏳ إعادة المحاولة بعد 15s...\n`);
            await sleep(15000);
        }
    }
})();
