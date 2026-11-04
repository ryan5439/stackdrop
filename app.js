require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');           // Standard fs with synchronous methods
const fsPromises = fs.promises;     // Promise-based fs methods
const util = require('util');
const execCallback = require('child_process').exec;
const exec = util.promisify(execCallback);
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');
// Import update checker for scheduled runs
const { checkUpdates } = require('./update-checker');
const installerConfig = require('./installer-config');
// Socket.IO and AI agent dependencies
const { createServer } = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');

// Supabase (server-side) initialization
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
// Stripe (server-side) for Checkout session creation
const Stripe = require('stripe');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_PRICE_ID_STARTER = process.env.STRIPE_PRICE_ID_STARTER || '';
const STRIPE_PRICE_ID_PRO100 = process.env.STRIPE_PRICE_ID_PRO100 || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// Secrets and constants
const DEVICE_TOKEN_SECRET = process.env.DEVICE_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'please_set_device_token_secret';

// Database connection using Supabase connection details
let pgPool = null;

try {
    // Use pg library's built-in connection string parsing
    if (process.env.DATABASE_URL) {
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });
        console.log('PostgreSQL pool initialized successfully');
    } else {
        console.warn('DATABASE_URL not configured - database features will be unavailable');
    }
} catch (err) {
    console.error('Failed to initialize PostgreSQL pool:', err.message);
}

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const port = 3000;

// Ensure required directories exist
async function ensureDirectories() {
    const dirs = [
        '/var/www/stackdrop/silentinstallers',
        '/var/tmp/stackdrop-installer' // Updated path
    ];
    
    // Check if /var/tmp is writable before trying to create subdirectories
    try {
        await fsPromises.access('/var/tmp', fs.constants.W_OK);
    } catch {
        console.error('/var/tmp directory is not writable by the Node.js process');
        throw new Error('Cannot write to /var/tmp. Check permissions for the Node.js user.');
    }
    
    for (const dir of dirs) {
        try {
            await fsPromises.mkdir(dir, { recursive: true });
        } catch (error) {
            console.error(`Failed to create directory ${dir}:`, error);
            throw error;
        }
    }
}

// Verify NSIS installation
async function verifyNSIS() {
    try {
        const nsisPath = await exec('which makensis');
        console.log('NSIS found at:', nsisPath.stdout.trim());
        
        // Check for inetc plugin
        const pluginDir = '/usr/share/nsis/Plugins/x86-unicode';
        const inetcPath = path.join(pluginDir, 'inetc.dll');
        
        try {
            await fsPromises.access(inetcPath);
            console.log('inetc plugin found at:', inetcPath);
        } catch {
            console.warn('inetc plugin not found, attempting to install...');
            
            // Create plugin directory if it doesn't exist
            await fsPromises.mkdir(pluginDir, { recursive: true });
            
            // Download and extract inetc plugin
            await exec(`wget -O /tmp/inetc.zip https://nsis.sourceforge.io/mediawiki/images/c/c9/Inetc.zip && unzip -j /tmp/inetc.zip -d ${pluginDir}`);
            console.log('inetc plugin installed successfully');
        }
        
        return nsisPath.stdout.trim();
    } catch (error) {
        console.error('NSIS verification failed:', error);
        throw new Error('NSIS not installed or configured properly');
    }
}

// Near the start of your app
async function init() {
    try {
        await ensureDirectories();
        await verifyNSIS();

        try {
            console.log('Testing NSIS installation:');
            const nsisTest = await exec('makensis -VERSION');
            console.log('NSIS version:', nsisTest.stdout);
            
            console.log('Testing NSIS plugin directory:');
            const pluginDir = '/usr/share/nsis/Plugins/x86-unicode';
            const pluginTest = await exec(`ls -la ${pluginDir}`);
            console.log('Plugin directory contents:', pluginTest.stdout);
        } catch (execError) {
            console.error('NSIS test error:', execError);
        }
        
        server.listen(port, () => {
            console.log(`Stackdrop app listening at http://localhost:${port}`);
            // Schedule daily update check at 3am server time
            scheduleDailyUpdateCheck();
        });
    } catch (error) {
        console.error('Failed to initialize app:', error);
        process.exit(1);
    }
}

init();

// Schedules the update checker to run once a day at 3am server local time
function scheduleDailyUpdateCheck() {
    const scheduleNextRun = () => {
        const now = new Date();
        const next = new Date(now);
        next.setHours(3, 0, 0, 0);
        if (next <= now) {
            next.setDate(next.getDate() + 1);
        }
        const delayMs = next.getTime() - now.getTime();
        console.log(`Next scheduled update check: ${next.toString()}`);
        setTimeout(async () => {
            try {
                await checkUpdates();
            } catch (e) {
                console.error('Scheduled update check failed:', e);
            } finally {
                // Recalculate next run to handle DST/clock changes
                scheduleNextRun();
            }
        }, delayMs);
    };
    scheduleNextRun();
}

// Set view engine and static files
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve silent installers
app.use('/silentinstallers', express.static('/var/www/stackdrop/silentinstallers'));

// Chrome Transparency download — always serve the latest exe from the plugin folder
app.get('/downloads/ChromeTransparency.exe', (req, res) => {
    try {
        const pluginPath = path.join(__dirname, 'ChromeTransparentPlugin', 'ChromeTransparency.exe');
        const fallbackPath = path.join(__dirname, 'silentinstallers', 'ChromeTransparency.exe');
        const filePath = fs.existsSync(pluginPath) ? pluginPath : fallbackPath;
        if (fs.existsSync(filePath)) {
            res.setHeader('Cache-Control', 'no-store');
            res.download(filePath, 'ChromeTransparency.exe');
        } else {
            res.status(404).send('Chrome Transparency Controller not found. Please build the executable first.');
        }
    } catch (e) {
        res.status(500).send('Failed to download Chrome Transparency Controller');
    }
});

function spectraEqDir() {
    return path.join(__dirname, 'OtherApps', 'equalizer');
}

function findSpectraExe() {
    const dir = spectraEqDir();
    if (!fs.existsSync(dir)) return null;
    const exact = path.join(dir, 'SpectraEQ.exe');
    if (fs.existsSync(exact)) return exact;
    const names = fs.readdirSync(dir).filter((n) => /^SpectraEQ.*\.exe$/i.test(n));
    if (!names.length) return null;
    names.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    return path.join(dir, names[0]);
}

app.get('/equalizer/spectra-screenshot.png', (req, res) => {
    const filePath = path.join(spectraEqDir(), 'spectra-screenshot.png');
    if (!fs.existsSync(filePath)) {
        res.status(404).end();
        return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
});

app.get('/downloads/SpectraEQ.exe', (req, res) => {
    try {
        const filePath = findSpectraExe();
        if (filePath && fs.existsSync(filePath)) {
            res.setHeader('Cache-Control', 'no-store');
            res.download(filePath, 'SpectraEQ.exe');
            return;
        }
        res.status(404).send('SpectraEQ.exe is not built yet. Download the source zip and run build_exe.bat, or build it on the server first.');
    } catch (e) {
        res.status(500).send('Failed to download Spectra EQ');
    }
});

function findEqualizerApoInstaller() {
    const dir = spectraEqDir();
    if (!fs.existsSync(dir)) return null;
    const names = fs.readdirSync(dir).filter((n) => /equalizerapo.*\.exe$/i.test(n) && !/spectra/i.test(n));
    if (!names.length) return null;
    names.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    return path.join(dir, names[0]);
}

app.get('/downloads/EqualizerAPO.exe', (req, res) => {
    try {
        const filePath = findEqualizerApoInstaller();
        if (filePath && fs.existsSync(filePath)) {
            res.setHeader('Cache-Control', 'no-store');
            res.download(filePath, 'EqualizerAPO-x64-1.4.2.exe');
            return;
        }
        res.redirect(302, 'https://sourceforge.net/projects/equalizerapo/files/1.4.2/EqualizerAPO-x64-1.4.2.exe/download');
    } catch (e) {
        res.status(500).send('Failed to download Equalizer APO');
    }
});

app.get('/downloads/mouse-clicker-agent.exe', (req, res) => {
    res.redirect(301, '/downloads/AutoMouseClickerMacroMaker.exe');
});

app.get('/downloads/AutoMouseClickerMacroMaker.exe', (req, res) => {
    try {
        const filePath = '/var/www/stackdrop/macromaker/AutoMouseClickerMacroMaker.exe';
        if (!fs.existsSync(filePath)) {
            res.status(404).send('AutoMouseClickerMacroMaker.exe is not on the server yet.');
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.download(filePath, 'AutoMouseClickerMacroMaker.exe');
    } catch (e) {
        res.status(500).send('Failed to download Macro Maker');
    }
});

app.get('/downloads/SpectraEQ-src.zip', (req, res) => {
    const dir = spectraEqDir();
    const tmp = path.join(require('os').tmpdir(), 'SpectraEQ-src.zip');
    const py = [
        'import zipfile, os, sys',
        'src, dest = sys.argv[1], sys.argv[2]',
        'with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:',
        '    for name in ("Eq.py", "build_exe.bat", "README.md"):',
        '        p = os.path.join(src, name)',
        '        if os.path.isfile(p):',
        '            z.write(p, name)',
    ].join('\n');
    require('child_process').execFile('python3', ['-c', py, dir, tmp], (err) => {
        if (err) {
            res.status(500).send('Failed to pack Spectra EQ source');
            return;
        }
        res.download(tmp, 'SpectraEQ-src.zip');
    });
});

// Serve downloads for the installer
app.use('/downloads', express.static('/var/www/stackdrop/silentinstallers'));

// Serve Chrome extension files for download
app.use('/chrome-extension', express.static('/var/www/stackdrop/ChromeTransparentPlugin'));

// Chrome extension download page (serves DOWNLOAD.html when accessing /chrome-extension/)
app.get('/chrome-extension/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ChromeTransparentPlugin', 'DOWNLOAD.html'));
});

// Serve test.html
app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'test.html'));
});

// ========================================
// SDCLIENT.EXE API ENDPOINTS & HELPERS
// ========================================

// Check if organization is active
async function isOrganizationActive(orgId) {
    try {
        if (!orgId) return false;

        // If Postgres is configured, use it first
        if (pgPool) {
            const result = await pgPool.query(
                'SELECT plan_status, paid_until FROM organizations WHERE id = $1 LIMIT 1',
                [orgId]
            );
            if (result.rows && result.rows.length > 0) {
                const row = result.rows[0];
                if (row.plan_status && String(row.plan_status).toLowerCase() === 'active') return true;
                if (row.paid_until && new Date(row.paid_until) > new Date()) return true;
            }
        }

        // Fallback to Supabase SQL table if available
        if (supabase) {
            const { data, error } = await supabase
                .from('organizations')
                .select('id, plan_status, paid_until')
                .eq('id', orgId)
                .limit(1)
                .maybeSingle();
            if (!error && data) {
                if (data.plan_status && String(data.plan_status).toLowerCase() === 'active') return true;
                if (data.paid_until && new Date(data.paid_until) > new Date()) return true;
            }
            // Final fallback: check auth.users user_metadata (plan_status/paid)
            try {
                const { data: adminUser } = await supabase.auth.admin.getUserById(orgId);
                const meta = adminUser && adminUser.user && (adminUser.user.user_metadata || adminUser.user.raw_user_meta_data) || {};
                const plan = String((meta.plan_status || '')).toLowerCase();
                const paid = !!meta.paid;
                if (plan === 'active' || plan === 'paid' || paid) return true;
            } catch (_) {}
        }

        return false;
    } catch (e) {
        return false;
    }
}

// Lightweight HMAC token utilities (compact JWT-like tokens)
function base64UrlEncode(buffer) {
    return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = 4 - (str.length % 4);
    if (pad !== 4) str = str + '='.repeat(pad);
    return Buffer.from(str, 'base64');
}

function hmacSign(input, secret) {
    return crypto.createHmac('sha256', String(secret)).update(input).digest();
}

function generateDeviceToken(payload, expiresInSeconds = 24 * 60 * 60) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const body = { iat: now, exp: now + expiresInSeconds, ...payload };
    const hEnc = base64UrlEncode(JSON.stringify(header));
    const pEnc = base64UrlEncode(JSON.stringify(body));
    const toSign = `${hEnc}.${pEnc}`;
    const sig = base64UrlEncode(hmacSign(toSign, DEVICE_TOKEN_SECRET));
    return `${toSign}.${sig}`;
}

function verifyDeviceToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [hEnc, pEnc, sig] = parts;
    const expected = base64UrlEncode(hmacSign(`${hEnc}.${pEnc}`, DEVICE_TOKEN_SECRET));
    if (expected !== sig) return null;
    try {
        const payload = JSON.parse(base64UrlDecode(pEnc).toString('utf8'));
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && now > payload.exp) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

// Middleware to require device token
function requireDeviceToken(req, res, next) {
    try {
        let token = req.get('x-device-token');
        if (!token) {
            const auth = req.get('authorization') || '';
            if (auth.toLowerCase().startsWith('device ')) token = auth.slice(7).trim();
        }
        const payload = verifyDeviceToken(token);
        if (!payload) return res.status(401).json({ error: 'unauthorized' });
        req.device = payload;
        next();
    } catch (_) {
        return res.status(401).json({ error: 'unauthorized' });
    }
}

// Middleware: verify Supabase JWT from Authorization: Bearer <token>
async function requireSupabaseUser(req, res, next) {
    try {
        const auth = req.get('authorization') || '';
        const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
        if (!token || !supabase) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data || !data.user) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        req.user = data.user;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'unauthorized' });
    }
}

// Get app catalog
function getAppCatalog() {
    const list = [];
    for (const category of Object.values(apps)) {
        for (const it of category.items) list.push({ id: it.id, name: it.name });
    }
    return list;
}

function getAllAppIds() {
    return getAppCatalog().map((x) => x.id);
}

// Helper: read latest versions stored by update-checker
async function getLatestVersionsMap() {
    try {
        const versionsDir = path.join(__dirname, 'silentinstallers', 'versions');
        const entries = await fsPromises.readdir(versionsDir).catch(() => []);
        const out = {};
        for (const f of entries) {
            if (!f.endsWith('.txt')) continue;
            const appId = f.replace(/\.txt$/i, '');
            try { const v = await fsPromises.readFile(path.join(versionsDir, f), 'utf8'); out[appId] = v.trim(); } catch(_) {}
        }
        return out;
    } catch (_) { return {}; }
}

// App categories and software
const apps = {
    browsers: {
        title: 'Web Browsers',
        icon: 'fa-globe',
        
        items: [
            { id: 'chrome64', name: 'Chrome' },
            { id: 'firefox64', name: 'Firefox' },
            { id: 'edge', name: 'Edge' },
            { id: 'opera64', name: 'Opera' },
            { id: 'tor', name: 'Tor Browser' },
            { id: 'brave', name: 'Brave' },
            { id: 'vivaldi', name: 'Vivaldi' }
        ]
    },
    messaging: {
        title: 'Messaging',
        icon: 'fa-comments',

        items: [
            { id: 'zoom', name: 'Zoom' },
            { id: 'discord', name: 'Discord' },
            { id: 'teams', name: 'Microsoft Teams' },
            { id: 'slack', name: 'Slack' },
            { id: 'pidgin', name: 'Pidgin' },
            { id: 'trillian', name: 'Trillian' },
            { id: 'signal', name: 'Signal' },
            { id: 'telegram', name: 'Telegram Desktop' }
        ]
    },
    email: {
        title: 'Email',
        icon: 'fa-envelope',
        items: [
            { id: 'thunderbird', name: 'Thunderbird' },
            { id: 'emclient', name: 'eM Client' }
        ]
    },
    media: {
        title: 'Media',
        icon: 'fa-music',
        items: [
            { id: 'itunes', name: 'iTunes' },
            { id: 'vlc', name: 'VLC' },
            { id: 'aimp', name: 'AIMP' },
            { id: 'foobar2000', name: 'foobar2000' },
            { id: 'winamp', name: 'Winamp' },
            { id: 'musicbee', name: 'MusicBee' },
            { id: 'audacity', name: 'Audacity' },
            { id: 'klitecodecs', name: 'K-Lite Codecs' },
            { id: 'gom', name: 'GOM' },
            { id: 'spotify', name: 'Spotify' },
            { id: 'cccp', name: 'CCCP' },
            { id: 'mediamonkey', name: 'MediaMonkey' },
            { id: 'handbrake', name: 'HandBrake' },
            { id: 'obs', name: 'OBS Studio' },
            { id: 'mpchc', name: 'MPC-HC' },
            { id: 'potplayer', name: 'PotPlayer' }
        ]
    },
    security: {
        title: 'Security & Passwords',
        icon: 'fa-lock',
        items: [
            { id: 'malwarebytes', name: 'Malwarebytes' },
            { id: 'avast', name: 'Avast Free Antivirus' },
            { id: 'avg', name: 'AVG Free Antivirus' },
            { id: 'spybot2', name: 'Spybot 2' },
            { id: 'avira', name: 'Avira Free Antivirus' },
            { id: 'superantispyware', name: 'SUPERAntiSpyware' },
            { id: 'keepass2', name: 'KeePass 2' },
            { id: 'bitwarden', name: 'Bitwarden' }
        ]
    },
    storage: {
        title: 'Online Storage',
        icon: 'fa-cloud',
        items: [
            { id: 'dropbox', name: 'Dropbox' },
            { id: 'googledrive', name: 'Google Drive' },
            { id: 'onedrive', name: 'OneDrive' },
            { id: 'sugarsync', name: 'SugarSync' }
        ]
    },
    utilities: {
        title: 'System & Disk',
        icon: 'fa-screwdriver-wrench',
        items: [
            { id: 'ccleaner', name: 'CCleaner' },
            { id: 'revo', name: 'Revo Uninstaller' },
            { id: 'windirstat', name: 'WinDirStat' },
            { id: 'wiztree', name: 'WizTree' },
            { id: 'spacemonger', name: 'SpaceMonger 1.4' },
            { id: 'registryworkshop', name: 'Registry Workshop' },
            { id: 'glary', name: 'Glary Utilities' },
            { id: 'everything', name: 'Everything' },
            { id: 'teracopy', name: 'TeraCopy' },
            { id: 'openshell', name: 'Open-Shell' },
            { id: 'powertoys', name: 'PowerToys' },
            { id: 'crystaldiskinfo', name: 'CrystalDiskInfo' },
            { id: 'qemu', name: 'QEMU' }
        ]
    },
    remotenet: {
        title: 'Remote & Network',
        icon: 'fa-network-wired',
        items: [
            { id: 'teamviewer', name: 'TeamViewer' },
            { id: 'anydesk', name: 'AnyDesk' },
            { id: 'tightvnc', name: 'TightVNC' },
            { id: 'wireshark', name: 'Wireshark', note: 'Opens the Npcap setup at the end (needed for capturing traffic; click through it)' },
            { id: 'winsockfix', name: 'WinSockFix' }
        ]
    },
    discburning: {
        title: 'Disc Burning',
        icon: 'fa-compact-disc',
        items: [
            { id: 'imgburn', name: 'ImgBurn' },
            { id: 'cdburnerxp', name: 'CDBurnerXP' },
            { id: 'infrarecorder', name: 'InfraRecorder' }
        ]
    },
    productivity: {
        title: 'Productivity & Accessibility',
        icon: 'fa-bolt',
        items: [
            { id: 'evernote', name: 'Evernote' },
            { id: 'launchy', name: 'Launchy' },
            { id: 'nvaccess', name: 'NVDA (NV Access)' },
            { id: 'chrometransparency', name: 'Chrome Transparency Controller' },
            { id: 'googleearth', name: 'Google Earth Pro' },
            { id: 'thinkorswim', name: 'thinkorswim' },
            { id: 'obsidian', name: 'Obsidian' },
            { id: 'joplin', name: 'Joplin' }
        ]
    },
    torrents: {
        title: 'Torrent Clients',
        icon: 'fa-download',
        items: [
            { id: 'qbittorrent', name: 'qBittorrent' },
            { id: 'transmission', name: 'Transmission' },
            { id: 'deluge', name: 'Deluge' },
            { id: 'biglybt', name: 'BiglyBT' }
        ]
    },
    development: {
        title: 'Developer Tools',
        icon: 'fa-code',
        items: [
            { id: 'notepadplusplus', name: 'Notepad++' },
            { id: 'filezilla', name: 'FileZilla' },
            { id: 'vscode', name: 'Visual Studio Code' },
            { id: 'cursor', name: 'Cursor' },
            { id: 'androidstudio', name: 'Android Studio' },
            { id: 'gitscm', name: 'Git' },
            { id: 'winscp', name: 'WinSCP' },
            { id: 'putty', name: 'PuTTY' },
            { id: 'winmerge', name: 'WinMerge' },
            { id: 'notepad3', name: 'Notepad3' },
            { id: 'eclipse', name: 'Eclipse IDE Installer', note: '(Downloads to Downloads folder)' }
        ]
    },
    imaging: {
        title: 'Imaging',
        icon: 'fa-image',
        items: [
            { id: 'gimp', name: 'GIMP' },
            { id: 'blender', name: 'Blender' },
            { id: 'krita', name: 'Krita' },
            { id: 'paintnet', name: 'Paint.NET' },
            { id: 'irfanview', name: 'IrfanView' },
            { id: 'xnview', name: 'XnView' },
            { id: 'inkscape', name: 'Inkscape' },
            { id: 'faststone', name: 'FastStone Capture' },
            { id: 'greenshot', name: 'Greenshot' },
            { id: 'sharex', name: 'ShareX' }
        ]
    },
    printing3d: {
        title: '3D Printing',
        icon: 'fa-cube',
        items: [
            { id: 'bambustudio', name: 'Bambu Studio' },
            { id: 'ultimakercura', name: 'UltiMaker Cura' }
        ]
    },
    dotnet: {
        title: '.NET Frameworks',
        icon: 'fa-layer-group',
        note: 'Sets system variables',
        items: [
            { id: 'dotnet481', name: '.NET Framework 4.8.1 (64-bit)' },
            { id: 'dotnet481x86', name: '.NET Framework 4.8.1 (32-bit)' },
            { id: 'dotnet9', name: '.NET 9.0 Runtime (64-bit)' },
            { id: 'dotnet9x86', name: '.NET 9.0 Runtime (32-bit)' },
            { id: 'dotnet9desktop', name: '.NET 9.0 Desktop Runtime (64-bit)' },
            { id: 'dotnet9desktopx86', name: '.NET 9.0 Desktop Runtime (32-bit)' },
            { id: 'dotnet10', name: '.NET 10.0 LTS Runtime (64-bit)' },
            { id: 'dotnet10desktop', name: '.NET 10.0 LTS Desktop Runtime (64-bit)' }
        ]
    },
    vcredist: {
        title: 'VC++ Redistributables',
        icon: 'fa-puzzle-piece',
        items: [
            { id: 'vcredist2015-2022x64', name: 'VC++ Redist 2015-2022 (64-bit)' },
            { id: 'vcredist2015-2022x86', name: 'VC++ Redist 2015-2022 (32-bit)' }
        ]
    },
    developmentkits: {
        title: 'Development Kits',
        icon: 'fa-toolbox',
        note: 'Sets JAVA_HOME / PATH',
        items: [
            { id: 'jdk26x64', name: 'Java JDK 26 (64-bit)' },
            { id: 'jdk21x64', name: 'Java JDK 21 LTS (64-bit)' },
            { id: 'temurin25x64', name: 'Java JDK 25 LTS - Eclipse Temurin (64-bit)' },
            { id: 'python315x64', name: 'Python 3.15 (64-bit)' },
            { id: 'python315x86', name: 'Python 3.15 (32-bit)' }
        ]
    },
    documents: {
        title: 'Documents',
        icon: 'fa-file-lines',
        items: [
            { id: 'libreoffice', name: 'LibreOffice' },
            { id: 'openoffice', name: 'OpenOffice' },
            { id: 'foxitreader', name: 'Foxit Reader' },
            { id: 'sumatrapdf', name: 'Sumatra PDF' },
            { id: 'cutepdf', name: 'CutePDF' },
            { id: 'calibre', name: 'calibre (e-books)' }
        ]
    },
    games: {
        title: 'Games',
        icon: 'fa-gamepad',
        items: [
            { id: 'steam', name: 'Steam' },
            { id: 'epicgames', name: 'Epic Games Launcher' },
            { id: 'bluestacks', name: 'BlueStacks' }
        ]
    },
    compression: {
        title: 'Compression',
        icon: 'fa-file-zipper',
        items: [
            { id: '7zip', name: '7-Zip' },
            { id: 'peazip', name: 'PeaZip' },
            { id: 'winrar', name: 'WinRAR' }
        ]
    },
    aiapps: {
        title: 'AI Apps',
        icon: 'fa-robot',
        items: [
            { id: 'claudedesktop', name: 'Claude Desktop' },
            { id: 'ollama', name: 'Ollama' },
            { id: 'lmstudio', name: 'LM Studio' },
            { id: 'jan', name: 'Jan' },
            { id: 'gpt4all', name: 'GPT4All' }
        ]
    },
    other: {
        title: 'ISOs & System Tools',
        icon: 'fa-hard-drive',
        items: [
            { id: 'win11_iso', name: 'Windows 11 ISO', note: '(Downloads to Downloads folder)' },
            { id: 'win10_iso', name: 'Windows 10 ISO', note: '(Downloads to Downloads folder)' },
            { id: 'ubuntu_iso', name: 'Ubuntu 24.04 LTS ISO', note: '(Downloads to Downloads folder)' },
            { id: 'rufus', name: 'Rufus (USB Boot Creator)' }
        ]
    }
};
// Helper to map appId to display name
function getDisplayNameById(appId) {
    for (const category of Object.values(apps)) {
        const app = category.items.find(item => item.id === appId);
        if (app) return app.name;
    }
    return null;
}

async function loadLatestUpdates() {
    try {
        const latestPath = path.join(__dirname, 'public', 'latest-updates.json');
        const raw = await fsPromises.readFile(latestPath, 'utf8');
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed.items) ? parsed.items : [];
        const mapped = items.map(it => {
            const name = getDisplayNameById(it.appId);
            return {
                id: it.appId,
                name,
                inCatalog: Boolean(name),
                version: it.version || '',
                updatedAt: it.updatedAt,
                timeDisplay: new Date(it.updatedAt).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            };
        }).filter(it => it.inCatalog)
          .sort((a, b) => (new Date(b.updatedAt)) - (new Date(a.updatedAt)));
        return mapped;
    } catch (_) {
        return [];
    }
}

// Routes - Place this section right after your apps object definition and before the /generate route

// Page-specific view counter (persisted to file between restarts)
const viewCounterFile = path.join(__dirname, 'public', 'view-counter.json');
let viewCounts = {}; // Object to store counts per page: { '/': 123, '/tools': 456, ... }

(async () => {
    try {
        await fsPromises.mkdir(path.join(__dirname, 'public'), { recursive: true });
        const raw = await fsPromises.readFile(viewCounterFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            viewCounts = parsed;
        } else if (typeof parsed.count === 'number') {
            // Migrate old format to new format
            viewCounts = { '/': parsed.count };
        }
    } catch {}
})();

// Helper function to increment and get view count for a specific page
async function getPageViewCount(pagePath) {
    const normalizedPath = pagePath || '/';
    if (!viewCounts[normalizedPath]) {
        viewCounts[normalizedPath] = 0;
    }
    viewCounts[normalizedPath] += 1;
    // Persist to file (async, don't wait)
    fsPromises.writeFile(viewCounterFile, JSON.stringify(viewCounts), 'utf8').catch(() => {});
    return viewCounts[normalizedPath];
}

app.get('/', async (req, res) => {
    // Always revalidate the front page so layout/CSS changes show up immediately
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const viewCount = await getPageViewCount('/');
    const latestUpdates = await loadLatestUpdates();
    res.render('index', { 
        title: 'Stackdrop - install and update your complete software stack with 1 click',
        apps: apps,
        latestUpdates,
        viewCount
    });
});

// Get server info for installer configuration
app.get('/server-info', (req, res) => {
    // Use the actual server IP address
    const serverIP = '69.48.166.160';
    
    res.json({
        serverIP: serverIP,
        serverPort: process.env.PORT || '3000',
        serverUrl: `http://${serverIP}:${process.env.PORT || '3000'}`
    });
});

// Feedback page
app.get('/feedback', async (req, res) => {
    const viewCount = await getPageViewCount('/feedback');
    // Generate a simple math captcha
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    const answer = num1 + num2;
    const captchaQuestion = `What is ${num1} + ${num2}?`;
    const captchaToken = Buffer.from(`${answer}-${Date.now()}`).toString('base64');
    
    // Store the answer in session or use a signed token
    // For simplicity, we'll validate based on the token
    res.render('feedback', { 
        title: 'Feedback',
        captchaQuestion: captchaQuestion,
        captchaToken: captchaToken,
        captchaAnswer: answer, // Store answer in token for validation
        viewCount
    });
});

// Help page
app.get('/help', async (req, res) => {
    const viewCount = await getPageViewCount('/help');
    res.render('help', { title: 'Help', viewCount });
});
app.get('/help/', (req, res) => {
    res.redirect('/help');
});

// Multi App Installer SEO page
app.get('/multi-app-installer', async (req, res) => {
    const viewCount = await getPageViewCount('/multi-app-installer');
    res.render('multi-app-installer', { viewCount });
});

// Pro page
app.get('/pro', async (req, res) => {
    const viewCount = await getPageViewCount('/pro');
    res.render('pro', { title: 'Stackdrop Pro - Professional Windows Software Management', viewCount });
});

app.get('/biocad', async (req, res) => {
    const viewCount = await getPageViewCount('/biocad');
    res.render('biocad', {
        title: 'BioCAD — The Operating System for Programmable Biology',
        viewCount
    });
});

app.get(['/mbti', '/mbti/'], (req, res) => {
    res.redirect(301, 'https://relationshippolarity.us/mbti');
});

app.get(['/trades', '/trades/'], async (req, res) => {
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'data', 'trades.csv'), 'utf8').trim();
        const lines = raw.split(/\r?\n/);
        const header = lines.shift().split(',');
        const trades = lines.filter(Boolean).map((line) => {
            const cols = [];
            let cur = '';
            let quoted = false;
            for (const ch of line) {
                if (ch === '"') quoted = !quoted;
                else if (ch === ',' && !quoted) { cols.push(cur); cur = ''; }
                else cur += ch;
            }
            cols.push(cur);
            const row = {};
            header.forEach((key, i) => { row[key] = cols[i] || ''; });
            row.price = Number(row.price);
            row.qty = Number(row.qty);
            row.multiplier = Number(row.multiplier);
            row.dollar = Number(row.dollar);
            row.cum_pl = Number(row.cum_pl);
            row.day = String(row.time || '').slice(0, 10);
            return row;
        });
        const bySymbol = {};
        const byDay = {};
        let credits = 0;
        let debits = 0;
        let best = trades[0] || null;
        let worst = trades[0] || null;
        trades.forEach((row) => {
            if (row.dollar >= 0) credits += row.dollar;
            else debits += row.dollar;
            if (!best || row.dollar > best.dollar) best = row;
            if (!worst || row.dollar < worst.dollar) worst = row;
            if (!bySymbol[row.symbol]) bySymbol[row.symbol] = { symbol: row.symbol, dollar: 0, count: 0 };
            bySymbol[row.symbol].dollar += row.dollar;
            bySymbol[row.symbol].count += 1;
            if (!byDay[row.day]) byDay[row.day] = { day: row.day, dollar: 0, count: 0, cum: row.cum_pl };
            byDay[row.day].dollar += row.dollar;
            byDay[row.day].count += 1;
            byDay[row.day].cum = row.cum_pl;
        });
        const symbols = Object.values(bySymbol).sort((a, b) => b.dollar - a.dollar);
        const days = Object.values(byDay);
        const bestDay = days.reduce((a, b) => (!a || b.dollar > a.dollar ? b : a), null);
        const worstDay = days.reduce((a, b) => (!a || b.dollar < a.dollar ? b : a), null);
        const viewCount = await getPageViewCount('/trades');
        res.render('trades', {
            title: 'Trades — Stackdrop',
            viewCount,
            trades,
            symbols,
            days,
            summary: {
                count: trades.length,
                pl: trades.length ? trades[trades.length - 1].cum_pl : 0,
                credits,
                debits,
                winners: trades.filter((row) => row.dollar > 0).length,
                losers: trades.filter((row) => row.dollar < 0).length,
                winDays: days.filter((day) => day.dollar > 0).length,
                lossDays: days.filter((day) => day.dollar < 0).length,
                best,
                worst,
                bestDay,
                worstDay,
                first: trades[0] ? trades[0].day : '',
                last: trades.length ? trades[trades.length - 1].day : ''
            }
        });
    } catch (err) {
        console.error('trades page', err);
        res.status(500).send('Trades could not be loaded.');
    }
});

const FUTURES_SYMBOLS = [
    'CL=F', 'NG=F', 'HO=F', 'RB=F', 'GC=F', 'SI=F', 'HG=F',
    'ES=F', 'NQ=F', 'YM=F', 'RTY=F', 'ZN=F', 'ZB=F', '6E=F',
    'ZS=F', 'ZL=F', 'ZM=F', 'ZC=F', 'ZW=F', 'LE=F', 'HE=F', 'GF=F'
];
let futuresQuoteCache = { at: 0, data: null };

function futuresExchange(fullName, code) {
    const name = String(fullName || '').toLowerCase();
    if (name.includes('nymex') || name.includes('ny merc')) return 'NYMEX';
    if (name.includes('comex')) return 'COMEX';
    if (name.includes('cbot') || code === 'CBT') return 'CBOT';
    if (name.includes('cme') || code === 'CME') return 'CME';
    return fullName || code || '';
}

function futuresMonth(shortName) {
    const match = String(shortName || '').match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[- ]?(\d{2,4})/i);
    if (!match) return '';
    const year = match[2].length === 4 ? match[2].slice(-2) : match[2];
    return match[1].slice(0, 1).toUpperCase() + match[1].slice(1, 3).toLowerCase() + ' ' + year;
}

async function fetchFuturesQuotes() {
    const now = Date.now();
    if (futuresQuoteCache.data && now - futuresQuoteCache.at < 600000) return futuresQuoteCache.data;
    const quotes = await Promise.all(FUTURES_SYMBOLS.map(async (symbol) => {
        try {
            const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=1d';
            const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!response.ok) return { symbol, error: response.status };
            const body = await response.json();
            const meta = body && body.chart && body.chart.result && body.chart.result[0] && body.chart.result[0].meta;
            if (!meta) return { symbol, error: 'empty' };
            return {
                symbol,
                price: meta.regularMarketPrice,
                currency: meta.currency || '',
                exchange: futuresExchange(meta.fullExchangeName, meta.exchangeName),
                contract: futuresMonth(meta.shortName),
                time: meta.regularMarketTime || null
            };
        } catch (err) {
            return { symbol, error: 'fetch' };
        }
    }));
    futuresQuoteCache = { at: now, data: quotes };
    return quotes;
}

app.get('/futures/quotes', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const quotes = await fetchFuturesQuotes();
        res.json({ ok: true, quotes });
    } catch (err) {
        console.error('futures quotes', err);
        res.status(502).json({ ok: false, quotes: [] });
    }
});

app.get(['/futures', '/futures/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'futures', 'index.html'));
});

app.get(['/creditcards', '/creditcards/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'certs', 'creditcards', 'index.html'));
});

app.get(['/rso', '/rso/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'rso', 'index.html'));
});

app.get(['/hosts', '/hosts/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'hosts', 'index.html'));
});

// Partner visa static assets (css/js/data/json) + wizard pages
app.use('/partnervisa', express.static(path.join(__dirname, 'partnervisa'), {
    index: false,
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html') || filePath.endsWith('.json')) {
            res.set('Cache-Control', 'no-store');
        }
    }
}));

const partnerVisa = require('./partnervisa/packet');
const partnerVisaEvidence = require('./partnervisa/server/evidence-packet');
const mountPartnerVisaEvidence = require('./partnervisa/server/mount-evidence-routes');

const partnerVisaStorage = require('./partnervisa/storage');
const partnerVisaAuth = require('./partnervisa/auth');

function partnerVisaUser(req, res) {
    const user = partnerVisaAuth.readSession(req);
    if (!user) {
        res.status(401).json({ error: 'Log in first.' });
        return null;
    }
    return user;
}

app.get(['/partnervisa', '/partnervisa/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'partnervisa', 'index.html'));
});

app.get(['/partnervisa/start', '/partnervisa/start/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'partnervisa', 'start.html'));
});
app.get(['/partnervisa/invite', '/partnervisa/invite/'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'partnervisa', 'invite.html'));
});

app.get(['/partnervisa/which-visa', '/partnervisa/which-visa/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'partnervisa', 'which-visa.html'));
});
mountPartnerVisaEvidence(app, partnerVisaEvidence);




app.get(['/partnervisa/app', '/partnervisa/app/'], (req, res) => {
    res.redirect(302, '/partnervisa/start');
});

app.get('/partnervisa/api/me', (req, res) => {
    const user = partnerVisaAuth.readSession(req);
    if (!user) return res.status(401).json({ error: 'Log in first.' });
    res.json({ email: user.email });
});

app.post('/partnervisa/api/signup', async (req, res) => {
    try {
        const result = await partnerVisaAuth.signup(req.body && req.body.email, req.body && req.body.password);
        if (result.error) return res.status(400).json({ error: result.error });
        partnerVisaAuth.setSession(res, result.user);
        res.json({ email: result.user.email });
    } catch (error) {
        console.error('Partner visa signup error:', error.message);
        res.status(500).json({ error: 'Could not create the account.' });
    }
});

app.post('/partnervisa/api/login', async (req, res) => {
    try {
        const result = await partnerVisaAuth.login(req.body && req.body.email, req.body && req.body.password);
        if (result.error) return res.status(400).json({ error: result.error });
        partnerVisaAuth.setSession(res, result.user);
        res.json({ email: result.user.email });
    } catch (error) {
        console.error('Partner visa login error:', error.message);
        res.status(500).json({ error: 'Could not log in.' });
    }
});

app.post('/partnervisa/api/logout', (req, res) => {
    partnerVisaAuth.clearSession(res);
    res.json({ ok: true });
});

app.get('/partnervisa/api/schema', (req, res) => {
    res.json(partnerVisa.schema());
});

app.post('/partnervisa/api/upload-url', async (req, res) => {
    try {
        const user = partnerVisaUser(req, res);
        if (!user) return;
        const body = req.body || {};
        const bucket = String(body.bucket || '');
        if (!partnerVisa.BUCKETS.some((item) => item.id === bucket)) {
            return res.status(400).json({ error: 'Choose a bucket.' });
        }
        const bytes = Number(body.bytes);
        if (!Number.isFinite(bytes) || bytes < 1 || bytes > partnerVisa.MAX_BYTES) {
            return res.status(400).json({ error: 'Each file must be 20 MB or smaller.' });
        }
        if (!partnerVisa.fileKey('0'.repeat(32), bucket, body.contentType, body.filename)) {
            return res.status(400).json({ error: 'Use a PDF or a photo (JPG, PNG, WEBP, HEIC).' });
        }
        if (!partnerVisaStorage.configured()) {
            return res.status(500).json({ error: 'File storage is not configured yet.' });
        }
        const saved = partnerVisa.applyDraft(body, { userId: user.id });
        if (saved.error) return res.status(404).json({ error: saved.error });
        const packet = saved.packet;
        if (packet.paidAt) return res.status(400).json({ error: 'This packet is already generated.' });
        const key = partnerVisa.fileKey(packet.id, bucket, body.contentType, body.filename);
        const contentType = partnerVisa.contentTypeFor(body.contentType, body.filename);
        if (!key || !contentType) return res.status(400).json({ error: 'Use a PDF or a photo (JPG, PNG, WEBP, HEIC).' });
        const upload = await partnerVisaStorage.signedUpload(key, contentType, bytes);
        res.json({
            packetId: packet.id,
            key,
            uploadUrl: upload.uploadUrl,
            headers: { 'Content-Type': contentType }
        });
    } catch (error) {
        console.error('Partner visa upload error:', error.message);
        res.status(500).json({ error: 'Upload could not start.' });
    }
});

app.post('/partnervisa/api/file/remove', async (req, res) => {
    const user = partnerVisaUser(req, res);
    if (!user) return;
    const body = req.body || {};
    const packet = partnerVisa.readPacket(String(body.packetId || ''));
    if (packet && packet.userId && packet.userId !== user.id) return res.status(404).json({ error: 'File not found.' });
    const key = String(body.key || '');
    if (!packet || packet.paidAt || !key.startsWith(packet.id + '/')) {
        return res.status(404).json({ error: 'File not found.' });
    }
    try { await partnerVisaStorage.remove(key); } catch (error) { /* the list no longer points at it */ }
    res.json({ ok: true });
});

app.get('/partnervisa/file', async (req, res) => {
    const user = partnerVisaAuth.readSession(req);
    if (!user) return res.redirect('/partnervisa/');
    const packet = partnerVisa.readPacket(String(req.query.packet || ''));
    if (packet && packet.userId && packet.userId !== user.id) return res.status(404).send('File not found.');
    const key = String(req.query.key || '');
    if (!packet || !packet.paidAt || !partnerVisa.packetHasKey(packet, key)) {
        return res.status(404).send('File not found.');
    }
    try {
        const url = await partnerVisaStorage.signedDownload(key);
        res.set('Cache-Control', 'no-store');
        res.redirect(url);
    } catch (error) {
        console.error('Partner visa file error:', error.message);
        res.status(404).send('File not found.');
    }
});

app.post('/partnervisa/api/checkout', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ error: 'Card payment is not configured yet.' });
        }
        const user = partnerVisaUser(req, res);
        if (!user) return;
        const saved = partnerVisa.applyDraft(req.body || {}, { validate: true, userId: user.id });
        if (saved.error) return res.status(saved.error === 'That packet was not found.' ? 404 : 400).json({ error: saved.error });
        const packet = saved.packet;
        if (!packet.paidAt) {
            const invalid = partnerVisa.validate(packet);
            if (invalid) return res.status(400).json({ error: invalid });
        }
        if (packet.paidAt) {
            return res.json({ url: `/partnervisa/packet/${packet.id}` });
        }
        const base = process.env.PUBLIC_BASE_URL || process.env.SERVER_URL || 'https://stackdrop.it';
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{
                quantity: 1,
                price_data: {
                    currency: partnerVisa.CURRENCY,
                    unit_amount: partnerVisa.PRICE_CENTS,
                    product_data: {
                        name: 'Partner visa evidence packet',
                        description: 'One online and printable evidence index for one couple.'
                    }
                }
            }],
            metadata: { product: 'partnervisa', packetId: packet.id },
            success_url: `${base}/partnervisa/packet/${packet.id}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${base}/partnervisa/?canceled=1`,
            billing_address_collection: 'auto'
        });
        packet.stripeSessionId = session.id;
        partnerVisa.writePacket(packet);
        res.json({ url: session.url });
    } catch (error) {
        console.error('Partner visa checkout error:', error.message);
        res.status(500).json({ error: 'Payment could not start.' });
    }
});

app.get('/partnervisa/packet/:id', async (req, res) => {
    const user = partnerVisaAuth.readSession(req);
    if (!user) return res.redirect('/partnervisa/');
    const packet = partnerVisa.readPacket(req.params.id);
    if (packet && packet.userId && packet.userId !== user.id) return res.status(404).send('Packet not found.');
    if (!packet) return res.status(404).send('Packet not found.');
    if (!packet.paidAt && req.query.session_id && stripe) {
        try {
            const session = await stripe.checkout.sessions.retrieve(String(req.query.session_id));
            const paid = session
                && session.payment_status === 'paid'
                && session.metadata
                && session.metadata.packetId === packet.id
                && session.amount_total === partnerVisa.PRICE_CENTS;
            if (paid) {
                packet.paidAt = new Date().toISOString();
                packet.stripeSessionId = session.id;
                partnerVisa.writePacket(packet);
            }
        } catch (error) {
            console.error('Partner visa payment check error:', error.message);
        }
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(packet.paidAt ? partnerVisa.renderPacket(packet) : partnerVisa.renderLocked(packet));
});

app.get(['/alcohol-stroke-alzheimer', '/alcohol-stroke-alzheimer/'], async (req, res) => {
    const viewCount = await getPageViewCount('/alcohol-stroke-alzheimer');
    res.render('alcohol-stroke-alzheimer', {
        title: 'Drinking, stroke, and Alzheimer’s',
        viewCount
    });
});

// Dashboard page (customer side)
app.get('/dashboard', (req, res) => {
    res.render('dashboard', { 
        title: 'Dashboard - Stackdrop', 
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '', 
        supabaseAnon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '' 
    });
});

// Per-device app management page (Pro). Auth is enforced client-side via Supabase
// session and server-side by the /api/devices/:id/apps endpoints (ownership check).
app.get('/device', (req, res) => {
    res.render('device', {
        title: 'Device Management - Stackdrop',
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
        supabaseAnon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
    });
});

// Login page
app.get('/login', (req, res) => {
    res.render('login', { 
        title: 'Login - Stackdrop',
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        supabaseAnon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    });
});

// Legacy admin route - forward to main login
app.get(['/admin', '/admin/login'], (req, res) => {
    const redirectTarget = '/login' + (req.query.redirect ? `?redirect=${encodeURIComponent(req.query.redirect)}` : '');
    res.redirect(redirectTarget);
});

// ========================================
// SUPERADMIN ROUTES (owner-only dashboard)
// ========================================
// Access is gated by a single secret password (verified server-side). A valid
// password issues a short-lived signed cookie; the password and the service-role
// `supabase` client never reach the browser.
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '.6x3j9b3w}{A!';
// Accounts that must never be deleted/banned via the dashboard (e.g. the owner).
const SA_PROTECTED_EMAIL = (process.env.SUPERADMIN_EMAIL || 'ryan5439@yahoo.com').toLowerCase();
const SA_COOKIE = 'sd_sa';
const SA_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
// Stable signing secret derived from the password so sessions survive restarts
// without the password itself ever being stored or exposed.
const SA_SECRET = crypto.createHash('sha256').update('sd-superadmin::' + SUPERADMIN_PASSWORD).digest();

function signSaToken() {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SA_TTL_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', SA_SECRET).update(payload).digest('base64url');
    return payload + '.' + sig;
}

function verifySaToken(value) {
    if (!value || typeof value !== 'string' || !value.includes('.')) return false;
    const [payload, sig] = value.split('.');
    if (!payload || !sig) return false;
    const expected = crypto.createHmac('sha256', SA_SECRET).update(payload).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    try {
        const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return !!obj && typeof obj.exp === 'number' && obj.exp > Date.now();
    } catch (_) {
        return false;
    }
}

function hasSaSession(req) {
    return verifySaToken(req.cookies && req.cookies[SA_COOKIE]);
}

function passwordMatches(input) {
    const a = Buffer.from(String(input == null ? '' : input));
    const b = Buffer.from(SUPERADMIN_PASSWORD);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Middleware: gate the owner-only data APIs behind a valid superadmin session cookie.
function requireSuperadmin(req, res, next) {
    if (!hasSaSession(req)) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

// In-memory audit trail of state-changing superadmin actions (most recent first).
const SA_AUDIT_MAX = 200;
const saAuditLog = [];
function saAudit(req, action, details) {
    const entry = {
        at: new Date().toISOString(),
        ip: saClientIp(req),
        action,
        details: details || {}
    };
    saAuditLog.unshift(entry);
    if (saAuditLog.length > SA_AUDIT_MAX) saAuditLog.length = SA_AUDIT_MAX;
    console.log(`[superadmin] ${entry.ip} ${action} ${JSON.stringify(entry.details)}`);
}

// Brute-force protection: lock an IP for 30 minutes after 10 failed attempts.
const SA_MAX_ATTEMPTS = 10;
const SA_LOCK_MS = 30 * 60 * 1000; // 30 minutes
const saAttempts = new Map(); // ip -> { count, lockUntil }

function saClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

// Verify the secret password (server-side) and issue a signed session cookie.
app.post('/superadmin/auth', (req, res) => {
    const ip = saClientIp(req);
    const now = Date.now();
    const rec = saAttempts.get(ip);

    // Currently locked out?
    if (rec && rec.lockUntil && rec.lockUntil > now) {
        const retryAfter = Math.ceil((rec.lockUntil - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
            error: 'too_many_attempts',
            retryAfterSeconds: retryAfter,
            retryAfterMinutes: Math.ceil(retryAfter / 60)
        });
    }
    // Expired lock or stale window -> start fresh.
    if (rec && ((rec.lockUntil && rec.lockUntil <= now) || (!rec.lockUntil && rec.windowEnd && rec.windowEnd <= now))) {
        saAttempts.delete(ip);
    }

    const password = (req.body && (req.body.password != null ? req.body.password : req.body.pw)) || '';
    if (!passwordMatches(password)) {
        const cur = saAttempts.get(ip) || { count: 0, windowEnd: now + SA_LOCK_MS };
        cur.count += 1;
        cur.windowEnd = cur.windowEnd || now + SA_LOCK_MS;
        if (cur.count >= SA_MAX_ATTEMPTS) {
            cur.lockUntil = now + SA_LOCK_MS;
            saAttempts.set(ip, cur);
            const retryAfter = Math.ceil(SA_LOCK_MS / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                error: 'too_many_attempts',
                retryAfterSeconds: retryAfter,
                retryAfterMinutes: Math.ceil(retryAfter / 60)
            });
        }
        saAttempts.set(ip, cur);
        return res.status(401).json({
            error: 'invalid_password',
            attemptsRemaining: SA_MAX_ATTEMPTS - cur.count
        });
    }

    // Correct password -> clear any failed-attempt record for this IP.
    saAttempts.delete(ip);
    res.cookie(SA_COOKIE, signSaToken(), {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure || req.get('x-forwarded-proto') === 'https',
        maxAge: SA_TTL_MS,
        path: '/'
    });
    res.json({ ok: true });
});

// Periodically prune expired lockout/attempt records to bound memory.
setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of saAttempts) {
        const expiry = rec.lockUntil || rec.windowEnd || 0;
        if (expiry && expiry <= now) saAttempts.delete(ip);
    }
}, 10 * 60 * 1000).unref();

// Clear the superadmin session.
app.post('/superadmin/logout', (req, res) => {
    res.clearCookie(SA_COOKIE, { path: '/' });
    res.json({ ok: true });
});

// Password entry page (shown when there is no valid superadmin session).
app.get('/superadmin-login', (req, res) => {
    if (hasSaSession(req)) return res.redirect('/superadmin');
    res.render('superadmin-login', {});
});

// Superadmin dashboard - requires a valid superadmin session cookie. All
// privileged data is fetched from the owner-only API endpoints below
// (service-role key stays server-side).
app.get('/superadmin', (req, res) => {
    if (!hasSaSession(req)) return res.redirect('/superadmin-login');
    return res.render('superadmin', {});
});

// ---- Owner-only superadmin data APIs (service-role queries run server-side) ----
app.get('/api/superadmin/users', requireSuperadmin, async (req, res) => {
    try {
        const { data: authData, error: authError } = await supabase.auth.admin.listUsers();
        if (authError) throw authError;
        const { data: orgs, error: orgError } = await supabase.from('organizations').select('*');
        if (orgError) console.error('Superadmin orgs error:', orgError.message);

        const now = Date.now();
        const users = (authData.users || []).map((user) => {
            const org = (orgs || []).find((o) => o.id === user.id) || {};
            const bannedUntil = user.banned_until ? new Date(user.banned_until).getTime() : 0;
            return {
                id: user.id,
                email: user.email,
                last_sign_in_at: user.last_sign_in_at,
                plan_status: org.plan_status || 'inactive',
                plan_type: org.plan_type || 'free',
                device_limit: org.device_limit || 1,
                created_at: org.created_at || user.created_at,
                banned: bannedUntil > now,
                is_owner: (user.email || '').toLowerCase() === SA_PROTECTED_EMAIL
            };
        });
        res.json({ users });
    } catch (e) {
        console.error('Superadmin users API error:', e.message);
        res.status(500).json({ error: 'failed_to_load_users' });
    }
});

app.get('/api/superadmin/devices', requireSuperadmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('devices')
            .select('*')
            .order('last_seen_at', { ascending: false });
        if (error) throw error;
        res.json({ devices: data || [] });
    } catch (e) {
        console.error('Superadmin devices API error:', e.message);
        res.status(500).json({ error: 'failed_to_load_devices' });
    }
});

app.get('/api/superadmin/apps', requireSuperadmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('device_apps')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(500);
        if (error) throw error;
        res.json({ apps: data || [] });
    } catch (e) {
        console.error('Superadmin apps API error:', e.message);
        res.status(500).json({ error: 'failed_to_load_apps' });
    }
});

app.get('/api/superadmin/activity', requireSuperadmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('device_heartbeats')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(10);
        if (error) throw error;
        res.json({ activity: data || [] });
    } catch (e) {
        console.error('Superadmin activity API error:', e.message);
        res.status(500).json({ error: 'failed_to_load_activity' });
    }
});

// Recent superadmin action audit trail.
app.get('/api/superadmin/audit', requireSuperadmin, (req, res) => {
    res.json({ audit: saAuditLog.slice(0, 100) });
});

// ---- Owner-only superadmin WRITE APIs (mutations run with service-role) ----

// Create a new user account (optionally with plan settings).
app.post('/api/superadmin/users', requireSuperadmin, async (req, res) => {
    try {
        const body = req.body || {};
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'invalid_email' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'weak_password' });
        }

        const { data, error } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });
        if (error) {
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('already') || msg.includes('exist') || msg.includes('registered')) {
                return res.status(409).json({ error: 'email_exists' });
            }
            throw error;
        }

        const newId = data && data.user && data.user.id;

        // Optionally seed the organizations row with plan settings.
        if (newId) {
            const org = { id: newId };
            if (body.plan_status !== undefined) {
                const v = String(body.plan_status).toLowerCase();
                if (['active', 'inactive'].includes(v)) org.plan_status = v;
            }
            if (body.plan_type !== undefined) {
                const v = String(body.plan_type).toLowerCase();
                if (['free', 'pro'].includes(v)) org.plan_type = v;
            }
            if (body.device_limit !== undefined) {
                const n = parseInt(body.device_limit, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 100000) org.device_limit = n;
            }
            if (Object.keys(org).length > 1) {
                const { error: orgErr } = await supabase.from('organizations').upsert(org, { onConflict: 'id' });
                if (orgErr) console.error('Superadmin create-user org upsert error:', orgErr.message);
            }
        }

        saAudit(req, 'user.create', { id: newId, email });
        res.json({ ok: true, id: newId });
    } catch (e) {
        console.error('Superadmin user create error:', e.message);
        res.status(500).json({ error: 'failed_to_create_user' });
    }
});

// Update a user's subscription/plan settings (stored on the organizations row).
app.patch('/api/superadmin/users/:id', requireSuperadmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'missing_id' });

        const body = req.body || {};
        const update = { id };

        if (body.plan_status !== undefined) {
            const v = String(body.plan_status).toLowerCase();
            if (!['active', 'inactive'].includes(v)) return res.status(400).json({ error: 'invalid_plan_status' });
            update.plan_status = v;
        }
        if (body.plan_type !== undefined) {
            const v = String(body.plan_type).toLowerCase();
            if (!['free', 'pro'].includes(v)) return res.status(400).json({ error: 'invalid_plan_type' });
            update.plan_type = v;
        }
        if (body.device_limit !== undefined) {
            const n = parseInt(body.device_limit, 10);
            if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'invalid_device_limit' });
            update.device_limit = n;
        }
        if (Object.keys(update).length === 1) return res.status(400).json({ error: 'no_fields' });

        const { error } = await supabase.from('organizations').upsert(update, { onConflict: 'id' });
        if (error) throw error;

        saAudit(req, 'user.update', { id, changes: { ...update, id: undefined } });
        res.json({ ok: true });
    } catch (e) {
        console.error('Superadmin user update error:', e.message);
        res.status(500).json({ error: 'failed_to_update_user' });
    }
});

// Ban or unban a user (blocks them from signing in).
app.post('/api/superadmin/users/:id/ban', requireSuperadmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'missing_id' });
        const ban = !!(req.body && req.body.ban);

        // Look up the target to protect the owner account.
        const { data: target, error: getErr } = await supabase.auth.admin.getUserById(id);
        if (getErr || !target || !target.user) return res.status(404).json({ error: 'user_not_found' });
        if ((target.user.email || '').toLowerCase() === SA_PROTECTED_EMAIL) {
            return res.status(403).json({ error: 'cannot_modify_owner' });
        }

        const { error } = await supabase.auth.admin.updateUserById(id, {
            ban_duration: ban ? '876000h' : 'none'
        });
        if (error) throw error;

        saAudit(req, ban ? 'user.ban' : 'user.unban', { id, email: target.user.email });
        res.json({ ok: true, banned: ban });
    } catch (e) {
        console.error('Superadmin user ban error:', e.message);
        res.status(500).json({ error: 'failed_to_update_ban' });
    }
});

// Permanently delete a user and their associated data.
app.delete('/api/superadmin/users/:id', requireSuperadmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'missing_id' });

        const { data: target, error: getErr } = await supabase.auth.admin.getUserById(id);
        if (getErr || !target || !target.user) return res.status(404).json({ error: 'user_not_found' });
        const email = target.user.email || '';
        if (email.toLowerCase() === SA_PROTECTED_EMAIL) {
            return res.status(403).json({ error: 'cannot_delete_owner' });
        }

        // Clean up related rows (ignore individual table errors so a missing
        // table never blocks the account deletion).
        for (const table of ['device_apps', 'devices', 'device_heartbeats']) {
            try { await supabase.from(table).delete().eq('org_id', id); } catch (_) {}
            try { await supabase.from(table).delete().eq('user_id', id); } catch (_) {}
        }
        try { await supabase.from('organizations').delete().eq('id', id); } catch (_) {}

        const { error } = await supabase.auth.admin.deleteUser(id);
        if (error) throw error;

        saAudit(req, 'user.delete', { id, email });
        res.json({ ok: true });
    } catch (e) {
        console.error('Superadmin user delete error:', e.message);
        res.status(500).json({ error: 'failed_to_delete_user' });
    }
});

// Delete a device and its installed-app records.
app.delete('/api/superadmin/devices/:deviceId', requireSuperadmin, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '').trim();
        if (!deviceId) return res.status(400).json({ error: 'missing_device_id' });

        try { await supabase.from('device_apps').delete().eq('device_id', deviceId); } catch (_) {}
        const { error } = await supabase.from('devices').delete().eq('device_id', deviceId);
        if (error) throw error;

        saAudit(req, 'device.delete', { device_id: deviceId });
        res.json({ ok: true });
    } catch (e) {
        console.error('Superadmin device delete error:', e.message);
        res.status(500).json({ error: 'failed_to_delete_device' });
    }
});

// Toggle (or set) an app's auto-update flag.
app.patch('/api/superadmin/apps', requireSuperadmin, async (req, res) => {
    try {
        const body = req.body || {};
        const enabled = !!body.auto_update_enabled;
        let q = supabase.from('device_apps').update({ auto_update_enabled: enabled });

        if (body.id !== undefined && body.id !== null && body.id !== '') {
            q = q.eq('id', body.id);
        } else if (body.device_id && body.app_name) {
            q = q.eq('device_id', String(body.device_id)).eq('app_name', String(body.app_name));
        } else {
            return res.status(400).json({ error: 'missing_identifier' });
        }

        const { error } = await q;
        if (error) throw error;

        saAudit(req, 'app.auto_update', {
            id: body.id, device_id: body.device_id, app_name: body.app_name, enabled
        });
        res.json({ ok: true, auto_update_enabled: enabled });
    } catch (e) {
        console.error('Superadmin app update error:', e.message);
        res.status(500).json({ error: 'failed_to_update_app' });
    }
});

// ========================================
// AI AGENT AUTHENTICATION ROUTES (STANDALONE)
// ========================================
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// AI Agent Login Page
app.get('/ai-agent/login', (req, res) => {
    res.render('ai-agent-login', { error: null });
});

// AI Agent Signup Page
app.get('/ai-agent/signup', (req, res) => {
    res.render('ai-agent-signup', { error: null });
});

// AI Agent Signup Handler
app.post('/ai-agent/signup', async (req, res) => {
    try {
        const { fullname, username, email, password, confirm_password, plan } = req.body;

        // Validation
        if (!fullname || !username || !email || !password) {
            return res.render('ai-agent-signup', { error: 'All fields are required' });
        }

        if (password !== confirm_password) {
            return res.render('ai-agent-signup', { error: 'Passwords do not match' });
        }

        if (password.length < 8) {
            return res.render('ai-agent-signup', { error: 'Password must be at least 8 characters' });
        }

        // Check if user exists
        const { data: existingUser } = await supabase
            .from('ai_users')
            .select('id')
            .or(`email.eq.${email},username.eq.${username}`)
            .single();

        if (existingUser) {
            return res.render('ai-agent-signup', { error: 'Email or username already exists' });
        }

        // Hash password
        const password_hash = await bcrypt.hash(password, 10);

        // Create user
        const { data: newUser, error: insertError } = await supabase
            .from('ai_users')
            .insert([{
                email,
                username,
                full_name: fullname,
                password_hash,
                plan: plan || 'free',
                api_credits: plan === 'pro' ? 999999 : 1000
            }])
            .select()
            .single();

        if (insertError) {
            console.error('Signup error:', insertError);
            return res.render('ai-agent-signup', { error: 'Signup failed. Please try again.' });
        }

        // Create session token
        const token = jwt.sign({ userId: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '30d' });

        // Save session to database
        await supabase.from('ai_user_sessions').insert([{
            user_id: newUser.id,
            token,
            ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            user_agent: req.get('user-agent'),
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }]);

        // Set cookie
        res.cookie('ai_agent_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });

        // Redirect to dashboard
        res.redirect('/ai-agent/dashboard');

    } catch (error) {
        console.error('Signup error:', error);
        res.render('ai-agent-signup', { error: 'An error occurred. Please try again.' });
    }
});

// AI Agent Login Handler
app.post('/ai-agent/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.render('ai-agent-login', { error: 'Username and password are required' });
        }

        // Find user by email or username
        const { data: user } = await supabase
            .from('ai_users')
            .select('*')
            .or(`email.eq.${username},username.eq.${username}`)
            .single();

        if (!user) {
            return res.render('ai-agent-login', { error: 'Invalid credentials' });
        }

        // Check password
        const validPassword = await bcrypt.compare(password, user.password_hash);

        if (!validPassword) {
            return res.render('ai-agent-login', { error: 'Invalid credentials' });
        }

        // Check if account is active
        if (user.status !== 'active') {
            return res.render('ai-agent-login', { error: 'Account is suspended or inactive' });
        }

        // Create session token
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

        // Save session to database
        await supabase.from('ai_user_sessions').insert([{
            user_id: user.id,
            token,
            ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            user_agent: req.get('user-agent'),
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }]);

        // Update last login
        await supabase.from('ai_users').update({
            last_login_at: new Date().toISOString(),
            last_login_ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
        }).eq('id', user.id);

        // Set cookie
        res.cookie('ai_agent_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });

        // Redirect to dashboard
        res.redirect('/ai-agent/dashboard');

    } catch (error) {
        console.error('Login error:', error);
        res.render('ai-agent-login', { error: 'An error occurred. Please try again.' });
    }
});

// AI Agent Logout
app.get('/ai-agent/logout', async (req, res) => {
    const token = req.cookies.ai_agent_token;
    
    if (token) {
        // Delete session from database
        await supabase.from('ai_user_sessions').delete().eq('token', token);
    }
    
    res.clearCookie('ai_agent_token');
    res.redirect('/ai-agent/login');
});

// AI Agent Dashboard (requires authentication)
app.get('/ai-agent/dashboard', async (req, res) => {
    try {
        const token = req.cookies.ai_agent_token;
        
        if (!token) {
            return res.redirect('/ai-agent/login');
        }

        // Verify token
        const decoded = jwt.verify(token, JWT_SECRET);

        // Get user details
        const { data: user } = await supabase
            .from('ai_users')
            .select('*')
            .eq('id', decoded.userId)
            .single();

        if (!user) {
            res.clearCookie('ai_agent_token');
            return res.redirect('/ai-agent/login');
        }

        // Render AI dashboard (you already have ai-agent-dashboard.ejs)
        res.render('ai-agent-dashboard', { 
            user,
            title: 'AI Agent Dashboard'
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.clearCookie('ai_agent_token');
        res.redirect('/ai-agent/login');
    }
});

// AI Agent Middleware for Protected Routes
function requireAIAuth(req, res, next) {
    const token = req.cookies.ai_agent_token;
    
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.aiUser = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Example protected API route
app.get('/ai-agent/api/profile', requireAIAuth, async (req, res) => {
    try {
        const { data: user } = await supabase
            .from('ai_users')
            .select('id, username, email, full_name, plan, api_credits, created_at')
            .eq('id', req.aiUser.userId)
            .single();

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// ========================================
// END AI AGENT AUTHENTICATION ROUTES
// ========================================

// Feedback submission handler
app.post('/feedback', async (req, res) => {
    const { name = '', email = '', subject = '', message = '', website = '', captcha_answer = '', captcha_token = '' } = req.body || {};

    // Honeypot trap: if website is filled, silently accept
    if (website && String(website).trim().length > 0) {
        return res.status(200).json({ success: true });
    }

    // Validate captcha
    let captchaValid = false;
    if (captcha_token && captcha_answer) {
        try {
            const decoded = Buffer.from(captcha_token, 'base64').toString('utf8');
            const [expectedAnswer] = decoded.split('-');
            const userAnswer = String(captcha_answer).trim();
            captchaValid = userAnswer === expectedAnswer;
        } catch (e) {
            captchaValid = false;
        }
    }

    // Validate required fields
    if (!message || String(message).trim().length === 0) {
        if (req.accepts('html')) {
            return res.render('feedback', { 
                title: 'Feedback',
                submitted: true,
                success: false,
                error: 'missing_message',
                name: name,
                email: email,
                subject: subject,
                message: message,
                captchaQuestion: 'What is 3 + 4?',
                captchaToken: ''
            });
        }
        return res.status(400).json({ success: false, error: 'missing_message' });
    }

    // Check captcha
    if (!captchaValid) {
        // Generate new captcha for retry
        const num1 = Math.floor(Math.random() * 10) + 1;
        const num2 = Math.floor(Math.random() * 10) + 1;
        const answer = num1 + num2;
        const captchaQuestion = `What is ${num1} + ${num2}?`;
        const captchaToken = Buffer.from(`${answer}-${Date.now()}`).toString('base64');
        
        if (req.accepts('html')) {
            return res.render('feedback', { 
                title: 'Feedback',
                submitted: true,
                success: false,
                error: 'captcha',
                name: name,
                email: email,
                subject: subject,
                message: message,
                captchaQuestion: captchaQuestion,
                captchaToken: captchaToken
            });
        }
        return res.status(400).json({ success: false, error: 'captcha' });
    }

    const clean = (v) => String(v || '').toString().slice(0, 5000);
    const payload = {
        name: clean(name),
        email: clean(email),
        subject: clean(subject) || 'Stackdrop Feedback',
        message: clean(message),
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        userAgent: req.get('user-agent') || '',
        submittedAt: new Date().toISOString()
    };

    // Always append to a local log for backup
    try {
        const logLine = JSON.stringify(payload) + '\n';
        await fsPromises.appendFile(path.join(__dirname, 'feedback-submissions.log'), logLine, 'utf8');
    } catch (e) {
        console.error('Failed to write feedback log:', e.message);
    }

    // Send email to multiple recipients
    const feedbackRecipients = process.env.FEEDBACK_TO 
        ? process.env.FEEDBACK_TO.split(',').map(e => e.trim()).filter(e => e)
        : ['ryan5439@yahoo.com', 'stackdrop.it@gmail.com'];
    
    const emailBody = `New feedback submitted\n\nName: ${payload.name}\nEmail: ${payload.email}\nSubject: ${payload.subject}\n\nMessage:\n${payload.message}\n\nIP: ${payload.ip}\nUser-Agent: ${payload.userAgent}\nSubmitted: ${payload.submittedAt}`;
    
    const htmlBody = `
        <h2>New Feedback Submitted</h2>
        <p><strong>Name:</strong> ${payload.name || 'Not provided'}</p>
        <p><strong>Email:</strong> ${payload.email || 'Not provided'}</p>
        <p><strong>Subject:</strong> ${payload.subject}</p>
        <hr>
        <p><strong>Message:</strong></p>
        <p>${payload.message.replace(/\n/g, '<br>')}</p>
        <hr>
        <p><small><strong>IP:</strong> ${payload.ip}<br>
        <strong>User-Agent:</strong> ${payload.userAgent}<br>
        <strong>Submitted:</strong> ${payload.submittedAt}</small></p>
    `;
    
    // Send to all recipients in one email (Mailgun supports multiple recipients)
    let emailSent = false;
    try {
        emailSent = await sendEmail(
            feedbackRecipients, // Pass array of recipients
            `[Stackdrop Feedback] ${payload.subject}`,
            emailBody,
            htmlBody
        );
        if (emailSent) {
            console.log(`✅ Feedback email sent to: ${feedbackRecipients.join(', ')}`);
        }
        } catch (e) {
        console.error('❌ Feedback email failed:', e.message);
    }

    // Respond success
    if (req.accepts('html')) {
        // Generate new captcha for next submission
        const num1 = Math.floor(Math.random() * 10) + 1;
        const num2 = Math.floor(Math.random() * 10) + 1;
        const answer = num1 + num2;
        const captchaQuestion = `What is ${num1} + ${num2}?`;
        const captchaToken = Buffer.from(`${answer}-${Date.now()}`).toString('base64');
        
        return res.render('feedback', { 
            title: 'Feedback', 
            submitted: true,
            success: true,
            error: emailSent ? null : 'email_send_failed',
            captchaQuestion: captchaQuestion,
            captchaToken: captchaToken
        });
    }
    res.json({ success: true, emailSent: emailSent });
});

// ========================================
// FORGOT PASSWORD SYSTEM
// ========================================

// Shared email sending function
async function sendEmail(to, subject, textBody, htmlBody = null) {
    const fromAddress = process.env.FEEDBACK_FROM || 'stackdrop.it@gmail.com';
    const fromName = process.env.FEEDBACK_FROM_NAME || 'Stackdrop';
    const fromHeader = fromAddress.includes('<') ? fromAddress : `${fromName} <${fromAddress}>`;
    const replyTo = process.env.FEEDBACK_REPLY_TO || fromAddress.replace(/^[^<]*<([^>]+)>.*$/, '$1').trim() || fromAddress;
    const mailgunDomain = process.env.MAILGUN_DOMAIN || 'stackdrop.it';
    
    // Try Mailgun API first (faster and more reliable)
    if (process.env.MAILGUN_API_KEY) {
        try {
            const formData = require('form-data');
            const Mailgun = require('mailgun.js');
            const mailgun = new Mailgun(formData);
            
            // Use API key as-is (Mailgun accepts both formats)
            const mg = mailgun.client({
                username: 'api',
                key: process.env.MAILGUN_API_KEY
            });
            
            // Handle multiple recipients (comma-separated or array)
            const recipients = Array.isArray(to) ? to.join(',') : to;
            
            await mg.messages.create(mailgunDomain, {
                from: fromHeader,
                to: recipients,
                subject: subject,
                text: textBody,
                html: htmlBody || textBody.replace(/\n/g, '<br>'),
                'h:Reply-To': replyTo,
                'o:tracking': 'no',
                'o:tracking-clicks': 'no',
                'o:tracking-opens': 'no',
            });
            
            console.log('✅ Email sent via Mailgun API to:', recipients);
            return true;
        } catch (e) {
            console.warn('Mailgun API failed, trying SMTP:', e.message);
        }
    }

    // Fallback to SMTP
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpSecure = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';

    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
        console.error('❌ Email not configured. Set MAILGUN_API_KEY or SMTP settings in .env');
        return false;
    }

        try {
            const nodemailer = require('nodemailer');
            const transporter = nodemailer.createTransport({
                host: smtpHost,
                port: smtpPort,
                secure: smtpSecure,
            auth: { 
                user: smtpUser, 
                pass: smtpPass 
            }
            });
        
            await transporter.sendMail({
                from: fromHeader,
                replyTo: replyTo,
                to: to,
                subject: subject,
                text: textBody,
                html: htmlBody || textBody.replace(/\n/g, '<br>')
            });
        
        console.log('✅ Email sent via SMTP (Mailgun) to:', to);
            return true;
        } catch (e) {
        console.error('❌ SMTP email failed:', e.message);
            return false;
        }
}

// Password reset code storage (in-memory, expires after 15 minutes)
const resetCodes = new Map(); // { email: { code: '123456', expires: Date, attempts: 0 } }

// Clean up expired codes every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [email, data] of resetCodes.entries()) {
        if (data.expires < now) {
            resetCodes.delete(email);
        }
    }
}, 5 * 60 * 1000);

// Forgot Password - Send 6-digit code
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }

        const emailLower = email.toLowerCase().trim();

        // Generate 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 15 * 60 * 1000; // 15 minutes

        // Store code
        resetCodes.set(emailLower, { code, expires, attempts: 0 });

        // Send email with code
        const subject = 'Stackdrop - Password Reset Code';
        const textBody = `Your password reset code is: ${code}\n\nThis code will expire in 15 minutes.\n\nIf you didn't request this, please ignore this email.\n\n- Stackdrop Team`;
        const htmlBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #333;">Password Reset Code</h2>
                <p>Your password reset code is:</p>
                <div style="background: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
                    ${code}
                </div>
                <p style="color: #666;">This code will expire in 15 minutes.</p>
                <p style="color: #666;">If you didn't request this, please ignore this email.</p>
                <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
                <p style="color: #999; font-size: 12px;">- Stackdrop Team</p>
            </div>
        `;

        const emailSent = await sendEmail(emailLower, subject, textBody, htmlBody);

        if (emailSent) {
            console.log(`✅ Password reset code sent to: ${emailLower}`);
            res.json({ success: true, message: 'Reset code sent to your email' });
        } else {
            // FALLBACK: Log code to console if email fails (for development/testing)
            console.log(`\n${'='.repeat(60)}`);
            console.log(`⚠️  EMAIL FAILED - PASSWORD RESET CODE FOR: ${emailLower}`);
            console.log(`📧 Reset Code: ${code}`);
            console.log(`⏰ Expires in 15 minutes`);
            console.log(`${'='.repeat(60)}\n`);
            
            // Still return success so user can proceed
            res.json({ 
                success: true, 
                message: 'Reset code generated. (Email service unavailable - check server console)' 
            });
        }
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Verify Reset Code
app.post('/api/verify-reset-code', async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: 'Email and code required' });
        }

        const emailLower = email.toLowerCase().trim();
        const resetData = resetCodes.get(emailLower);

        if (!resetData) {
            return res.status(400).json({ error: 'No reset code found. Please request a new one.' });
        }

        if (Date.now() > resetData.expires) {
            resetCodes.delete(emailLower);
            return res.status(400).json({ error: 'Reset code expired. Please request a new one.' });
        }

        // Rate limiting: max 5 attempts
        if (resetData.attempts >= 5) {
            resetCodes.delete(emailLower);
            return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
        }

        resetData.attempts++;

        if (resetData.code !== code.trim()) {
            return res.status(400).json({ error: 'Invalid code. Please try again.' });
        }

        // Code is valid - return success
        res.json({ success: true, message: 'Code verified' });
    } catch (error) {
        console.error('Verify code error:', error);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Reset Password
app.post('/api/reset-password', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;

        if (!email || !code || !newPassword) {
            return res.status(400).json({ error: 'Email, code, and new password required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const emailLower = email.toLowerCase().trim();
        const resetData = resetCodes.get(emailLower);

        if (!resetData) {
            return res.status(400).json({ error: 'No reset code found. Please start over.' });
        }

        if (Date.now() > resetData.expires) {
            resetCodes.delete(emailLower);
            return res.status(400).json({ error: 'Reset code expired. Please start over.' });
        }

        if (resetData.code !== code.trim()) {
            return res.status(400).json({ error: 'Invalid code.' });
        }

        // Update password via Supabase Admin API
        if (supabase) {
            try {
                // Get user by email
                const { data: users, error: fetchError } = await supabase.auth.admin.listUsers();
                
                if (fetchError) {
                    console.error('Error fetching users:', fetchError);
                    return res.status(500).json({ error: 'Failed to reset password. Please try again.' });
                }

                const user = users.users.find(u => u.email?.toLowerCase() === emailLower);

                if (!user) {
                    return res.status(404).json({ error: 'User not found.' });
                }

                // Update user password
                const { error: updateError } = await supabase.auth.admin.updateUserById(
                    user.id,
                    { password: newPassword }
                );

                if (updateError) {
                    console.error('Error updating password:', updateError);
                    return res.status(500).json({ error: 'Failed to reset password. Please try again.' });
                }

                // Clear the reset code
                resetCodes.delete(emailLower);

                console.log(`✅ Password reset successful for: ${emailLower}`);
                res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
            } catch (supabaseError) {
                console.error('Supabase password reset error:', supabaseError);
                res.status(500).json({ error: 'Failed to reset password. Please contact support.' });
            }
        } else {
            res.status(500).json({ error: 'Authentication service not configured' });
        }
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Serve EXE files for download by the installer
app.get('/downloads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join('/var/www/stackdrop/silentinstallers', filename);
    
    // Check if file exists (follow symlinks)
    let realPath = filePath;
    try {
        // Resolve symlinks to get the actual file path
        realPath = fs.realpathSync(filePath);
    } catch (err) {
        // If realpath fails, file doesn't exist
        return res.status(404).json({ error: 'File not found' });
    }
    
    // Double-check the resolved path exists
    if (!fs.existsSync(realPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    // Set proper headers for binary file download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Serve the file for download (use realPath to follow symlinks)
    res.download(realPath, filename, (err) => {
        if (err) {
            console.error('Download error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download failed' });
            }
        }
    });
});

// App installer filename mapping (moved before /generate route)
const installerFileMap = {
    opera32: 'operasilentinstaller_32.nsi',
    opera64: 'operasilentinstaller_64.nsi',
    tor: 'torsilentinstaller.nsi',
    firefox32: 'firefoxsilentinstaller_32.nsi',
    firefox64: 'firefoxsilentinstaller_64.nsi',
    chrome32: 'chromesilentinstaller_32.nsi',
    chrome64: 'chromesilentinstaller_64.nsi',
    anydesk: 'anydesksilentinstaller.nsi',
    avast: 'avastsilentinstaller.nsi',
    avira: 'avirasilentinstaller.nsi',
    malwarebytes: 'malwarebytessilentinstaller.nsi',
    avg: 'avgsilentinstaller.nsi',
    ccleaner: 'ccleanersilentinstaller.nsi',
    edge: 'edgesilentinstaller.nsi',
    filezilla: 'filezillasilentinstaller.nsi',
    imgburn: 'imgburnsilentinstaller.nsi',
    thinkorswim: 'thinkorswimsilentinstaller.nsi',
    revo: 'revosilentinstaller.nsi',
    windirstat: 'windirstatsilentinstaller.nsi',
    spacemonger: 'spacemongersilentinstaller.nsi',
    registryworkshop: 'registryworkshopsilentinstaller.nsi',
    notepadplusplus: 'notepadplusplussilentinstaller.nsi',
    skype: 'skypesilentinstaller.nsi',
    slack: 'slacksilentinstaller.nsi',
    spotify: 'spotifysilentinstaller.nsi',
    teams: 'teamssilentinstaller.nsi',
    teamviewer: 'teamviewersilentinstaller.nsi',
    vlc: 'vlcsilentinstaller.nsi',
    vscode: 'vscodesilentinstaller.nsi',
    winamp: 'winampsilentinstaller.nsi',
    zoom: 'zoomsilentinstaller.nsi',
    discord: 'discordsilentinstaller.nsi',
    itunes: 'itunessilentinstaller.nsi',
    spybot2: 'spybot2silentinstaller.nsi',
    superantispyware: 'superantispywaresilentinstaller.nsi',
    aimp: 'aimpsilentinstaller.nsi',
    foobar2000: 'foobar2000silentinstaller.nsi',
    musicbee: 'musicbeesilentinstaller.nsi',
    audacity: 'audacitysilentinstaller.nsi',
    klitecodecs: 'klitecodecssilentinstaller.nsi',
    gom: 'gomsilentinstaller.nsi',
    cccp: 'cccpsilentinstaller.nsi',
    mediamonkey: 'mediamonkeysilentinstaller.nsi',
    handbrake: 'handbrakesilentinstaller.nsi',
    qemu: 'qemusilentinstaller.nsi',
    googleearth: 'googleearthsilentinstaller.nsi',
    obs: 'obssilentinstaller.nsi',
    cursor: 'cursorsilentinstaller.nsi',
    chrometransparency: 'chrometransparencysilentinstaller.nsi',
    winsockfix: 'winsockfixsilentinstaller.nsi',
    androidstudio: 'androidstudiosilentinstaller.nsi',
    qbittorrent: 'qbittorrentsilentinstaller.nsi',
    transmission: 'transmissionsilentinstaller.nsi',
    deluge: 'delugesilentinstaller.nsi',
    biglybt: 'biglybtsilentinstaller.nsi',
    // Imaging tools
    gimp: 'gimpsilentinstaller.nsi',
    blender: 'blendersilentinstaller.nsi',
    krita: 'kritasilentinstaller.nsi',
    paintnet: 'paintnetsilentinstaller.nsi',
    irfanview: 'irfanviewsilentinstaller.nsi',
    xnview: 'xnviewsilentinstaller.nsi',
    inkscape: 'inkscapesilentinstaller.nsi',
    faststone: 'faststonesilentinstaller.nsi',
    greenshot: 'greenshotsilentinstaller.nsi',
    sharex: 'sharexsilentinstaller.nsi',
    // Games
    steam: 'steamsilentinstaller.nsi',
    epicgames: 'epicgamessilentinstaller.nsi',
    bluestacks: 'bluestackssilentinstaller.nsi',
    // Compression
    '7zip': '7zipsilentinstaller.nsi',
    peazip: 'peazipsilentinstaller.nsi',
    winrar: 'winrarsilentinstaller.nsi',
    // Document readers
    foxitreader: 'foxitreadersilentinstaller.nsi',
    sumatrapdf: 'sumatrpdfsilentinstaller.nsi',
    cutepdf: 'cutepdfsilentinstaller.nsi',
    // AI Apps
    claudedesktop: 'claudedesktopsilentinstaller.nsi',
    ollama: 'ollamasilentinstaller.nsi',
    lmstudio: 'lmstudiosilentinstaller.nsi',
    jan: 'jansilentinstaller.nsi',
    gpt4all: 'gpt4allsilentinstaller.nsi',
    // .NET Framework mappings
    dotnet481: 'dotnet481silentinstaller.nsi',
    dotnet481x86: 'dotnet481x86silentinstaller.nsi',
    dotnet9: 'dotnet9silentinstaller.nsi',
    dotnet9x86: 'dotnet9x86silentinstaller.nsi',
    dotnet9desktop: 'dotnet9desktopsilentinstaller.nsi',
    dotnet9desktopx86: 'dotnet9desktopx86silentinstaller.nsi',
    // Development tools mappings
    jdk26x64: 'jdk26x64silentinstaller.nsi',
    jdk21x64: 'jdk21x64silentinstaller.nsi',
    python315x64: 'python315x64silentinstaller.nsi',
    python315x86: 'python315x86silentinstaller.nsi',
    // Document apps
    openoffice: 'openofficesilentinstaller.nsi',
    libreoffice: 'libreofficesilentinstaller.nsi',
    // Online Storage
    dropbox: 'dropboxsilentinstaller.nsi',
    googledrive: 'googledrivesilentinstaller.nsi',
    onedrive: 'onedrivesilentinstaller.nsi',
    thunderbird: 'thunderbirdsilentinstaller.nsi',
    emclient: 'emclientsilentinstaller.nsi',
    // ISOs & System Tools
    win11_iso: 'win11_isosilentinstaller.nsi',
    win10_iso: 'win10_isosilentinstaller.nsi',
    ubuntu_iso: 'ubuntu_isosilentinstaller.nsi',
    rufus: 'rufussilentinstaller.nsi',
    // Ninite parity additions (2026-10-02). These use the dynamic multi-app NSIS
    // generator (generateMultiAppNSIS); the value only marks the app as supported.
    brave: 'bravesilentinstaller.nsi',
    vivaldi: 'vivaldisilentinstaller.nsi',
    pidgin: 'pidginsilentinstaller.nsi',
    trillian: 'trilliansilentinstaller.nsi',
    sugarsync: 'sugarsyncsilentinstaller.nsi',
    wireshark: 'wiresharksilentinstaller.nsi',
    powertoys: 'powertoyssilentinstaller.nsi',
    tightvnc: 'tightvncsilentinstaller.nsi',
    teracopy: 'teracopysilentinstaller.nsi',
    cdburnerxp: 'cdburnerxpsilentinstaller.nsi',
    infrarecorder: 'infrarecordersilentinstaller.nsi',
    launchy: 'launchysilentinstaller.nsi',
    wiztree: 'wiztreesilentinstaller.nsi',
    glary: 'glarysilentinstaller.nsi',
    openshell: 'openshellsilentinstaller.nsi',
    everything: 'everythingsilentinstaller.nsi',
    keepass2: 'keepass2silentinstaller.nsi',
    evernote: 'evernotesilentinstaller.nsi',
    // Added 2026-10-02 (pass e)
    signal: 'signalsilentinstaller.nsi',
    telegram: 'telegramsilentinstaller.nsi',
    bitwarden: 'bitwardensilentinstaller.nsi',
    mpchc: 'mpchcsilentinstaller.nsi',
    potplayer: 'potplayersilentinstaller.nsi',
    obsidian: 'obsidiansilentinstaller.nsi',
    joplin: 'joplinsilentinstaller.nsi',
    calibre: 'calibresilentinstaller.nsi',
    crystaldiskinfo: 'crystaldiskinfosilentinstaller.nsi',
    notepad3: 'notepad3silentinstaller.nsi',
    nvaccess: 'nvaccesssilentinstaller.nsi',
    gitscm: 'gitscmsilentinstaller.nsi',
    winscp: 'winscpsilentinstaller.nsi',
    putty: 'puttysilentinstaller.nsi',
    winmerge: 'winmergesilentinstaller.nsi',
    eclipse: 'eclipsesilentinstaller.nsi',
    bambustudio: 'bambustudiosilentinstaller.nsi',
    ultimakercura: 'ultimakercurasilentinstaller.nsi',
    dotnet10: 'dotnet10silentinstaller.nsi',
    dotnet10desktop: 'dotnet10desktopsilentinstaller.nsi',
    'vcredist2015-2022x64': 'vcredist2015-2022x64silentinstaller.nsi',
    'vcredist2015-2022x86': 'vcredist2015-2022x86silentinstaller.nsi',
    temurin25x64: 'temurin25x64silentinstaller.nsi',
    // Add more mappings as needed for other .nsi files in the folder
};

// Generate installer endpoint
app.post('/generate', async (req, res) => {
    let selectedApps = req.body.apps || [];
    if (typeof selectedApps === 'string') selectedApps = [selectedApps];
    if (!Array.isArray(selectedApps)) selectedApps = [];
    const exeName = 'StackdropInstaller.exe';

    if (selectedApps.length === 0) {
        return res.status(400).json({ error: 'Please select at least one app.' });
    }

    // Validate all selected apps have NSIS scripts
    const missingApps = selectedApps.filter(appId => !installerFileMap[appId]);
    if (missingApps.length > 0) {
        return res.status(400).json({ error: `No NSIS script found for apps: ${missingApps.join(', ')}` });
    }

    const baseTempDir = '/var/tmp/stackdrop-installer';
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const tempDir = path.join(baseTempDir, uniqueId);

    try {
        await fsPromises.mkdir(baseTempDir, { recursive: true });
        await fsPromises.mkdir(tempDir, { recursive: true });

        const exePath = path.join(tempDir, exeName);
        
        // Use bundled individual NSIS scripts for apps with local installer payloads
        if (selectedApps.length === 1 && ['chrometransparency', 'spacemonger', 'winsockfix'].includes(selectedApps[0])) {
            const appId = selectedApps[0];
            const individualNsiFile = path.join(__dirname, 'silentinstallers', installerFileMap[appId]);
            const nsisScriptPath = path.join(tempDir, path.basename(individualNsiFile));

            if (appId === 'chrometransparency') {
                const chromeExeSource = path.join(__dirname, 'ChromeTransparentPlugin', 'ChromeTransparency.exe');
                const chromeExeFallback = path.join(__dirname, 'silentinstallers', 'ChromeTransparency.exe');
                const chromeExeDest = path.join(tempDir, 'ChromeTransparency.exe');
                const chromeSource = fs.existsSync(chromeExeSource) ? chromeExeSource : chromeExeFallback;
                await fsPromises.copyFile(chromeSource, chromeExeDest);
            } else if (appId === 'spacemonger') {
                const exeSource = path.join(__dirname, 'silentinstallers', getInstallerFileName(appId));
                const exeDest = path.join(tempDir, getInstallerFileName(appId));
                await fsPromises.copyFile(exeSource, exeDest);
            } else if (appId === 'winsockfix') {
                const exeSource = path.join(__dirname, 'silentinstallers', getInstallerFileName(appId));
                const exeDest = path.join(tempDir, 'winsockfix.exe');
                await fsPromises.copyFile(exeSource, exeDest);
            }

            await fsPromises.copyFile(individualNsiFile, nsisScriptPath);

            const escapedExePath = exePath.replace(/"/g, '\\"');
            const makensisCmd = `cd "${tempDir}" && makensis -V4 -NOCD -DOUTPUT_FILE="${escapedExePath}" "${path.basename(individualNsiFile)}"`;
            const { stdout, stderr } = await exec(makensisCmd);
            console.log('makensis stdout:', stdout);
            if (stderr) console.error('makensis stderr:', stderr);
        } else {
        // Create a dynamic multi-app NSIS script
        const multiAppScript = generateMultiAppNSIS(selectedApps, exePath);
        const nsisScriptPath = path.join(tempDir, 'multi_app_installer.nsi');
        await fsPromises.writeFile(nsisScriptPath, multiAppScript, 'utf8');

        // Run makensis from the temp directory
        const makensisCmd = `cd "${tempDir}" && makensis -V4 -NOCD "multi_app_installer.nsi"`;
        const { stdout, stderr } = await exec(makensisCmd);
        console.log('makensis stdout:', stdout);
        if (stderr) console.error('makensis stderr:', stderr);
        }

        const exeStats = await fsPromises.stat(exePath);
        if (exeStats.size === 0) {
            throw new Error('EXE file was created but has zero size');
        }

        res.download(exePath, exeName, (err) => {
            if (err) console.error('Download error:', err);
            setTimeout(() => {
                fsPromises.rm(tempDir, { recursive: true, force: true }).catch(e => console.error('Cleanup error:', e));
            }, 100000);
        });
    } catch (error) {
        console.error('Error generating installer:', error);
        // Always return JSON, never HTML
        if (!res.headersSent) {
            res.status(500).json({ error: true, message: 'Failed to generate installer: ' + (error.message || error.toString()) });
        }
        fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
});

// Function to escape strings for NSIS (prevent unterminated strings)
function getServerlistPrimaryUrl(appId) {
    try {
        const serverListPath = path.join(__dirname, 'silentinstallers', 'serverlist.txt');
        const content = fs.readFileSync(serverListPath, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim() || line.startsWith('//')) continue;
            const firstColon = line.indexOf(':');
            if (firstColon === -1) continue;
            let id = line.slice(0, firstColon);
            let urlStart = firstColon + 1;
            if (/^\d+$/.test(id)) {
                const secondColon = line.indexOf(':', firstColon + 1);
                if (secondColon === -1) continue;
                id = line.slice(firstColon + 1, secondColon);
                urlStart = secondColon + 1;
            }
            if (id !== appId) continue;
            const proto = line.indexOf('://', urlStart);
            if (proto === -1) continue;
            const urlEnd = line.indexOf(':', proto + 3);
            return urlEnd === -1 ? line.slice(urlStart) : line.slice(urlStart, urlEnd);
        }
    } catch (_) {}
    return null;
}

// Official page to open for 'open_url' apps (serverlist primary URL first)
function getOpenUrlTarget(appId) {
    // (No ISO entries here: Windows/Ubuntu ISOs are served from our own server, download_only)
    const fallback = {};
    return getServerlistPrimaryUrl(appId) || fallback[appId] || null;
}

function escapeNSISString(str) {
    if (!str) return '';
    // For NSIS strings that are already inside quotes, we should NOT escape quotes
    // as that would break the string parsing. Only escape dollar signs.
    // In JavaScript replace(), $$ in replacement = single $, so we need $$$$ for $$
    return str
        .replace(/\$/g, '$$$$')    // Escape dollar signs (NSIS uses $$ for literal $)
        .replace(/\r/g, '')        // Remove carriage returns
        .replace(/\n/g, ' ')       // Replace newlines with spaces
        .replace(/\t/g, ' ')       // Replace tabs with spaces
        .replace(/"/g, "'");       // Replace quotes with single quotes (safer for NSIS strings)
}

// Function to generate multi-app NSIS script
function generateMultiAppNSIS(selectedApps, exePath) {
    const {
        getInstallerFileName,
        getInstallerCandidates,
        getSilentFlag,
        getInstallMethod,
        getPortableFolder,
        getPortableExeName,
    } = installerConfig;

    const serverUrl = process.env.SERVER_URL || 'https://stackdrop.it';
    const downloadBases = [
        `${serverUrl}/downloads`,
        `${serverUrl}/silentinstallers`
    ];

    const getEnvNsisForApp = (appId) => {
        try {
            const py = appId.match(/^python(\d+)(x64|x86)$/);
            if (py) {
                const ver = py[1];
                const arch = py[2];
                const pf = arch === 'x64' ? '$PROGRAMFILES64' : '$PROGRAMFILES32';
                const pyRoot = `${pf}\\Python${ver}`;
                return `\n        ; Set PATH for Python (${arch})\n        ReadRegStr $R0 HKLM "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" "Path"\n        StrCpy $R1 "$R0;${pyRoot};${pyRoot}\\Scripts"\n        WriteRegExpandStr HKLM "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" "Path" "$R1"\n        SendMessage 0xFFFF 0x1A 0 "STR:Environment"`;
            }
            const jdk = appId.match(/^jdk(\d+)(x64|x86)$/);
            if (jdk) {
                const major = jdk[1];
                const arch = jdk[2];
                const pf = arch === 'x64' ? '$PROGRAMFILES64' : '$PROGRAMFILES32';
                const javaHome = `${pf}\\Java\\jdk-${major}`;
                return `\n        ; Set JAVA_HOME and update PATH for JDK ${major} (${arch})\n        WriteRegExpandStr HKLM "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" "JAVA_HOME" "${javaHome}"\n        ReadRegStr $R0 HKLM "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" "Path"\n        StrCpy $R1 "$R0;%JAVA_HOME%\\bin"\n        WriteRegExpandStr HKLM "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" "Path" "$R1"\n        SendMessage 0xFFFF 0x1A 0 "STR:Environment"`;
            }
        } catch (_) {}
        return '';
    };

    const appInstallSections = selectedApps.map((appId, index) => {
        const rawAppName = getAppDisplayName(appId);
        const appName = rawAppName.replace(/\$/g, '$$');
        const installerFileName = getInstallerFileName(appId);
        const installerCandidates = getInstallerCandidates(appId);
        const silentFlag = getSilentFlag(appId);
        const installMethod = getInstallMethod(appId);
        // msiexec needs the package saved with a .msi extension, even when the
        // server-side canonical name is a legacy *.exe alias (zoom, libreoffice, ...)
        const localSaveName = (installMethod === 'msi' && !/\.msi$/i.test(installerFileName))
            ? installerFileName.replace(/\.[^.\\/]+$/, '') + '.msi'
            : installerFileName;
        const portableFolder = getPortableFolder(appId) || rawAppName.replace(/[^a-zA-Z0-9]/g, '');
        const portableExeName = getPortableExeName(appId) || path.basename(installerFileName);
        const envSnippet = getEnvNsisForApp(appId);

        if (installMethod === 'open_url') {
            // Vendor only offers the file through an interactive web page (e.g. Microsoft ISOs)
            const pageUrl = escapeNSISString(getOpenUrlTarget(appId) || serverUrl);
            const sectionNameOpen = rawAppName.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '_');
            return `
Section "Open${sectionNameOpen}" SEC${index + 1}
    DetailPrint "Opening the official download page for ${appName}..."
    ExecShell "open" "${pageUrl}"
SectionEnd`;
        }

        const buildAttempts = (list, labelPrefix) => {
            let blocks = '';
            list.forEach((fname, attemptIdx) => {
                downloadBases.forEach((base, baseIdx) => {
                    const label = `${labelPrefix}_next_${attemptIdx}_${baseIdx}`;
                    const escapedFname = escapeNSISString(fname);
                    const escapedBase = escapeNSISString(base);
                    const escapedLocalSaveName = escapeNSISString(localSaveName);
                    blocks += `\n        DetailPrint "Trying ${escapedFname} from ${escapedBase}..."\n        inetc::get /SILENT /NOCANCEL "${escapedBase}/${escapedFname}" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${label}\n        ${label}:\n`;
                });
            });
            return blocks;
        };

        const escapedLocalSaveName = escapeNSISString(localSaveName);
        const escapedServerUrl = escapeNSISString(serverUrl);
        const escapedPortableFolder = escapeNSISString(portableFolder);
        const escapedPortableExeName = escapeNSISString(portableExeName);
        const escapedAppName = escapeNSISString(rawAppName);

        let installExecLine;
        if (installMethod === 'copy_exe' || installMethod === 'copy_portable') {
            installExecLine = `CreateDirectory "$PROGRAMFILES64\\\\${escapedPortableFolder}"\n        CopyFiles /SILENT "${'$'}TEMP\\\\${escapedLocalSaveName}" "$PROGRAMFILES64\\\\${escapedPortableFolder}\\\\${escapedPortableExeName}"`;
        } else if (installMethod === 'download_only') {
            installExecLine = `CreateDirectory "${'$'}DownloadsDir"\n        CopyFiles /SILENT "${'$'}TEMP\\\\${escapedLocalSaveName}" "${'$'}DownloadsDir\\\\${escapedLocalSaveName}"`;
        } else if (installMethod === 'download_shortcuts') {
            const shortcutName = escapeNSISString(portableExeName.replace(/\.exe$/i, '.lnk'));
            installExecLine = `CreateDirectory "${'$'}DownloadsDir"\n        CopyFiles /SILENT "${'$'}TEMP\\\\${escapedLocalSaveName}" "${'$'}DownloadsDir\\\\${escapedPortableExeName}"\n        CreateShortCut "$DESKTOP\\\\${shortcutName}" "${'$'}DownloadsDir\\\\${escapedPortableExeName}" "" "${'$'}DownloadsDir\\\\${escapedPortableExeName}" 0\n        CreateDirectory "$APPDATA\\\\Microsoft\\\\Internet Explorer\\\\Quick Launch\\\\User Pinned\\\\TaskBar"\n        CreateShortCut "$APPDATA\\\\Microsoft\\\\Internet Explorer\\\\Quick Launch\\\\User Pinned\\\\TaskBar\\\\${shortcutName}" "${'$'}DownloadsDir\\\\${escapedPortableExeName}" "" "${'$'}DownloadsDir\\\\${escapedPortableExeName}" 0`;
        } else if (installMethod === 'unzip_exe') {
            const ps1Name = `stackdrop_unzip_${index}.ps1`;
            const escapedPs1Name = escapeNSISString(ps1Name);
            const ps1Lines = [
                `$z = Join-Path $env:TEMP '${localSaveName.replace(/'/g, "''")}'`,
                `$d = Join-Path $env:TEMP 'stackdrop_unzip_${index}'`,
                `if (Test-Path $d) { Remove-Item -Recurse -Force $d }`,
                `New-Item -ItemType Directory -Path $d -Force | Out-Null`,
                `Expand-Archive -LiteralPath $z -DestinationPath $d -Force`,
                `$e = Get-ChildItem $d -Filter *.exe | Select-Object -First 1`,
                `if (-not $e) { exit 1 }`,
                `Start-Process -FilePath $e.FullName -ArgumentList '${silentFlag}' -Wait -WindowStyle Hidden`,
                `exit $LASTEXITCODE`,
            ];
            const fileWriteBlock = ps1Lines.map((line) => {
                const escapedLine = escapeNSISString(line);
                return `        FileWrite $4 "${escapedLine}$\\r$\\n"`;
            }).join('\n');
            installExecLine = `FileOpen $4 "${'$'}TEMP\\\\${escapedPs1Name}" w\n${fileWriteBlock}\n        FileClose $4\n        ExecWait '"$SYSDIR\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${'$'}TEMP\\\\${escapedPs1Name}"' $3\n        Delete "${'$'}TEMP\\\\${escapedPs1Name}"`;
        } else if (installMethod === 'msi') {
            installExecLine = `ExecWait 'msiexec /i "${'$'}TEMP\\\\${escapedLocalSaveName}" ${silentFlag}' $3`;
        } else {
            installExecLine = `ExecWait '"${'$'}TEMP\\\\${escapedLocalSaveName}" ${silentFlag}' $3`;
        }

        const x64Attempts = buildAttempts(installerCandidates.x64, `x64_${index}`);
        let vendorFallback = '';
        if (appId === 'chrome64') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Chrome..."\n        inetc::get /SILENT /NOCANCEL "https://dl.google.com/chrome/install/latest/chrome_installer.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'ccleaner') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for CCleaner..."\n        inetc::get /SILENT /NOCANCEL "https://download.ccleaner.com/ccsetup.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'winsockfix') {
            const vendorLabel = `vendor_${index}_next`;
            const winsockUrl = getServerlistPrimaryUrl('winsockfix') || 'https://files1.majorgeeks.com/0b93caee71a9d214d0bbbc5622ea29507e3b8a7a/internet/winsockfix.exe';
            vendorFallback = `\n        DetailPrint "Trying vendor URL for WinSockFix..."\n        inetc::get /SILENT /NOCANCEL "${escapeNSISString(winsockUrl)}" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'googleearth') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Google Earth Pro..."\n        inetc::get /SILENT /NOCANCEL "https://dl.google.com/dl/earth/client/advanced/current/googleearthprowin-x64.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'steam') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Steam..."\n        inetc::get /SILENT /NOCANCEL "https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'obs') {
            const vendorLabel = `vendor_${index}_next`;
            const obsVendorUrl = getServerlistPrimaryUrl('obs') || 'https://github.com/obsproject/obs-studio/releases/latest/download/OBS-Studio-32.1.2-Windows-x64-Installer.exe';
            vendorFallback = `\n        DetailPrint "Trying vendor URL for OBS Studio..."\n        inetc::get /SILENT /NOCANCEL "${escapeNSISString(obsVendorUrl)}" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'rufus') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Rufus..."\n        inetc::get /SILENT /NOCANCEL "https://github.com/pbatard/rufus/releases/download/v4.14/rufus-4.14.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'thunderbird') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Thunderbird..."\n        inetc::get /SILENT /NOCANCEL "https://download.mozilla.org/?product=thunderbird-latest&os=win64&lang=en-US" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'emclient') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for eM Client..."\n        inetc::get /SILENT /NOCANCEL "https://www.emclient.com/dist/latest/setup.msi" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'ollama') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Ollama..."\n        inetc::get /SILENT /NOCANCEL "https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'claudedesktop') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Claude Desktop..."\n        inetc::get /SILENT /NOCANCEL "https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest-win-x64/Claude-Setup-x64.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'lmstudio') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for LM Studio..."\n        inetc::get /SILENT /NOCANCEL "https://installers.lmstudio.ai/win32/x64/0.4.16-2/LM-Studio-0.4.16-2-x64.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'jan') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for Jan..."\n        inetc::get /SILENT /NOCANCEL "https://github.com/janhq/jan/releases/latest/download/Jan_0.8.3_x64-setup.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'gpt4all') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for GPT4All..."\n        inetc::get /SILENT /NOCANCEL "https://gpt4all.io/installers/gpt4all-installer-win64.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        } else if (appId === 'cccp') {
            const vendorLabel = `vendor_${index}_next`;
            vendorFallback = `\n        DetailPrint "Trying vendor URL for CCCP..."\n        inetc::get /SILENT /NOCANCEL "https://web.archive.org/web/20210702013306/http://www.cccp-project.net/public/Combined-Community-Codec-Pack-64bit-2015-10-18.exe" "${'$'}TEMP\\${escapedLocalSaveName}"\n        Pop $0\n        StrCmp $0 "OK" download_ok_${index} ${vendorLabel}\n        ${vendorLabel}:\n`;
        }

        const sectionName = rawAppName.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '_');

        return `
Section "Install${sectionName}" SEC${index + 1}
    DetailPrint "Downloading ${appName}..."
    DetailPrint "Preparing download attempts..."

    DetailPrint "Testing connection to server..."
    inetc::get /SILENT "${escapedServerUrl}/server-info" "${'$'}TEMP\\connection_test.txt"
    Pop $0
    StrCmp $0 "OK" connection_ok_${index} connection_fail_${index}

    connection_ok_${index}:
        Delete "${'$'}TEMP\\connection_test.txt"
        DetailPrint "Connection test successful. Downloading 64-bit installer..."
${x64Attempts}${vendorFallback}
        Goto download_fail_${index}

    connection_fail_${index}:
        DetailPrint "Connection test failed. Error: $0"
        MessageBox MB_OK|MB_ICONSTOP "Cannot connect to server. Error code: $0. Check firewall and antivirus settings."
        Goto end_${index}

    download_ok_${index}:
        DetailPrint "Download successful. Installing ${appName}..."
        ${installExecLine}
        ${envSnippet}
        DetailPrint "${appName} installation complete."
        Delete "${'$'}TEMP\\${escapedLocalSaveName}"
        RMDir /r "${'$'}TEMP\\stackdrop_unzip_${index}"
        Goto end_${index}

    download_fail_${index}:
        DetailPrint "Download failed for ${appName}. Error: $0"
        MessageBox MB_OK|MB_ICONSTOP "Failed to download ${escapedAppName}. Error: $0"

    end_${index}:
SectionEnd`;
    }).join('\n');

    // Wireshark needs Npcap for live capture. The free Npcap build has no silent
    // mode (that requires the paid OEM edition), so after every silent install has
    // finished we download the official Npcap installer and run it interactively.
    let npcapSection = '';
    if (selectedApps.includes('wireshark')) {
        const npcapFile = installerConfig.getInstallerFileName('npcap');
        const npcapLocal = escapeNSISString(npcapFile);
        let npcapAttempts = '';
        downloadBases.forEach((base, baseIdx) => {
            npcapAttempts += `\n    DetailPrint "Trying ${npcapLocal} from ${escapeNSISString(base)}..."\n    inetc::get /SILENT /NOCANCEL "${escapeNSISString(base)}/${npcapLocal}" "${'$'}TEMP\\${npcapLocal}"\n    Pop $0\n    StrCmp $0 "OK" npcap_download_ok npcap_next_${baseIdx}\n    npcap_next_${baseIdx}:\n`;
        });
        const npcapVendorUrl = getServerlistPrimaryUrl('npcap');
        if (npcapVendorUrl) {
            npcapAttempts += `\n    DetailPrint "Trying official Npcap download..."\n    inetc::get /SILENT /NOCANCEL "${escapeNSISString(npcapVendorUrl)}" "${'$'}TEMP\\${npcapLocal}"\n    Pop $0\n    StrCmp $0 "OK" npcap_download_ok npcap_next_vendor\n    npcap_next_vendor:\n`;
        }
        npcapSection = `

; ---- Npcap (interactive, runs after all silent installs) ----
Section "NpcapSetup" SEC_NPCAP
    DetailPrint "Npcap setup will open, click through it to enable packet capture."
    MessageBox MB_OK|MB_ICONINFORMATION "Npcap setup will open, click through it to enable packet capture."
    DetailPrint "Downloading Npcap installer..."${npcapAttempts}
    DetailPrint "Npcap download failed. Error: $0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Could not download the Npcap installer (error: $0). Wireshark is installed, but to capture traffic install Npcap from https://npcap.com/"
    Goto npcap_end

    npcap_download_ok:
    DetailPrint "Launching Npcap setup (interactive)..."
    ExecWait '"${'$'}TEMP\\${npcapLocal}"' $3
    DetailPrint "Npcap setup finished (exit code $3)."
    Delete "${'$'}TEMP\\${npcapLocal}"

    npcap_end:
SectionEnd`;
    }

    return `!include "MUI2.nsh"
!include "x64.nsh"

Unicode true

; Multi-App Stackdrop Downloader & Installer
Name "Stackdrop Multi-App Installer"
OutFile "${exePath.replace(/\\/g, '\\\\')}"
InstallDir "$$TEMP\\StackdropInstaller"

ShowInstDetails show

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var DownloadsDir

Function .onInit
    StrCpy $DownloadsDir "$PROFILE\\Downloads"
    IfFileExists "$DownloadsDir\\*.*" +2
    StrCpy $DownloadsDir "$DOCUMENTS"

    DetailPrint "Checking internet connection..."
    inetc::get /SILENT "https://www.google.com/generate_204" "${'$'}TEMP\\internet_test.txt"
    Pop $0
    StrCmp $0 "OK" internet_ok internet_fail

    internet_ok:
        Delete "${'$'}TEMP\\internet_test.txt"
        DetailPrint "Internet connection verified."
        Goto init_done

    internet_fail:
        DetailPrint "Initial internet test failed, but will try server connection later."
        DetailPrint "Internet test error code: $0"

    init_done:
FunctionEnd

${appInstallSections}${npcapSection}

Function .onInstSuccess
    DetailPrint "All applications installed successfully!"
FunctionEnd

Function .onInstFailed
    MessageBox MB_OK|MB_ICONSTOP "Installation failed! Please check your internet connection and firewall settings."
FunctionEnd`;
}

// Helper function to get app display name
function getAppDisplayName(appId) {
    for (const category of Object.values(apps)) {
        const app = category.items.find(item => item.id === appId);
        if (app) return app.name;
    }
    return appId;
}

// Helper function to get installer filename (shared config)
function getInstallerFileName(appId) {
    return installerConfig.getInstallerFileName(appId);
}

// Return candidate filenames to try per architecture for each app
function getInstallerCandidates(appId) {
    return installerConfig.getInstallerCandidates(appId);
}

// Helper function to get silent install flags (shared config)
function getSilentFlag(appId) {
    return installerConfig.getSilentFlag(appId);
}

// Socket.IO Connection Management for AI Agent
const rooms = new Map(); // roomCode -> { webClient: socketId, pcClient: socketId, agent: agentInstance }
const activeAgents = new Map(); // socketId -> agentInstance

// Generate unique room code
function generateRoomCode() {
    return uuidv4().substring(0, 6).toUpperCase();
}

class CascadingAIAgent {
    constructor(roomCode, socket, apiKey, provider = 'openai') {
        this.roomCode = roomCode;
        this.socket = socket;
        this.apiKey = apiKey;
        this.provider = provider;
        this.running = false;
        this.currentLevel = 1;
        this.maxLevel = 3;
        this.conversationHistory = [];
        this.openai = new OpenAI({ apiKey: this.apiKey });
        this.escalationReasons = [];
    }

    async startAgent(goal, maxLevel = 3) {
        this.running = true;
        this.currentLevel = 1;
        this.maxLevel = maxLevel;
        this.conversationHistory = [];
        this.escalationReasons = [];

        this.logMessage(`🎯 Starting cascading AI analysis for: "${goal}"`, 'system');

        // Start with Level 1 AI
        await this.processWithLevel(goal, 1);
    }

    async processWithLevel(goal, level) {
        this.currentLevel = level;
        this.logMessage(`🤖 Level ${level} AI analyzing...`, 'system');

        const systemPrompt = this.getSystemPromptForLevel(level, goal);

        try {
            const completion = await this.openai.chat.completions.create({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Please help me: ${goal}` }
                ],
                max_tokens: level === 1 ? 800 : 1200, // More tokens for higher levels
                temperature: level === 1 ? 0.3 : 0.7 // More conservative for level 1
            });

            const response = completion.choices[0].message.content;
            this.logMessage(`Level ${level} AI Response: ${response}`, 'ai');

            // Parse response and decide next action
            const result = await this.parseAndExecuteResponse(response, level, goal);

            if (!result.success && level < this.maxLevel) {
                // Escalate to next level
                this.escalationReasons.push(result.reason || `Level ${level} couldn't handle this task`);
                this.logMessage(`⚠️ Escalating to Level ${level + 1} AI: ${result.reason}`, 'system');
                await this.processWithLevel(goal, level + 1);
            } else if (!result.success && level === this.maxLevel) {
                // Max level reached, suggest human intervention
                this.logMessage(`🚫 All AI levels exhausted. Human intervention required: ${result.reason}`, 'error');
                this.socket.emit('human_intervention_needed', {
                    goal: goal,
                    escalationReasons: this.escalationReasons,
                    finalReason: result.reason
                });
                this.running = false;
            } else if (result.success) {
                // Task completed successfully
                this.logMessage(`✅ Task completed successfully by Level ${level} AI!`, 'system');
                this.running = false;
            }

        } catch (error) {
            this.logMessage(`Level ${level} AI Error: ${error.message}`, 'error');

            if (level < this.maxLevel) {
                this.escalationReasons.push(`Level ${level} encountered error: ${error.message}`);
                await this.processWithLevel(goal, level + 1);
            } else {
                this.running = false;
            }
        }
    }

    getSystemPromptForLevel(level, goal) {
        const baseCapabilities = `You can perform these actions:
- {"action": "click", "x": 100, "y": 200} - Click at screen coordinates
- {"action": "type", "text": "hello"} - Type text
- {"action": "press_key", "key": "Enter"} - Press a key
- {"action": "wait", "seconds": 1} - Wait before next action
- {"action": "take_screenshot"} - Take a screenshot
- {"action": "get_mouse_position"} - Get current mouse position

IMPORTANT RULES:
1. Use exact coordinates when provided by user
2. Break complex tasks into simple steps
3. Always respond with valid JSON action objects
4. Use natural mouse movements and typing delays
5. Take screenshots to verify actions when uncertain`;

        switch (level) {
            case 1:
                return `You are a BASIC AI assistant that can control a Windows computer. You should only handle SIMPLE, STRAIGHTFORWARD tasks.

${baseCapabilities}

LEVEL 1 RESTRICTIONS:
- Only handle tasks that can be completed in 1-3 simple actions
- Reject complex tasks, multi-step workflows, or anything requiring decision-making
- If unsure, respond with: {"escalate": true, "reason": "Task too complex for basic AI"}

Goal: ${goal}

Respond with either:
1. A JSON array of simple actions, OR
2. {"escalate": true, "reason": "brief explanation why this needs higher level AI"}`;

            case 2:
                return `You are an INTERMEDIATE AI assistant that can handle MODERATE complexity tasks on a Windows computer.

${baseCapabilities}

LEVEL 2 CAPABILITIES:
- Handle tasks requiring 3-8 actions
- Can make simple decisions based on context
- Can navigate basic applications and forms
- Can handle conditional logic (if-then scenarios)

Goal: ${goal}

Respond with either:
1. A JSON array of actions to complete the task, OR
2. {"escalate": true, "reason": "brief explanation why this needs advanced AI"}`;

            case 3:
                return `You are an ADVANCED AI assistant with FULL capabilities to control a Windows computer.

${baseCapabilities}

LEVEL 3 CAPABILITIES:
- Handle any complexity task
- Can navigate complex applications and workflows
- Can handle decision trees and complex logic
- Can troubleshoot and adapt to unexpected situations
- Can combine multiple applications and tools
- If truly impossible for automation, suggest human intervention

Goal: ${goal}

Respond with either:
1. A JSON array of actions to complete the task, OR
2. {"human_needed": true, "reason": "brief explanation why human intervention is required"}`;

            default:
                return baseCapabilities;
        }
    }

    async parseAndExecuteResponse(response, level, goal) {
        try {
            // Check if response indicates escalation
            if (response.includes('"escalate": true') || response.includes('"human_needed": true')) {
                const escalateMatch = response.match(/"reason":\s*"([^"]+)"/);
                const reason = escalateMatch ? escalateMatch[1] : `Level ${level} determined task needs higher intervention`;
                return { success: false, reason: reason };
            }

            // Try to parse as JSON actions
            let actions = [];

            // Look for JSON array in the response
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                actions = JSON.parse(jsonMatch[0]);
            } else {
                // Fallback: try to parse single action
                const actionMatch = response.match(/\{[\s\S]*\}/);
                if (actionMatch) {
                    const parsed = JSON.parse(actionMatch[0]);
                    if (parsed.action) {
                        actions = [parsed];
                    }
                }
            }

            if (actions.length > 0) {
                // Execute the actions
                await this.executeActions(actions);
                return { success: true };
            } else {
                return { success: false, reason: `Level ${level} could not generate valid actions` };
            }

        } catch (error) {
            return { success: false, reason: `Level ${level} response parsing error: ${error.message}` };
        }
    }

    stopAgent() {
        this.running = false;
        this.logMessage('Agent stopped by user', 'system');
    }

    emergencyStop() {
        this.running = false;
        this.logMessage('EMERGENCY STOP activated!', 'error');

        // Send emergency stop to PC client
        const room = rooms.get(this.roomCode);
        if (room && room.pcClient) {
            io.to(room.pcClient).emit('emergency_stop');
        }
    }

    logMessage(message, level = 'system') {
        this.socket.emit('agent_response', {
            type: 'log',
            message: message,
            level: level,
            aiLevel: this.currentLevel
        });
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Web client joining a room
    socket.on('join_room', (data) => {
        const { code } = data;
        const roomCode = code.toUpperCase();

        // Check if room exists
        if (!rooms.has(roomCode)) {
            socket.emit('room_error', { message: 'Invalid connection code' });
            return;
        }

        const room = rooms.get(roomCode);

        // Check if web client slot is available
        if (room.webClient) {
            socket.emit('room_error', { message: 'Room already has a web client connected' });
            return;
        }

        // Join the room
        socket.join(roomCode);
        room.webClient = socket.id;

        socket.emit('room_joined', {
            pc_name: room.pcName || 'Remote PC',
            room_code: roomCode
        });

        console.log(`Web client ${socket.id} joined room ${roomCode}`);
    });

    // PC client registering a room
    socket.on('register_room', (data) => {
        const roomCode = uuidv4().substring(0, 6).toUpperCase();
        const room = {
            pcClient: socket.id,
            webClient: null,
            pcName: data.pc_name || 'Unknown PC',
            created: new Date()
        };

        rooms.set(roomCode, room);
        socket.join(roomCode);

        socket.emit('room_registered', { room_code: roomCode });
        console.log(`PC client ${socket.id} registered room ${roomCode}`);
    });

    // Start AI agent
    socket.on('start_agent', async (data) => {
        const { goal, api_key, provider } = data;

        // Find room for this socket
        let roomCode = null;
        for (const [code, room] of rooms.entries()) {
            if (room.webClient === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (!roomCode) {
            socket.emit('agent_response', { type: 'error', message: 'Not connected to a room' });
            return;
        }

        // Create and start cascading agent
        const agent = new CascadingAIAgent(roomCode, socket, api_key, provider);
        activeAgents.set(socket.id, agent);

        try {
            await agent.startAgent(goal);
        } catch (error) {
            socket.emit('agent_response', { type: 'error', message: error.message });
        }
    });

    // Stop AI agent
    socket.on('stop_agent', () => {
        const agent = activeAgents.get(socket.id);
        if (agent) {
            agent.stopAgent();
            activeAgents.delete(socket.id);
        }
    });

    // Emergency stop
    socket.on('emergency_stop', () => {
        const agent = activeAgents.get(socket.id);
        if (agent) {
            agent.emergencyStop();
            activeAgents.delete(socket.id);
        }
    });

    // Manual command
    socket.on('manual_command', (data) => {
        const { command } = data;

        // Find room and forward to PC client
        let roomCode = null;
        for (const [code, room] of rooms.entries()) {
            if (room.webClient === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room.pcClient) {
                io.to(room.pcClient).emit('manual_command', { command });
            }
        }
    });

    // Screenshot request
    socket.on('take_screenshot', () => {
        let roomCode = null;
        for (const [code, room] of rooms.entries()) {
            if (room.webClient === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room.pcClient) {
                io.to(room.pcClient).emit('take_screenshot');
            }
        }
    });

    // Get mouse position
    socket.on('get_mouse_position', () => {
        let roomCode = null;
        for (const [code, room] of rooms.entries()) {
            if (room.webClient === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room.pcClient) {
                io.to(room.pcClient).emit('get_mouse_position');
            }
        }
    });

    // PC client responses
    socket.on('action_result', (data) => {
        // Forward to web client
        let roomCode = null;
        for (const [code, room] of rooms.entries()) {
            if (room.pcClient === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room.webClient) {
                io.to(room.webClient).emit('agent_response', data);
            }
        }
    });

    socket.on('screenshot_taken', (data) => {
        let roomCode = null;
        for (const [code, room] of rooms.entries()) {
            if (room.pcClient === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room.webClient) {
                io.to(room.webClient).emit('screenshot', data);
            }
        }
    });

    socket.on('mouse_position', (data) => {
        let roomCode = null;
        for (const [code, room] of rooms.entries()) {
            if (room.pcClient === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room.webClient) {
                io.to(room.webClient).emit('agent_response', {
                    type: 'log',
                    message: `Mouse position: (${data.x}, ${data.y})`,
                    level: 'system'
                });
            }
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);

        // Clean up rooms
        for (const [roomCode, room] of rooms.entries()) {
            if (room.webClient === socket.id) {
                room.webClient = null;
                console.log(`Web client left room ${roomCode}`);
            } else if (room.pcClient === socket.id) {
                // PC client disconnected, remove room
                rooms.delete(roomCode);
                console.log(`PC client left, removed room ${roomCode}`);
            }
        }

        // Clean up active agents
        if (activeAgents.has(socket.id)) {
            const agent = activeAgents.get(socket.id);
            agent.stopAgent();
            activeAgents.delete(socket.id);
        }
    });
});

// Add error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error'
    });
});

// ========================================
// SDCLIENT.EXE API ENDPOINTS
// ========================================

// Catalog endpoints
app.get('/api/catalog', (req, res) => {
    try {
        const catalog = getAppCatalog();
        return res.json({ apps: catalog });
    } catch (_) {
        return res.json({ apps: [] });
    }
});

// Web login: require Supabase user, validate org active, issue device token
app.post('/api/login/web', requireSupabaseUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const orgId = String((req.body && req.body.org_id) || '').trim();
        const deviceId = String((req.body && req.body.device_id) || '').trim();
        const hostname = String((req.body && req.body.hostname) || '').trim();
        if (!orgId || !deviceId) return res.status(400).json({ error: 'missing_parameters' });
        let active = await isOrganizationActive(orgId);
        if (!active) {
            // Self-heal: if Supabase user metadata shows paid/active, upsert org as active
            try {
                const meta = (req.user && (req.user.user_metadata || req.user.app_metadata)) || {};
                const paidFlag = (meta && (meta.paid === true || meta.plan_status === 'active')) ? true : false;
                if (paidFlag) {
                    if (pgPool) {
                        try {
                            await pgPool.query('INSERT INTO organizations (id, plan_status) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET plan_status=$2', [orgId, 'active']);
                        } catch (_) {}
                    }
                    if (supabase) {
                        try { await supabase.from('organizations').upsert({ id: orgId, plan_status: 'active' }, { onConflict: 'id' }); } catch (_) {}
                    }
                    active = await isOrganizationActive(orgId);
                }
            } catch (_) {}
        }
        if (!active) {
            // Record basic device footprint even if inactive and still issue a token so the device can appear on dashboard
            try {
                const nowIso = new Date().toISOString();
                const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
                if (pgPool) {
                    try {
                        await pgPool.query(
                            'INSERT INTO devices (org_id, user_id, device_id, hostname, last_seen_at, last_ip) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (device_id) DO UPDATE SET org_id=EXCLUDED.org_id, user_id=EXCLUDED.user_id, hostname=EXCLUDED.hostname, last_seen_at=EXCLUDED.last_seen_at, last_ip=EXCLUDED.last_ip',
                            [orgId, userId, deviceId, hostname || deviceId, nowIso, ip]
                        );
                    } catch (_) {}
                }
                if (supabase) {
                    try { await supabase.from('device_heartbeats').insert({ org_id: orgId, user_id: userId, device_id: deviceId, hostname: hostname || deviceId, last_seen_at: nowIso, last_ip: ip }); } catch (_) {}
                    try { await supabase.from('devices').upsert({ org_id: orgId, user_id: userId, device_id: deviceId, hostname: hostname || deviceId, last_seen_at: nowIso, last_ip: ip }, { onConflict: 'device_id' }); } catch (_) {}
                }
            } catch (_) {}
            const tokenInactive = generateDeviceToken({ org_id: orgId, device_id: deviceId, hostname, user_id: userId, issued_by: 'web', scope: 'device', v: 1, inactive: true }, 7 * 24 * 60 * 60);
            return res.json({ token: tokenInactive, token_type: 'device', expires_in: 7 * 24 * 60 * 60, inactive: true });
        }
        const token = generateDeviceToken({ org_id: orgId, device_id: deviceId, hostname, user_id: userId, issued_by: 'web', scope: 'device', v: 1 }, 7 * 24 * 60 * 60);

        // Record device
        const nowIso = new Date().toISOString();
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        if (pgPool) {
            try {
                await pgPool.query(
                    'INSERT INTO devices (org_id, user_id, device_id, hostname, last_seen_at, last_ip) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (device_id) DO UPDATE SET org_id=EXCLUDED.org_id, user_id=EXCLUDED.user_id, hostname=EXCLUDED.hostname, last_seen_at=EXCLUDED.last_seen_at, last_ip=EXCLUDED.last_ip',
                    [orgId, userId, deviceId, hostname || deviceId, nowIso, ip]
                );
            } catch (_) {}
        }
        if (supabase) {
            try {
                await supabase.from('device_heartbeats').insert({ org_id: orgId, user_id: userId, device_id: deviceId, hostname: hostname || deviceId, last_seen_at: nowIso, last_ip: ip });
            } catch (_) {}
        }

        return res.json({ token, token_type: 'device', expires_in: 7 * 24 * 60 * 60 });
    } catch (_) {
        return res.status(500).json({ error: 'internal_error' });
    }
});

// Idempotently ensure a device appears for the logged-in user
app.post('/api/devices/ensure', requireSupabaseUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const deviceId = String((req.body && req.body.device_id) || '').trim();
        const hostname = String((req.body && req.body.hostname) || '').trim();
        if (!deviceId) return res.status(400).json({ ok: false, error: 'missing_device_id' });
        const nowIso = new Date().toISOString();

        let ok = false;
        if (pgPool) {
            try {
                await pgPool.query(
                    'INSERT INTO devices (org_id, user_id, device_id, hostname, last_seen_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (device_id) DO UPDATE SET org_id=EXCLUDED.org_id, user_id=EXCLUDED.user_id, hostname=EXCLUDED.hostname, last_seen_at=EXCLUDED.last_seen_at',
                    [userId, userId, deviceId, hostname || deviceId, nowIso]
                );
                ok = true;
            } catch (_) {}
        }
        if (supabase) {
            try {
                await supabase
                    .from('devices')
                    .upsert({ org_id: userId, user_id: userId, device_id: deviceId, hostname: hostname || deviceId, last_seen_at: nowIso }, { onConflict: 'device_id' });
                ok = true;
            } catch (_) {}
        }
        return res.json({ ok });
    } catch (_) {
        return res.status(500).json({ ok: false });
    }
});

// List devices for the logged-in user
app.get('/api/devices', requireSupabaseUser, async (req, res) => {
    try {
        const userId = req.user.id;

        // Prefer Supabase service client for reliability
        if (supabase) {
            try {
                let { data, error } = await supabase
                    .from('devices')
                    .select('id:device_id, hostname, last_seen_at, os_summary, os_name, os_version, os_build, arch')
                    .or(`user_id.eq.${userId},org_id.eq.${userId}`)
                    .order('last_seen_at', { ascending: false })
                    .limit(200);
                if (!error && data && data.length) return res.json({ devices: data });
                // If schema lacks extended OS columns, retry with minimal projection
                try {
                    const slim = await supabase
                        .from('devices')
                        .select('id:device_id, hostname, last_seen_at')
                        .or(`user_id.eq.${userId},org_id.eq.${userId}`)
                        .order('last_seen_at', { ascending: false })
                        .limit(200);
                    if (!slim.error && slim.data && slim.data.length) return res.json({ devices: slim.data });
                } catch (_) {}
                // Final fallback: derive device list from device_heartbeats (latest per device) strictly for this user/org
                const hb = await supabase
                    .from('device_heartbeats')
                    .select('device_id, hostname, last_seen_at, org_id, user_id')
                    .or(`user_id.eq.${userId},org_id.eq.${userId}`)
                    .order('last_seen_at', { ascending: false })
                    .limit(500);
                if (!hb.error && hb.data) {
                    const seen = new Set();
                    const out = [];
                    for (const r of hb.data) {
                        const id = r.device_id;
                        if (!id || seen.has(id)) continue;
                        seen.add(id);
                        out.push({ id, hostname: r.hostname, last_seen_at: r.last_seen_at });
                    }
                    if (out.length) return res.json({ devices: out });
                }
            } catch (_) {}
        }

        // Fallback to Postgres pool if Supabase path fails/unavailable
        if (pgPool) {
            try {
                const result = await pgPool.query(
                    'SELECT device_id AS id, hostname, last_seen_at FROM devices WHERE user_id = $1 OR org_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 200',
                    [userId]
                );
                if (result.rows && result.rows.length) return res.json({ devices: result.rows });
            } catch (_) {}
        }

        return res.json({ devices: [] });
    } catch (e) {
        return res.json({ devices: [] });
    }
});

// Machine authorization endpoint for Windows client
app.post('/api/machines/authorize', requireSupabaseUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const machineGUID = String((req.body && req.body.machine_guid) || '').trim();
        
        if (!machineGUID) {
            return res.status(400).json({ 
                success: false, 
                error: 'missing_machine_guid' 
            });
        }

        // Check if this machine is already authorized for this user
        let isAuthorized = false;
        
        if (pgPool) {
            try {
                const result = await pgPool.query(
                    'SELECT device_id FROM devices WHERE org_id = $1 AND device_id = $2',
                    [userId, machineGUID]
                );
                isAuthorized = result.rows && result.rows.length > 0;
            } catch (err) {
                console.error('Database error checking machine authorization:', err);
            }
        }
        
        if (supabase) {
            try {
                const { data, error } = await supabase
                    .from('devices')
                    .select('device_id')
                    .eq('org_id', userId)
                    .eq('device_id', machineGUID)
                    .limit(1);
                
                if (!error && data && data.length > 0) {
                    isAuthorized = true;
                }
            } catch (err) {
                console.error('Supabase error checking machine authorization:', err);
            }
        }

        if (isAuthorized) {
            return res.status(200).json({ 
                success: true, 
                message: 'Machine authorized' 
            });
        } else {
            return res.status(403).json({ 
                success: false, 
                error: 'machine_not_authorized' 
            });
        }
        
    } catch (error) {
        console.error('Machine authorization error:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'internal_server_error' 
        });
    }
});

// Account status endpoint
app.get('/api/account/status', requireSupabaseUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const active = await isOrganizationActive(userId);
        return res.json({ active: !!active });
    } catch (_) {
        return res.json({ active: false });
    }
});

// User app preferences endpoints
app.get('/api/user/app-preferences', requireSupabaseUser, async (req, res) => {
    try {
        const userId = req.user.id;
        // Return empty preferences for now - can be extended to store in database
        return res.json({ preferences: [] });
    } catch (_) {
        return res.json({ preferences: [] });
    }
});

app.post('/api/user/app-preferences', requireSupabaseUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const preferences = Array.isArray(req.body.preferences) ? req.body.preferences : [];
        // Store preferences logic can be added here
        return res.json({ ok: true });
    } catch (_) {
        return res.status(500).json({ error: 'failed_to_save' });
    }
});

// Device check-in endpoint
app.post('/api/device/checkin', requireDeviceToken, async (req, res) => {
    try {
        const payload = req.device || {};
        const orgId = payload.org_id;
        const deviceId = payload.device_id;
        const userId = payload.user_id || null;
        const active = await isOrganizationActive(orgId);
        // Allow check-in even if inactive so devices appear on dashboard

        const installed = Array.isArray(req.body && req.body.installed) ? req.body.installed : [];
        const hostname = String((req.body && req.body.hostname) || payload.hostname || deviceId || '').trim();
        const nowIso = new Date().toISOString();
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        const ua = req.get('user-agent') || '';
        const osName = String(req.body && req.body.os_name || '').trim();
        const osVersion = String(req.body && req.body.os_version || '').trim();
        const osBuild = String(req.body && req.body.os_build || '').trim();
        const arch = String(req.body && req.body.arch || '').trim();
        const osSummary = (osName || osVersion || osBuild)
            ? `${osName} ${osVersion}${osBuild ? ' (build ' + osBuild + ')' : ''}`.trim()
            : '';

        // Record detailed heartbeat
        if (pgPool) {
            try {
                // Try inserting OS fields if schema supports them
                try {
                    await pgPool.query(
                        'INSERT INTO device_heartbeats (org_id, user_id, device_id, hostname, last_seen_at, last_ip, user_agent, installed_apps, os_name, os_version, os_build, arch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
                        [orgId, userId, deviceId, hostname, nowIso, ip, ua, JSON.stringify(installed), osName || null, osVersion || null, osBuild || null, arch || null]
                    );
                } catch (_) {
                    await pgPool.query('INSERT INTO device_heartbeats (org_id, user_id, device_id, hostname, last_seen_at, last_ip, user_agent, installed_apps) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [orgId, userId, deviceId, hostname, nowIso, ip, ua, JSON.stringify(installed)]);
                }
            } catch (_) {}
            // Upsert summary row so dashboard sees it immediately
            try {
                try {
                    await pgPool.query(
                        'INSERT INTO devices (org_id, user_id, device_id, hostname, last_seen_at, last_ip, os_name, os_version, os_build, arch, os_summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (device_id) DO UPDATE SET org_id=EXCLUDED.org_id, user_id=EXCLUDED.user_id, hostname=EXCLUDED.hostname, last_seen_at=EXCLUDED.last_seen_at, last_ip=EXCLUDED.last_ip, os_name=EXCLUDED.os_name, os_version=EXCLUDED.os_version, os_build=EXCLUDED.os_build, arch=EXCLUDED.arch, os_summary=EXCLUDED.os_summary',
                        [orgId, userId, deviceId, hostname || deviceId, nowIso, ip, osName || null, osVersion || null, osBuild || null, arch || null, osSummary || null]
                    );
                } catch (_) {
                    await pgPool.query('INSERT INTO devices (org_id, user_id, device_id, hostname, last_seen_at, last_ip) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (device_id) DO UPDATE SET org_id=EXCLUDED.org_id, user_id=EXCLUDED.user_id, hostname=EXCLUDED.hostname, last_seen_at=EXCLUDED.last_seen_at, last_ip=EXCLUDED.last_ip', [orgId, userId, deviceId, hostname || deviceId, nowIso, ip]);
                }
            } catch (_) {}
        }
        if (supabase) {
            try { await supabase.from('device_heartbeats').insert({ org_id: orgId, user_id: userId, device_id: deviceId, hostname: hostname || deviceId, last_seen_at: nowIso, last_ip: ip, user_agent: ua, installed_apps: installed, os_name: osName || null, os_version: osVersion || null, os_build: osBuild || null, arch: arch || null }); } catch (_) {}
            try { await supabase.from('devices').upsert({ org_id: orgId, user_id: userId, device_id: deviceId, hostname: hostname || deviceId, last_seen_at: nowIso, last_ip: ip, os_name: osName || null, os_version: osVersion || null, os_build: osBuild || null, arch: arch || null, os_summary: osSummary || null }, { onConflict: 'device_id' }); } catch (_) {}

            // Reflect reported installed apps into device_apps so dashboard toggles
            // show real install state. Best-effort; never blocks the check-in.
            try {
                const knownIds = new Set(getAllAppIds());
                const nameById = new Map(getAppCatalog().map((c) => [c.id, c.name]));
                const installedIds = [];
                const upserts = [];
                for (const it of installed) {
                    if (!it || !it.id) continue;
                    const id = String(it.id);
                    if (!knownIds.has(id)) continue;
                    installedIds.push(id);
                    upserts.push({
                        device_id: deviceId, org_id: orgId, app_id: id, app_name: nameById.get(id),
                        installed: true, installed_version: String(it.version || '') || null,
                        last_checked_at: nowIso, updated_at: nowIso
                    });
                }
                if (upserts.length) {
                    await supabase.from('device_apps').upsert(upserts, { onConflict: 'device_id,app_id' });
                }
                // Anything previously marked installed but no longer reported -> installed:false
                let q = supabase.from('device_apps').update({ installed: false, updated_at: nowIso })
                    .eq('device_id', deviceId).eq('installed', true);
                if (installedIds.length) q = q.not('app_id', 'in', `(${installedIds.join(',')})`);
                await q;
            } catch (_) {}
        }
        return res.json({ ok: true, inactive: !active });
    } catch (_) {
        return res.status(500).json({ error: 'internal_error' });
    }
});

// Apps audit endpoint
app.post('/api/apps/audit', requireDeviceToken, async (req, res) => {
    try {
        const payload = req.device || {};
        const orgId = payload.org_id;
        const deviceId = payload.device_id;
        const active = await isOrganizationActive(orgId);
        if (!active) return res.status(402).json({ error: 'org_inactive' });

        const installed = Array.isArray(req.body && req.body.installed) ? req.body.installed : [];
        const wanted = Array.isArray(req.body && req.body.wanted) ? req.body.wanted : null;
        const latestMap = await getLatestVersionsMap();
        const knownIds = new Set(getAllAppIds());

        const installedMap = new Map();
        for (const it of installed) {
            if (!it || !it.id) continue;
            installedMap.set(String(it.id), String(it.version || ''));
        }

        // Stored per-device desired state (the source of truth for install/remove).
        const desiredMap = new Map(); // app_id -> 'install' | 'remove'
        if (supabase && deviceId) {
            try {
                const { data } = await supabase
                    .from('device_apps')
                    .select('app_id, desired_state')
                    .eq('device_id', deviceId);
                (data || []).forEach((r) => { if (r.desired_state) desiredMap.set(r.app_id, r.desired_state); });
            } catch (_) {}
        }

        // Apps the device should have installed: explicit client "wanted" list
        // plus anything marked desired_state='install'.
        const installSet = new Set();
        if (wanted && wanted.length) wanted.filter((id) => knownIds.has(id)).forEach((id) => installSet.add(id));
        for (const [id, st] of desiredMap) { if (st === 'install' && knownIds.has(id)) installSet.add(id); }

        const actions = [];
        const pushUpdateIfOutdated = (appId, cur) => {
            const latest = latestMap[appId] || null;
            if (!latest) return;
            try { if (compareVersions(cur, latest) < 0) actions.push({ appId, action: 'update', currentVersion: cur, latestVersion: latest }); } catch (_) {}
        };

        // Installs + updates for the desired/wanted set
        for (const appId of installSet) {
            if (!installedMap.has(appId)) {
                actions.push({ appId, action: 'install', latestVersion: latestMap[appId] || null });
            } else {
                pushUpdateIfOutdated(appId, installedMap.get(appId));
            }
        }

        // Keep already-installed apps up to date (unless the user asked to remove them)
        for (const [appId, cur] of installedMap) {
            if (!knownIds.has(appId) || installSet.has(appId)) continue;
            if (desiredMap.get(appId) === 'remove') continue;
            pushUpdateIfOutdated(appId, cur);
        }

        // Removals: apps the user toggled off that are still installed
        for (const [appId, st] of desiredMap) {
            if (st === 'remove' && installedMap.has(appId)) actions.push({ appId, action: 'remove', latestVersion: null });
        }

        return res.json({ actions });
    } catch (_) {
        return res.status(500).json({ error: 'internal_error' });
    }
});

// ========================================
// DESIRED-APPS (per-device install/remove toggles, synced via device_apps)
// ========================================

// Build the togglable app list for a device: catalog joined with this device's
// desired_state + installed status.
async function buildDeviceAppList(deviceId) {
    const catalog = getAppCatalog(); // [{ id, name }]
    let rowsById = new Map();
    if (supabase) {
        try {
            const { data } = await supabase
                .from('device_apps')
                .select('app_id, desired_state, installed, installed_version, update_available')
                .eq('device_id', deviceId);
            rowsById = new Map((data || []).map((r) => [r.app_id, r]));
        } catch (_) {}
    }
    return catalog.map((c) => {
        const r = rowsById.get(c.id) || {};
        return {
            id: c.id,
            name: c.name,
            desired_state: r.desired_state || null,   // 'install' | 'remove' | null
            installed: !!r.installed,
            installed_version: r.installed_version || null,
            update_available: !!r.update_available
        };
    });
}

// Validate + persist desired-state changes for a device.
async function applyDesiredChanges(deviceId, orgId, changes, source) {
    const nameById = new Map(getAppCatalog().map((c) => [c.id, c.name]));
    const rows = [];
    const nowIso = new Date().toISOString();
    for (const ch of changes) {
        const appId = String((ch && ch.app_id) || '').trim();
        if (!nameById.has(appId)) continue;
        let st = ch.desired_state;
        st = (st === null || st === undefined || st === '') ? null : String(st).toLowerCase();
        if (st !== null && !['install', 'remove'].includes(st)) continue;
        rows.push({
            device_id: deviceId,
            org_id: orgId,
            app_id: appId,
            app_name: nameById.get(appId),
            desired_state: st,
            desired_source: source,
            desired_updated_at: nowIso,
            updated_at: nowIso
        });
    }
    if (rows.length && supabase) {
        const { error } = await supabase.from('device_apps').upsert(rows, { onConflict: 'device_id,app_id' });
        if (error) throw error;
    }
    return rows.length;
}

function normalizeChanges(body) {
    if (Array.isArray(body && body.changes)) return body.changes;
    if (body && body.app_id) return [{ app_id: body.app_id, desired_state: body.desired_state }];
    return [];
}

// ---- Windows client (device token) ----
app.get('/api/device/apps', requireDeviceToken, async (req, res) => {
    try {
        const deviceId = req.device.device_id;
        const apps = await buildDeviceAppList(deviceId);
        return res.json({ apps });
    } catch (e) {
        console.error('device apps list error:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
});

app.post('/api/device/apps', requireDeviceToken, async (req, res) => {
    try {
        const { device_id: deviceId, org_id: orgId } = req.device;
        const changes = normalizeChanges(req.body);
        if (!changes.length) return res.status(400).json({ error: 'no_changes' });
        const updated = await applyDesiredChanges(deviceId, orgId, changes, 'client');
        return res.json({ ok: true, updated });
    } catch (e) {
        console.error('device apps set error:', e.message);
        return res.status(500).json({ error: 'failed_to_save' });
    }
});

// ---- Web Pro dashboard (Supabase user) ----
// Confirm the device belongs to the logged-in user and return its org_id.
async function getOwnedDevice(userId, deviceId) {
    if (!supabase) return null;
    try {
        const { data } = await supabase
            .from('devices')
            .select('device_id, org_id, user_id, hostname')
            .eq('device_id', deviceId)
            .or(`user_id.eq.${userId},org_id.eq.${userId}`)
            .limit(1);
        return (data && data[0]) || null;
    } catch (_) {
        return null;
    }
}

app.get('/api/devices/:deviceId/apps', requireSupabaseUser, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '').trim();
        const dev = await getOwnedDevice(req.user.id, deviceId);
        if (!dev) return res.status(404).json({ error: 'device_not_found' });
        const apps = await buildDeviceAppList(deviceId);
        return res.json({ apps, hostname: dev.hostname || deviceId });
    } catch (e) {
        console.error('web device apps list error:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
});

app.post('/api/devices/:deviceId/apps', requireSupabaseUser, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '').trim();
        const dev = await getOwnedDevice(req.user.id, deviceId);
        if (!dev) return res.status(404).json({ error: 'device_not_found' });
        const changes = normalizeChanges(req.body);
        if (!changes.length) return res.status(400).json({ error: 'no_changes' });
        const updated = await applyDesiredChanges(deviceId, dev.org_id || req.user.id, changes, 'web');
        return res.json({ ok: true, updated });
    } catch (e) {
        console.error('web device apps set error:', e.message);
        return res.status(500).json({ error: 'failed_to_save' });
    }
});

// Tools routes
app.get('/tools', async (req, res) => {
    try {
        const viewCount = await getPageViewCount('/tools');
        res.render('tools', { title: 'Stackdrop Tools', viewCount });
    } catch (e) {
        res.status(500).send('Failed to render tools');
    }
});

// AI anything page
app.get('/ai-anything', async (req, res) => {
    try {
        const viewCount = await getPageViewCount('/ai-anything');
        res.render('ai-anything', { title: 'AI anything', viewCount });
    } catch (e) {
        res.status(500).send('Failed to render AI anything');
    }
});

app.get(['/tools/macro-maker', '/tools/macro-maker/'], (req, res) => {
    res.redirect(301, '/tools/auto-mouse-clicker-macro-maker');
});

app.get(['/macro', '/macro/'], (req, res) => {
    const ua = String(req.get('user-agent') || '');
    const isPreviewBot = /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|WhatsApp|Discordbot|TelegramBot|Pinterest/i.test(ua);
    if (!isPreviewBot) {
        res.redirect(302, '/tools/auto-mouse-clicker-macro-maker');
        return;
    }
    res.type('html').send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:url" content="https://stackdrop.it/macro">
<meta property="og:title" content="Macro Maker by Stackdrop | Free Windows Macro Recorder">
<meta property="og:description" content="Record clicks and keys, then play them back. Free Windows macro maker. No command window.">
<meta property="og:image" content="https://stackdrop.it/images/macro-maker-share.jpg">
<meta property="og:image:secure_url" content="https://stackdrop.it/images/macro-maker-share.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Macro Maker 1.1.5 window with recorded steps">
<meta property="og:site_name" content="Stackdrop">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://stackdrop.it/images/macro-maker-share.jpg">
<title>Macro Maker by Stackdrop</title>
</head><body><p><a href="https://stackdrop.it/tools/auto-mouse-clicker-macro-maker">Macro Maker</a></p></body></html>`);
});

app.get(['/tools/mouse-clicker', '/tools/mouse-clicker/', '/tools/mouse-clicker-agent', '/tools/mouse-clicker-agent/'], (req, res) => {
    res.redirect(301, '/tools/auto-mouse-clicker-macro-maker');
});

app.get('/tools/long-filename-remover', async (req, res) => {
    try {
        const viewCount = await getPageViewCount('/tools/long-filename-remover');
        res.render('tool-longfilename', { title: 'Windows Long Filename Remover', viewCount });
    } catch (e) {
        res.status(500).send('Failed to render tool page');
    }
});


// Authentication middleware for protected routes
// Admin/whitelist emails with full access to AI Agent
const ADMIN_EMAILS = [
    'ryan5439@yahoo.com',
    'spermfeather@gmail.com'
];

async function requireAuth(req, res, next) {
    try {
        // Check for session token in various places
        const authToken = req.headers.authorization?.replace('Bearer ', '') || 
                         req.cookies?.sb_access_token || 
                         req.query.token;
        
        // If no token, redirect to login
        if (!authToken) {
            return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
        }

        // Validate token with Supabase
        if (supabase) {
            try {
                const { data: { user }, error } = await supabase.auth.getUser(authToken);
                
                if (error || !user) {
                    console.log('Invalid auth token:', error?.message);
                    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
                }
                
                // Attach user to request
                req.user = user;
                req.userEmail = user.email;
                req.isAdmin = ADMIN_EMAILS.includes(user.email?.toLowerCase());
                
                console.log(`✅ Authenticated: ${user.email} (Admin: ${req.isAdmin})`);
                next();
            } catch (supabaseError) {
                console.error('Supabase auth error:', supabaseError);
                return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
            }
        } else {
            // Supabase not configured, allow access for development
            console.warn('⚠️  Supabase not configured - allowing access');
            req.user = { email: 'dev@localhost' };
            req.isAdmin = true;
            next();
        }
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
    }
}

// Stackdrop AI Agent - NOW REQUIRES LOGIN
app.get('/ai', requireAuth, (req, res) => {
    try {
        res.render('tool-ai-agent', {
            title: 'Stackdrop AI Agent - Autonomous Desktop Control',
            user: req.user || null,
            userEmail: req.userEmail || null,
            isAdmin: req.isAdmin || false,
            supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
            supabaseAnon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
        });
    } catch (e) {
        console.error('Failed to render AI agent page:', e);
        res.status(500).send('Failed to render AI agent page');
    }
});

// AI Agent Dashboard - Full dashboard UI
app.get('/ai-dashboard', requireAuth, (req, res) => {
    try {
        res.render('ai-agent-dashboard', {
            title: 'AI Agent Dashboard - Stackdrop',
            user: req.user || null,
            userEmail: req.userEmail || null,
            isAdmin: req.isAdmin || false,
            supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
            supabaseAnon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
        });
    } catch (e) {
        console.error('Failed to render AI agent dashboard:', e);
        res.status(500).send('Failed to render AI agent dashboard');
    }
});

// Keep old route for backwards compatibility (redirect to new route)
app.get('/tools/stackdrop-ai-agent', (req, res) => {
    res.redirect('/ai');
});

// Auto Mouse Clicker - Macro Maker tool page
app.get('/tools/chrome-transparency', async (req, res) => {
    try {
        const viewCount = await getPageViewCount('/tools/chrome-transparency');
        res.render('tool-chrome-transparency', { title: 'Chrome Transparency Controller', viewCount });
    } catch (e) {
        console.error('Error rendering chrome-transparency tool page:', e);
        res.status(500).send('Error loading tool page');
    }
});

app.get('/tools/spectra-eq', async (req, res) => {
    try {
        const viewCount = await getPageViewCount('/tools/spectra-eq');
        res.render('tool-spectra-eq', { title: 'Spectra EQ by Stackdrop', viewCount });
    } catch (e) {
        console.error('Error rendering spectra-eq tool page:', e);
        res.status(500).send('Error loading tool page');
    }
});

app.get('/tools/auto-mouse-clicker-macro-maker', async (req, res) => {
    try {
        const viewCount = await getPageViewCount('/tools/auto-mouse-clicker-macro-maker');
        res.render('tool-macro-maker', { title: 'Auto-Mouse Clicker - Macro Maker', viewCount });
    } catch (e) {
        res.status(500).send('Failed to render tool page');
    }
});

app.get('/tools/deskcheck', async (req, res) => {
    try {
        const viewCount = await getPageViewCount('/tools/deskcheck');
        res.render('tool-deskcheck', { title: 'DeskCheck by Stackdrop', viewCount });
    } catch (e) {
        res.status(500).send('Failed to render tool page');
    }
});

// Direct download endpoint for DeskCheck
app.get('/downloads/DeskCheck.exe', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'OtherApps', 'deskcheck.exe');
        if (fs.existsSync(filePath)) {
            res.download(filePath, 'DeskCheck.exe');
        } else {
            res.status(404).send('DeskCheck not found. Please build the executable first.');
        }
    } catch (e) {
        res.status(500).send('Failed to download DeskCheck');
    }
});


// Direct download endpoint for Stackdrop AI Agent
app.get('/downloads/StackdropAgent.exe', (req, res) => {
    try {
        const filePath = path.join('/var/www/stackdrop', 'Stackdrop.ai Agent', 'agent.exe');
        if (fs.existsSync(filePath)) {
            res.download(filePath, 'StackdropAgent.exe');
        } else {
            res.status(404).send('Stackdrop AI Agent not found. Please build the executable first.');
        }
    } catch (e) {
        res.status(500).send('Failed to download Stackdrop AI Agent');
    }
});

// Direct download endpoint for Auto Mouse Clicker - Macro Maker is registered
// earlier, before the generic /downloads/:filename handler.

// Download PC Client
app.get('/downloads/pc-client.zip', (req, res) => {
    try {
        const clientDir = path.join(__dirname, 'pc-client');

        res.status(200).send(`
<!DOCTYPE html>
<html>
<head>
    <title>Stackdrop PC Client Download</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background: #f8f9fa; padding: 40px 0; }
        .download-card { max-width: 800px; margin: 0 auto; }
    </style>
</head>
<body>
    <div class="container">
        <div class="card download-card shadow">
            <div class="card-header bg-primary text-white">
                <h3 class="mb-0">🤖 Stackdrop PC Client Download</h3>
            </div>
            <div class="card-body">
                <h5>What is the PC Client?</h5>
                <p>The PC client runs on your Windows computers and allows the web-based AI Agent to control them remotely.</p>

                <h5>Installation Instructions:</h5>
                <ol>
                    <li><strong>Download Node.js:</strong> Visit <a href="https://nodejs.org" target="_blank">nodejs.org</a> and download the latest LTS version for Windows</li>
                    <li><strong>Download PC Client:</strong> <a href="/downloads/pc-client-files.zip" class="btn btn-sm btn-primary">Download Client Files</a></li>
                    <li><strong>Extract:</strong> Unzip the downloaded file to a folder on your Windows PC</li>
                    <li><strong>Install:</strong> Open Command Prompt as Administrator and run:
                        <pre class="bg-light p-2 mt-2"><code>cd pc-client
npm install</code></pre>
                    </li>
                    <li><strong>Run:</strong> Double-click <code>run-client.bat</code> or run <code>node client.js</code></li>
                    <li><strong>Connect:</strong> Note the connection code and enter it in the web interface at <a href="/ai">/ai</a></li>
                </ol>

                <div class="alert alert-info">
                    <strong>Security Note:</strong> Only run this client on computers you trust. The AI agent can control mouse and keyboard when connected.
                </div>

                <div class="alert alert-warning">
                    <strong>Requirements:</strong> Windows 10/11, Node.js 14+, Administrator privileges for full functionality.
                </div>

                <div class="text-center mt-4">
                    <a href="/ai" class="btn btn-success btn-lg">Go to AI Agent</a>
                    <a href="/tools" class="btn btn-secondary btn-lg ms-2">Back to Tools</a>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
        `);
    } catch (e) {
        res.status(500).send('Failed to prepare PC client download');
    }
});

// Provide actual client files download (placeholder for now)
app.get('/downloads/pc-client-files.zip', (req, res) => {
    res.status(200).send(`
    <div class="alert alert-info">
        <h4>PC Client Files Download</h4>
        <p>In a production environment, this would serve a ZIP file containing:</p>
        <ul>
            <li>client.js - Main client application</li>
            <li>package.json - Dependencies</li>
            <li>run-client.bat - Easy startup script</li>
            <li>README.md - Full documentation</li>
        </ul>
        <p>For now, please manually copy the <code>pc-client</code> folder from the server.</p>
        <a href="/ai" class="btn btn-primary">Go to AI Agent</a>
    </div>
    `);
});

// Signup Payment Page
app.get('/signup-payment', (req, res) => {
    res.render('signup-payment', {
        title: 'Sign Up & Subscribe - Stackdrop Pro',
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
        supabaseAnon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    });
});

// ========================================
// STRIPE BILLING API - 7-DAY FREE TRIAL
// ========================================

// Create Stripe Checkout Session with FREE TRIAL
app.post('/api/billing/create-checkout-session', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ 
                error: 'Stripe is not configured. Please set STRIPE_SECRET_KEY environment variable.' 
            });
        }

        const { plan } = req.body;
        
        // Define Stripe Price IDs for each plan
        const stripePrices = {
            'starter':
                process.env.STRIPE_STARTER_PRICE_ID ||
                process.env.STRIPE_PRICE_ID_STARTER ||
                process.env.STRIPE_PRICE_ID ||
                'price_starter_test',
            'pro100':
                process.env.STRIPE_PRO100_PRICE_ID ||
                process.env.STRIPE_PRICE_ID_PRO100 ||
                'price_pro100_test'
        };

        if (!stripePrices[plan]) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Create Stripe Checkout Session with 7-day FREE TRIAL
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: stripePrices[plan],
                    quantity: 1,
                }
            ],
            // 🎉 7-DAY FREE TRIAL!
            subscription_data: {
                trial_period_days: 7,
                trial_settings: {
                    end_behavior: {
                        missing_payment_method: 'cancel'
                    }
                }
            },
            // Success/Cancel URLs
            success_url: `${process.env.SERVER_URL || process.env.PUBLIC_BASE_URL || ''}/pro/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SERVER_URL || process.env.PUBLIC_BASE_URL || ''}/signup-payment?plan=` + plan,
            // Customer email (if provided)
            customer_email: req.body.email,
            // Allow promo codes
            allow_promotion_codes: true,
            // Collect billing address
            billing_address_collection: 'auto'
        });

        res.json({ url: session.url });

    } catch (error) {
        console.error('Stripe checkout error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add 404 handling
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not Found'
    });
});

// Catch-all error handler for async errors
app.use((err, req, res, next) => {
    console.error('Global error handler:', err.stack || err);
    if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

// Stripe Webhook - Handle subscription events
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret || !stripe) {
        return res.status(400).send('Webhook not configured');
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
        switch (event.type) {
            case 'customer.subscription.trial_will_end':
                // Trial ending in 3 days - send reminder email
                console.log('Trial will end soon:', event.data.object.id);
                // TODO: Send reminder email to customer
                break;

            case 'customer.subscription.created':
                // New subscription started (with trial)
                console.log('Subscription created:', event.data.object.id);
                break;

            case 'customer.subscription.updated':
                // Subscription updated (e.g., trial ended, now active)
                console.log('Subscription updated:', event.data.object.id);
                break;

            case 'invoice.payment_succeeded':
                // Payment succeeded (first charge after trial)
                console.log('Payment succeeded:', event.data.object.id);
                break;

            case 'invoice.payment_failed':
                // Payment failed
                console.log('Payment failed:', event.data.object.id);
                // TODO: Send payment failed email
                break;

            case 'customer.subscription.deleted':
                // Subscription cancelled
                console.log('Subscription cancelled:', event.data.object.id);
                break;

            default:
                console.log(`Unhandled event type: ${event.type}`);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Webhook processing failed');
    }
});

// Success page after payment
app.get('/pro/success', async (req, res) => {
    const sessionId = req.query.session_id;
    
    if (!stripe || !sessionId) {
        return res.redirect('/pro');
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Welcome to Stackdrop Pro!</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { 
                        font-family: 'Inter', sans-serif; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 20px;
                    }
                    .success-card {
                        background: white;
                        border-radius: 20px;
                        padding: 60px 40px;
                        max-width: 500px;
                        width: 100%;
                        text-align: center;
                        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    }
                    .checkmark {
                        width: 80px;
                        height: 80px;
                        border-radius: 50%;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 30px;
                        animation: scaleIn 0.5s ease;
                    }
                    .checkmark svg {
                        width: 40px;
                        height: 40px;
                        stroke: white;
                        stroke-width: 3;
                        fill: none;
                        stroke-dasharray: 50;
                        stroke-dashoffset: 50;
                        animation: dash 0.5s ease 0.3s forwards;
                    }
                    @keyframes scaleIn {
                        from { transform: scale(0); }
                        to { transform: scale(1); }
                    }
                    @keyframes dash {
                        to { stroke-dashoffset: 0; }
                    }
                    h1 { 
                        color: #222; 
                        font-size: 32px; 
                        margin-bottom: 15px;
                        font-weight: 700;
                    }
                    p { 
                        color: #666; 
                        font-size: 16px; 
                        line-height: 1.6;
                        margin-bottom: 20px;
                    }
                    .trial-badge {
                        background: linear-gradient(135deg, rgba(102,126,234,0.1) 0%, rgba(118,75,162,0.1) 100%);
                        border: 2px solid #667eea;
                        border-radius: 12px;
                        padding: 20px;
                        margin: 25px 0;
                    }
                    .trial-badge h3 {
                        color: #667eea;
                        font-size: 18px;
                        margin-bottom: 10px;
                    }
                    .btn {
                        display: inline-block;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        text-decoration: none;
                        padding: 15px 40px;
                        border-radius: 10px;
                        font-weight: 600;
                        font-size: 16px;
                        margin-top: 20px;
                        transition: transform 0.2s;
                    }
                    .btn:hover {
                        transform: translateY(-2px);
                    }
                </style>
            </head>
            <body>
                <div class="success-card">
                    <div class="checkmark">
                        <svg viewBox="0 0 52 52">
                            <polyline points="14 27 22 35 38 19"/>
                        </svg>
                    </div>
                    <h1>🎉 Welcome to Stackdrop Pro!</h1>
                    <p>Your subscription is now active. You're all set to manage your apps like a pro!</p>
                    
                    <div class="trial-badge">
                        <h3>🎁 7-Day FREE Trial Active</h3>
                        <p style="margin: 0;">Enjoy full access for 7 days. We'll remind you 3 days before billing starts. Cancel anytime!</p>
                    </div>

                    <a href="/pro-dashboard" class="btn">Go to Dashboard</a>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error retrieving session:', error);
        res.redirect('/pro');
    }
});