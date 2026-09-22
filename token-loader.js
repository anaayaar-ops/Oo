
const GITHUB_TOKEN = process.env.GH_READ_TOKEN || '';
const GITHUB_OWNER = 'anaayaar-ops';

const SOURCES = {
    host: {
        repo: 'too',
        file: 'tokens.json',
        branch: 'main',
        key: 'v3APIToken',
        label: 'المنشئ (80055399)'
    },
    guest: {
        repo: 'ono',
        file: 'tokens.json',
        branch: 'main',
        key: 'v3APIToken',
        label: 'الضيف (51660277)'
    }
};

function mask(v) {
    if (!v) return 'غير موجود';
    const s = String(v);
    if (s.length <= 16) return '***';
    return `${s.slice(0, 10)}...${s.slice(-10)}`;
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timer);

            // لا نعيد المحاولة عند أخطاء العميل (4xx ما عدا 429)
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                return res;
            }
            if (res.ok) return res;

            // 5xx أو 429 → retry
            lastError = new Error(`HTTP ${res.status}`);
            console.log(`   ⚠️ محاولة ${attempt}/${maxRetries} فشلت (${res.status}) — إعادة بعد ${attempt * 1500}ms`);
        } catch (e) {
            clearTimeout(timer);
            lastError = e;
            console.log(`   ⚠️ محاولة ${attempt}/${maxRetries} — ${e.message}`);
        }
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, attempt * 1500));
    }
    throw lastError;
}

async function fetchTokenFromRepo(source) {
    if (!GITHUB_TOKEN) {
        throw new Error('❌ GH_READ_TOKEN غير موجود في متغيرات البيئة');
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${source.repo}/contents/${source.file}?ref=${source.branch}`;
    console.log(`🌐 [${source.label}] قراءة من: ${GITHUB_OWNER}/${source.repo}/${source.file}`);

    const res = await fetchWithRetry(url, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'xo-bot'
        }
    });

    if (res.status === 404) {
        throw new Error(`❌ الملف ${source.file} غير موجود في ${source.repo}`);
    }
    if (res.status === 401) {
        throw new Error('❌ GH_READ_TOKEN غير صالح أو منتهي');
    }
    if (res.status === 403) {
        throw new Error(`❌ الصلاحيات غير كافية — تأكد من Contents: Read على ${source.repo}`);
    }
    if (!res.ok) {
        throw new Error(`❌ فشل قراءة ${source.repo}: ${res.status} — ${await res.text()}`);
    }

    const data = await res.json();

    if (!data.content) {
        throw new Error(`❌ محتوى ${source.repo}/${source.file} فارغ أو كبير جدًا (>1MB)`);
    }

    const content = Buffer.from(data.content, 'base64').toString('utf8');
    let tokens;
    try {
        tokens = JSON.parse(content);
    } catch (e) {
        throw new Error(`❌ ${source.repo}/${source.file} ليس JSON صالحًا`);
    }

    const tokenValue = tokens[source.key];
    if (!tokenValue) {
        throw new Error(`❌ المفتاح "${source.key}" مفقود في ${source.repo}/${source.file}`);
    }

    console.log(`✅ [${source.label}] تم التحميل | updatedAt=${tokens.updatedAt || 'غير معروف'}`);
    console.log(`   🔐 ${source.key}: ${mask(tokenValue)}`);

    return tokenValue;
}

async function loadTokens() {
    console.log('');
    console.log('========================================');
    console.log('🔐 تحميل التوكنات من مستودعين');
    console.log('========================================');

    const [hostToken, guestToken] = await Promise.all([
        fetchTokenFromRepo(SOURCES.host),
        fetchTokenFromRepo(SOURCES.guest)
    ]);

    console.log('========================================');
    console.log('✅ كل التوكنات جاهزة');
    console.log('========================================');
    console.log('');

    return {
        TOKEN_HOST: hostToken,
        TOKEN_GUEST: guestToken
    };
}

module.exports = { loadTokens };
