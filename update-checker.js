const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const serverListPath = path.join(__dirname, 'silentinstallers', 'serverlist.txt');
const installersBaseDir = path.join(__dirname, 'silentinstallers'); // Directory to store downloaded EXEs
const {
    getInstallerFileName,
    getInstallerCandidates,
    getInstallMethod,
} = require('./installer-config');

// ---- Validation / atomic replace / per-app result log (2026-10-02 pass 2) ----
const logsDir = path.join(__dirname, 'logs');
const resultLogPath = path.join(logsDir, 'update-checker.log');
const resultJsonPath = path.join(logsDir, 'update-checker-last.json');
const DEFAULT_MIN_BYTES = 150 * 1024;            // smaller than any real installer we serve
const MIN_BYTES_OVERRIDE = {};
// Server-hosted ISOs: uploaded by hand, NEVER downloaded, replaced, validated or deleted by this script.
const PROTECTED_ISO_APP_IDS = new Set(['win11_iso', 'win10_iso', 'ubuntu_iso']);
// Any *.iso (and anything that resolves to one) in silentinstallers/ is off-limits to every cleanup path.
function isProtectedIsoName(name) { return /\.iso$/i.test(String(name || '')); }
async function isProtectedIsoPath(fullPath) {
    if (isProtectedIsoName(fullPath)) return true;
    try { return isProtectedIsoName(await fs.promises.realpath(fullPath)); } catch (_) { return false; }
}
// Apps that are not downloaded by the checker (server-hosted ISOs / local-only files)
const SKIP_DOWNLOAD_APP_IDS = new Set([...PROTECTED_ISO_APP_IDS, 'chrometransparency',
    // legacy serverlist rows that are not offered on the front page
    'duckduckgo', 'ubuntu_usb']);

function expectedKindFor(appId, fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (ext === '.zip') return 'zip';
    if (ext === '.iso') return 'iso';
    if (ext === '.msi') return 'msi';
    if (ext === '.msix' || ext === '.appx') return 'zip';
    let method = 'exe';
    try { method = getInstallMethod(appId); } catch (_) {}
    if (method === 'msi') return 'msi';
    if (method === 'unzip_exe') return 'zip';
    return 'exe';
}

// Validate a downloaded/stored installer: magic bytes for its kind + minimum size.
// Returns { ok, reason, kind, size }.
async function validateInstallerFile(filePath, appId, nameForKind) {
    const kind = expectedKindFor(appId, nameForKind || filePath);
    let fh;
    try {
        const st = await fs.promises.stat(filePath); // follows symlinks
        if (!st.isFile()) return { ok: false, reason: 'not a regular file', kind, size: 0 };
        const minBytes = MIN_BYTES_OVERRIDE[appId] || DEFAULT_MIN_BYTES;
        if (st.size < minBytes) return { ok: false, reason: `too small (${st.size} bytes < ${minBytes})`, kind, size: st.size };
        fh = await fs.promises.open(filePath, 'r');
        const head = Buffer.alloc(kind === 'iso' ? 0x8010 : 16);
        await fh.read(head, 0, head.length, 0);
        const txt = head.subarray(0, 16).toString('latin1').trimStart().toLowerCase();
        if (txt.startsWith('<!doctype') || txt.startsWith('<html') || txt.startsWith('<?xml') || txt.startsWith('<')) {
            return { ok: false, reason: 'HTML/XML page instead of installer', kind, size: st.size };
        }
        const isMZ = head[0] === 0x4d && head[1] === 0x5a;
        const isOLE = head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
        const isPK = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
        const isISO = kind === 'iso' && head.subarray(0x8001, 0x8006).toString('latin1') === 'CD001';
        const actual = isMZ ? 'exe' : isOLE ? 'msi' : isPK ? 'zip' : isISO ? 'iso' : 'unknown';
        if (actual !== kind) return { ok: false, reason: `expected ${kind} but file is ${actual}`, kind, size: st.size };
        return { ok: true, reason: '', kind, size: st.size };
    } catch (e) {
        return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : e.message, kind, size: 0 };
    } finally {
        if (fh) { try { await fh.close(); } catch (_) {} }
    }
}

// Point `linkPath` at `targetName` atomically (temp symlink + rename over the old one).
async function atomicSymlink(targetName, linkPath) {
    const tmp = `${linkPath}.lnk-tmp-${process.pid}`;
    await fs.promises.unlink(tmp).catch(() => {});
    await fs.promises.symlink(targetName, tmp);
    await fs.promises.rename(tmp, linkPath);
}

// Download url -> temp file in installersBaseDir, validate, then atomically move into place.
// The previous file stays untouched unless the new one is valid.
async function downloadValidated(appId, startUrl, installerPath, installerFilename) {
    if (PROTECTED_ISO_APP_IDS.has(appId) || isProtectedIsoName(installerFilename) || isProtectedIsoName(installerPath)) {
        throw new Error(`refusing to download/replace protected ISO for ${appId}`);
    }
    const tmpPath = path.join(installersBaseDir, `.${appId}.download-${process.pid}.part`);
    const meta = await new Promise((resolve, reject) => {
        const visit = (url, remaining) => {
            if (remaining <= 0) { reject(new Error(`Too many redirects at ${url}`)); return; }
            const proto = url.startsWith('https') ? https : http;
            const req = proto.get(url, { timeout: 120000, headers: headersForUrl(url) }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); visit(resolveRedirect(url, res.headers.location), remaining - 1); return;
                }
                if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} at ${url}`)); return; }
                if (/text\/html/i.test(String(res.headers['content-type'] || ''))) { res.resume(); reject(new Error(`HTML response (landing page) at ${url}`)); return; }
                const cd = res.headers['content-disposition'] || ''; let vendorFilename = null;
                try { const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i); if (m && m[1]) vendorFilename = decodeURIComponent(m[1].trim().replace(/"/g, '')); } catch (_) {}
                if (!vendorFilename) { try { vendorFilename = path.basename(new URL(url).pathname) || installerFilename; } catch (_) { vendorFilename = installerFilename; } }
                if (FORCE_DOWNLOAD_BASENAME[appId]) vendorFilename = FORCE_DOWNLOAD_BASENAME[appId];
                try { vendorFilename = decodeURIComponent(vendorFilename); } catch (_) {}
                vendorFilename = path.basename(String(vendorFilename).replace(/%20/g, ' '));
                if (!path.extname(vendorFilename)) vendorFilename = installerFilename; // e.g. ".../download"
                const out = fs.createWriteStream(tmpPath);
                res.pipe(out);
                res.on('error', (e) => { out.destroy(); reject(e); });
                out.on('error', (e) => reject(e));
                out.on('finish', () => out.close(() => resolve({ vendorFilename, finalUrl: url })));
            });
            req.on('error', (e) => reject(e));
            req.on('timeout', () => { req.destroy(new Error('Download request timed out')); });
        };
        visit(startUrl, 10);
    }).catch(async (e) => { await fs.promises.unlink(tmpPath).catch(() => {}); throw e; });

    const v = await validateInstallerFile(tmpPath, appId, meta.vendorFilename);
    if (!v.ok) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw new Error(`validation failed (${v.reason}); kept previous file`);
    }
    const vendorPath = path.join(installersBaseDir, meta.vendorFilename);
    if (isProtectedIsoName(meta.vendorFilename)) { await fs.promises.unlink(tmpPath).catch(() => {}); throw new Error('refusing to write an .iso into silentinstallers'); }
    await fs.promises.rename(tmpPath, vendorPath);           // atomic within the same directory
    if (path.basename(vendorPath) !== path.basename(installerPath)) {
        await atomicSymlink(meta.vendorFilename, installerPath);
    }
    return { vendorFilename: meta.vendorFilename, vendorPath, size: v.size, finalUrl: meta.finalUrl };
}

// When vendor Content-Disposition or redirect basename is wrong, save under this name
const FORCE_DOWNLOAD_BASENAME = {
    malwarebytes: 'MBSetup.exe',
    avg: 'avg_antivirus_free_setup.exe',
    avira: 'avira_en_sptl1___pfsws-spotlight-release.exe',
    dotnet481: 'NDP481-Web.exe',
    dotnet481x86: 'NDP481-Web.exe',
    spybot2: 'spybotsd-2.9.85.5.exe',
};
const versionsDir = path.join(installersBaseDir, 'versions');
const lockFilePath = path.join(__dirname, 'update-checker.lock');
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StackdropUpdateChecker/1.0',
  'Accept': '*/*'
};

const GITHUB_API_HEADERS = {
  ...DEFAULT_HEADERS,
  Accept: 'application/vnd.github+json',
};

// SourceForge serves an HTML "your download will start" page to browser-like
// user agents; a plain wget UA gets the 302 to the mirror file instead.
const SOURCEFORGE_HEADERS = {
  'User-Agent': 'Wget/1.21.4',
  'Accept': '*/*'
};
function headersForUrl(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        if (h === 'sourceforge.net' || h.endsWith('.sourceforge.net')) return SOURCEFORGE_HEADERS;
        // irfanview.info serves an HTML "download" page unless the request comes from its own site
        if (h === 'www.irfanview.info' || h === 'irfanview.info') return { ...DEFAULT_HEADERS, Referer: 'https://www.irfanview.info/' };
    } catch (_) {}
    return DEFAULT_HEADERS;
}
// Apps whose download must be a real binary; an HTML response is rejected so a
// landing page never replaces a working installer (added 2026-10-02).
const REJECT_HTML_APP_IDS = new Set([
    'brave', 'vivaldi', 'pidgin', 'trillian', 'sugarsync', 'wireshark', 'powertoys',
    'tightvnc', 'teracopy', 'cdburnerxp', 'infrarecorder', 'launchy', 'wiztree', 'glary',
    'openshell', 'everything', 'keepass2', 'evernote', 'nvaccess', 'gitscm', 'winscp',
    'putty', 'winmerge', 'eclipse', 'bambustudio', 'ultimakercura', 'dotnet10',
    'dotnet10desktop', 'vcredist2015-2022x64', 'vcredist2015-2022x86', 'temurin25x64',
]);

function resolveRedirect(currentUrl, location) {
    if (!location) return currentUrl;
    if (location.startsWith('http://') || location.startsWith('https://')) return location;
    const urlObj = new URL(currentUrl);
    if (location.startsWith('/')) return `${urlObj.protocol}//${urlObj.host}${location}`;
    const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
    return `${urlObj.protocol}//${urlObj.host}${basePath}${location}`;
}

function headerFileSize(headers) {
    const range = headers['content-range'] || '';
    const total = range.match(/\/(\d+)\s*$/);
    if (total) return Number(total[1]);
    const len = headers['content-length'];
    if (len && /^\d+$/.test(String(len))) return Number(len);
    return null;
}

async function requestHeaders(url, method, extraHeaders) {
    const protocol = url.startsWith('https') ? https : http;
    return await new Promise((resolve, reject) => {
        const req = protocol.request(url, {
            method,
            timeout: 20000,
            headers: { ...headersForUrl(url), ...extraHeaders },
        }, (res) => {
            res.resume();
            resolve(res);
        });
        req.on('error', (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error(`${method} timeout`)); });
        req.end();
    });
}

// Follow redirects to the published file so etag, date, and size come from the EXE itself.
async function probeFinal(startUrl, maxRedirects = 8) {
    let current = startUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        let res;
        try {
            res = await requestHeaders(current, 'HEAD');
        } catch (_) {
            res = null;
        }
        if (!res || res.statusCode === 405 || (res.statusCode && res.statusCode >= 400)) {
            try {
                res = await requestHeaders(current, 'GET', { Range: 'bytes=0-0' });
            } catch (_) {
                return { ok: false };
            }
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            current = resolveRedirect(current, res.headers.location);
            continue;
        }
        if (res.statusCode && res.statusCode < 400) {
            return {
                ok: true,
                finalUrl: current,
                etag: res.headers.etag || 'N/A',
                lastModified: res.headers['last-modified'] || 'N/A',
                size: headerFileSize(res.headers),
            };
        }
        return { ok: false };
    }
    return { ok: false };
}

async function headProbeOk(url) {
    try {
        const protocol = url.startsWith('https') ? https : http;
        const response = await new Promise((resolve, reject) => {
            const req = protocol.request(url, { method: 'HEAD', timeout: 10000, headers: DEFAULT_HEADERS }, (res) => resolve(res));
            req.on('error', (e) => reject(e));
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        });
        return response.statusCode >= 200 && response.statusCode < 400;
    } catch (_) {
        return false;
    }
}

async function acquireRunLock() {
    try {
        const fd = await fs.promises.open(lockFilePath, 'wx');
        await fd.write(String(process.pid));
        await fd.close();
        return true;
    } catch (e) {
        if (e && e.code === 'EEXIST') {
            try {
                const st = await fs.promises.stat(lockFilePath);
                const ageMs = Date.now() - st.mtimeMs;
                if (ageMs > LOCK_STALE_MS) {
                    await fs.promises.unlink(lockFilePath).catch(() => {});
                    const fd2 = await fs.promises.open(lockFilePath, 'wx');
                    await fd2.write(String(process.pid));
                    await fd2.close();
                    return true;
                }
            } catch (_) {}
        }
        return false;
    }
}

async function releaseRunLock() {
    try { await fs.promises.unlink(lockFilePath); } catch (_) {}
}

// Helper to fetch text content with basic redirect handling
async function fetchTextWithRedirects(url, maxRedirects = 10, headers = DEFAULT_HEADERS) {
    return await new Promise((resolve, reject) => {
        const visit = (currentUrl, remaining) => {
            if (remaining <= 0) {
                reject(new Error(`Too many redirects while fetching ${currentUrl}`));
                return;
            }
            const protocol = currentUrl.startsWith('https') ? https : http;
            const req = protocol.get(currentUrl, { timeout: 30000, headers }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let redirectUrl = res.headers.location;
                    if (redirectUrl.startsWith('/')) {
                        const urlObj = new URL(currentUrl);
                        redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                    } else if (!redirectUrl.startsWith('http')) {
                        const urlObj = new URL(currentUrl);
                        const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
                        redirectUrl = `${urlObj.protocol}//${urlObj.host}${basePath}${redirectUrl}`;
                    }
                    visit(redirectUrl, remaining - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`Failed to fetch ${currentUrl} (status ${res.statusCode})`));
                    return;
                }
                res.setEncoding('utf8');
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.on('error', (e) => reject(new Error(`Request error for ${currentUrl}: ${e.message}`)));
            req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out for ${currentUrl}`)); });
        };
        visit(url, maxRedirects);
    });
}

// Special function to get latest Opera download URL
async function getLatestOperaUrl() {
    try {
        const baseUrl = 'https://get.opera.com/ftp/pub/opera/desktop/';
        const indexHtml = await fetchTextWithRedirects(baseUrl);
        const versionMatches = [...indexHtml.matchAll(/href="(\d+\.\d+\.\d+\.\d+)\//g)].map(m => m[1]);
        if (!versionMatches || versionMatches.length === 0) {
            throw new Error('No Opera versions found in directory listing');
        }
        const parseVersion = (v) => v.split('.').map((n) => parseInt(n, 10));
        versionMatches.sort((a, b) => {
            const aa = parseVersion(a), bb = parseVersion(b);
            for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
                const ai = aa[i] || 0;
                const bi = bb[i] || 0;
                if (ai !== bi) return bi - ai;
            }
            return 0;
        });
        // Try versions from latest to older until one has the expected x64 setup
        for (const version of versionMatches) {
            try {
                const winDir = `${baseUrl}${version}/win/`;
                const winHtml = await fetchTextWithRedirects(winDir);
                const fileMatch = winHtml.match(new RegExp(`href="Opera_${version}_Setup_x64\\.exe"`));
                if (fileMatch) {
                    return `${winDir}Opera_${version}_Setup_x64.exe`;
                }
                // Fallback to non-suffixed Setup if x64 specifically not listed
                const genericMatch = winHtml.match(new RegExp(`href="Opera_${version}_Setup\\.exe"`));
                if (genericMatch) {
                    return `${winDir}Opera_${version}_Setup.exe`;
                }
            } catch (innerError) {
                // Continue to previous version
            }
        }
        throw new Error('Could not resolve a valid Opera x64 installer URL');
    } catch (error) {
        throw new Error(`Failed to get latest Opera URL: ${error.message}`);
    }
}

// Resolve latest Tor Browser download URL
async function getLatestTorUrl() {
    try {
        // Try dist.torproject.org first
        const distUrl = 'https://dist.torproject.org/torbrowser/';
        const distHtml = await fetchTextWithRedirects(distUrl);
        const versionMatches = [...distHtml.matchAll(/href="(\d+\.\d+\.\d+)\//g)].map(m => m[1]);
        if (versionMatches && versionMatches.length > 0) {
            // Sort versions to get latest
            const sorted = versionMatches.sort((a, b) => {
                const pa = a.split('.').map(Number);
                const pb = b.split('.').map(Number);
                for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                    const ai = pa[i] || 0;
                    const bi = pb[i] || 0;
                    if (ai !== bi) return bi - ai;
                }
                return 0;
            });

            const latestVersion = sorted[0];
            // Try to find Windows installer in the version directory
            const versionDir = `${distUrl}${latestVersion}/`;
            const versionHtml = await fetchTextWithRedirects(versionDir);
            const exeMatch = versionHtml.match(/href="([^"]*tor-browser-windows-x86_64-portable-[\d.]+\.exe)"/i)
                || versionHtml.match(/href="([^"]*torbrowser-install-win64[^"]*\.exe)"/i);
            if (exeMatch) {
                const exePath = exeMatch[1];
                if (exePath.startsWith('http')) {
                    return exePath;
                } else {
                    return versionDir + exePath;
                }
            }
        }

        // Fallback to Tor Project download page
        const pageUrl = 'https://www.torproject.org/download/';
        const html = await fetchTextWithRedirects(pageUrl);
        const winMatch = html.match(/href="(https?:\/\/[^"']*torbrowser.*windows[^"']*\.exe)"/i);
        if (winMatch) {
            return winMatch[1];
        }

        throw new Error('No Tor Browser Windows installer link found');
    } catch (error) {
        throw new Error(`Failed to get latest Tor URL: ${error.message}`);
    }
}

// Resolve latest Winamp EXE by scraping official downloads page
async function getLatestWinampUrl() {
    // Official stable "latest full" link (winamp.com/media/files/... now redirects to an HTML page)
    const latest = 'https://download.winamp.com/winamp/winamp_latest_full.exe';
    if (await headProbeOk(latest)) return latest;
    try {
        const pageUrl = 'https://www.winamp.com/downloads/';
        const html = await fetchTextWithRedirects(pageUrl);
        // Look for any .exe link that includes "winamp" in path
        const exeMatches = [...html.matchAll(/href\s*=\s*"(https?:[^"']+winamp[^"']+\.exe)"/gi)].map(m => m[1]);
        if (exeMatches.length) return exeMatches[0];
        // Fallback: generic media file path pattern
        const mediaMatch = html.match(/https?:[^"']+\/media\/files\/[^"']+\.exe/);
        if (mediaMatch) return mediaMatch[0];
        throw new Error('No Winamp EXE link found');
    } catch (e) {
        throw new Error(`Failed to get latest Winamp URL: ${e.message}`);
    }
}

async function getLatestRufusUrl() {
    try {
        const json = await fetchTextWithRedirects('https://api.github.com/repos/pbatard/rufus/releases/latest', 10, GITHUB_API_HEADERS);
        const obj = JSON.parse(json);
        const assets = obj.assets || [];
        const standard = assets.find((a) => /^rufus-[\d.]+\.exe$/i.test(a.name));
        if (standard && standard.browser_download_url) return standard.browser_download_url;
        const portable = assets.find((a) => /^rufus-[\d.]+p\.exe$/i.test(a.name));
        if (portable && portable.browser_download_url) return portable.browser_download_url;
    } catch (e) {
        console.warn(`Rufus GitHub resolver failed: ${e.message}`);
    }
    return 'https://github.com/pbatard/rufus/releases/download/v4.14/rufus-4.14.exe';
}

// Resolve latest Spotify Windows installer from official CDN.
async function getLatestSpotifyUrl() {
    const candidates = [
        'https://download.scdn.co/SpotifySetup.exe',
        'https://download.spotify.com/SpotifySetup.exe',
    ];
    for (const url of candidates) {
        try {
            const headOk = await new Promise((resolve) => {
                const req = https.request(url, { method: 'HEAD', timeout: 15000, headers: DEFAULT_HEADERS }, (res) => {
                    resolve(res.statusCode && res.statusCode < 400);
                });
                req.on('error', () => resolve(false));
                req.on('timeout', () => { req.destroy(); resolve(false); });
                req.end();
            });
            if (headOk) return url;
        } catch (_) {}
    }
    return candidates[0];
}

async function getLatestThunderbirdUrl() {
    return 'https://download.mozilla.org/?product=thunderbird-latest&os=win64&lang=en-US';
}

async function getLatestEmClientUrl() {
    return 'https://www.emclient.com/dist/latest/setup.msi';
}

// Resolve latest GOM Player Windows installer from GOM Lab CDN.
async function getLatestGomUrl() {
    const preferred = 'https://cdn.gomlab.com/gretech/player/GOMPLAYERGLOBALSETUP_CHROME.EXE';
    try {
        const headOk = await new Promise((resolve) => {
            const req = https.request(preferred, { method: 'HEAD', timeout: 15000, headers: DEFAULT_HEADERS }, (res) => {
                resolve(res.statusCode && res.statusCode < 400);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
        if (headOk) return preferred;
    } catch (_) {}
    try {
        const html = await fetchTextWithRedirects('https://www.gomlab.com/en/gomplayer-media-player');
        const chrome = html.match(/https:\/\/cdn\.gomlab\.com\/gretech\/player\/GOMPLAYERGLOBALSETUP_CHROME\.EXE/i);
        if (chrome) return chrome[0];
        const any = html.match(/https:\/\/cdn\.gomlab\.com\/gretech\/player\/GOMPLAYER[A-Z0-9_]+\.EXE/i);
        if (any) return any[0];
    } catch (e) {
        console.warn(`GOM page resolver failed: ${e.message}`);
    }
    return preferred;
}

// Resolve latest MusicBee installer via MajorGeeks mirror (official getmusicbee.com links often 404).
async function getLatestMusicBeeUrl() {
    const fallback = 'https://files2.majorgeeks.com/4cfce22768f4d9d44539591e1ad04a8fc154df3a/multimedia/MusicBeeSetup_3_6_Update1.zip';
    try {
        for (const pageUrl of [
            'https://www.majorgeeks.com/mg/getmirror/musicbee,1.html',
            'https://www.majorgeeks.com/mg/getmirror/musicbee,2.html',
        ]) {
            const html = await fetchTextWithRedirects(pageUrl);
            const mg = html.match(/https:\/\/files2\.majorgeeks\.com\/[^"'\s<>]+\/multimedia\/MusicBee[^"'\s<>]+\.zip/i);
            if (mg) return mg[0];
        }
    } catch (e) {
        console.warn(`MusicBee MajorGeeks resolver failed: ${e.message}`);
    }
    return fallback;
}

// Extract MusicBeeSetup_*.exe from a MajorGeeks zip wrapper.
async function extractMusicBeeInstaller(zipPath, installersBaseDir) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const listOut = await execFileAsync('unzip', ['-Z1', zipPath], { timeout: 30000 });
    const exeName = listOut.stdout.split('\n').map((s) => s.trim()).find((n) => /^MusicBeeSetup_.*\.exe$/i.test(n));
    if (!exeName) throw new Error('No MusicBeeSetup_*.exe found in zip');
    const installerLink = path.join(installersBaseDir, 'musicbee_installer.exe');
    await execFileAsync('unzip', ['-o', '-j', zipPath, exeName, '-d', installersBaseDir], { timeout: 60000 });
    await fs.promises.unlink(installerLink).catch(() => {});
    await fs.promises.symlink(exeName, installerLink);
    return path.join(installersBaseDir, exeName);
}

// Resolve latest GIMP Windows installer from official downloads page
async function getLatestGimpUrl() {
    try {
        const pageUrl = 'https://www.gimp.org/downloads/';
        const html = await fetchTextWithRedirects(pageUrl);
        // Look for a Windows setup EXE link
        const m = html.match(/href\s*=\s*"((?:https?:)?\/\/[^"']*gimp-[\d.]+-setup(?:-\d+)?\.exe)"/i);
        if (m && m[1].startsWith('//')) return 'https:' + m[1];
        if (m) return m[1];
        // Fallback: mirror path commonly used
        const m2 = html.match(/https?:[^"']*\/gimp\/v\d+\.\d+\/windows\/gimp-[\d.]+-setup(?:-\d+)?\.exe/i);
        if (m2) return m2[0];
        throw new Error('No GIMP Windows installer link found');
    } catch (e) {
        throw new Error(`Failed to get latest GIMP URL: ${e.message}`);
    }
}

// Resolve latest SumatraPDF 64-bit installer
async function getLatestSumatraUrl() {
    try {
        const pageUrl = 'https://www.sumatrapdfreader.org/download-free-pdf-viewer';
        const html = await fetchTextWithRedirects(pageUrl);
        // Look for relative URLs like /dl/rel/3.5.2/SumatraPDF-3.5.2-64-install.exe
        const m = html.match(/href\s*=\s*"(\/dl\/rel\/[^"']*\/SumatraPDF-[^"']*-64-install\.exe)"/i);
        if (m) {
            return 'https://www.sumatrapdfreader.org' + m[1];
        }
    } catch (_) {}
    // Fallback to latest version
    return 'https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64-install.exe';
}

// Resolve latest WinRAR x64 installer from rarlab download page
async function getLatestWinrarUrl() {
    try {
        const pageUrl = 'https://www.rarlab.com/download.htm';
        const html = await fetchTextWithRedirects(pageUrl);
        
        // Try multiple patterns to find the WinRAR x64 installer
        // Pattern 1: Direct href with winrar-x64 (most common)
        let m = html.match(/href\s*=\s*["'](https?:[^"']*winrar-x64-[^"']+\.exe)["']/i);
        if (m) {
            let url = m[1];
            // Make sure it's a full URL
            if (url.startsWith('/')) {
                url = 'https://www.rarlab.com' + url;
            }
            console.log(`WinRAR: Found URL via Pattern 1: ${url}`);
            return url;
        }
        
        // Pattern 2: Look for rar/winrar-x64 pattern (relative path)
        m = html.match(/href\s*=\s*["']([^"']*\/rar\/winrar-x64-[^"']+\.exe)["']/i);
        if (m) {
            let url = m[1];
            if (url.startsWith('/')) {
                url = 'https://www.rarlab.com' + url;
            } else if (!url.startsWith('http')) {
                url = 'https://www.rarlab.com/' + url;
            }
            console.log(`WinRAR: Found URL via Pattern 2: ${url}`);
            return url;
        }
        
        // Pattern 3: Look for any winrar download link with x64
        m = html.match(/href\s*=\s*["']([^"']*winrar[^"']*x64[^"']*\.exe)["']/i);
        if (m) {
            let url = m[1];
            if (url.startsWith('/')) {
                url = 'https://www.rarlab.com' + url;
            } else if (!url.startsWith('http')) {
                url = 'https://www.rarlab.com/' + url;
            }
            console.log(`WinRAR: Found URL via Pattern 3: ${url}`);
            return url;
        }
        
        // Pattern 4: Look for winrar.exe in rar/ directory (fallback pattern)
        m = html.match(/href\s*=\s*["']([^"']*\/rar\/winrar[^"']*\.exe)["']/i);
        if (m) {
            let url = m[1];
            if (url.startsWith('/')) {
                url = 'https://www.rarlab.com' + url;
            } else if (!url.startsWith('http')) {
                url = 'https://www.rarlab.com/' + url;
            }
            // Only use if it contains x64 or w64 (64-bit indicator)
            if (url.toLowerCase().includes('x64') || url.toLowerCase().includes('w64')) {
                console.log(`WinRAR: Found URL via Pattern 4: ${url}`);
                return url;
            }
        }
        
        console.warn('WinRAR: Could not find download URL in HTML, using fallback');
    } catch (error) {
        console.warn(`Failed to fetch WinRAR URL from rarlab.com: ${error.message}`);
    }
    // Fallback to latest stable version URLs (try multiple known versions)
    // Latest stable: 7.13 (as of 2025)
    const fallbackUrls = [
        'https://www.rarlab.com/rar/winrar-x64-713.exe',  // Version 7.13
        'https://www.rarlab.com/rar/winrar-x64-712.exe',  // Version 7.12
        'https://www.rarlab.com/rar/winrar-x64-711.exe',  // Version 7.11
        'https://www.rarlab.com/rar/winrar-x64-710.exe',  // Version 7.10
        'https://www.rarlab.com/rar/winrar-x64-720b3.exe'  // Beta fallback
    ];
    console.log(`WinRAR: Using fallback URL: ${fallbackUrls[0]}`);
    return fallbackUrls[0];
}

// Epic Games Launcher official endpoint
async function getLatestEpicGamesUrl() {
    return 'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi';
}

// BlueStacks official download (API returns latest micro-installer)
async function getLatestBlueStacksUrl() {
    return 'https://cloud.bluestacks.com/api/getdownloadnow?platform=win&win_version=10&os_type=windows&is_64bit=true&bsx=true';
}

// Resolve latest Google Earth Pro x64
async function getLatestGoogleEarthUrl() {
    // Prefer x64 offline; updater will HEAD probe
    return 'https://dl.google.com/dl/earth/client/advanced/current/googleearthprowin-x64.exe';
}

// Resolve latest Greenshot via GitHub API
async function getLatestGreenshotUrl() {
    try {
        const json = await fetchTextWithRedirects('https://api.github.com/repos/greenshot/greenshot/releases/latest');
        const obj = JSON.parse(json);
        const asset = (obj.assets || []).find(a => /Greenshot-.*INSTALLER.*RELEASE\.exe/i.test(a.name));
        if (asset && asset.browser_download_url) return asset.browser_download_url;
    } catch (_) {}
    // Fallback to latest tag redirect
    return 'https://github.com/greenshot/greenshot/releases/latest/download/Greenshot-INSTALLER-1.3.301-RELEASE.exe';
}

// Resolve latest ShareX via GitHub API
async function getLatestShareXUrl() {
    return getGithubReleaseAsset(
        'ShareX/ShareX',
        /ShareX-.*setup(-x64)?\.exe$/i,
        null
    );
}

// Resolve latest CutePDF Writer installer
async function getLatestCutePdfUrl() {
    // Official stable link
    return 'https://www.cutepdf.com/download/CuteWriter.exe';
}

// Resolve latest Trillian for Windows from downloads page
async function getLatestTrillianUrl() {
    try {
        const html = await fetchTextWithRedirects('https://www.trillian.im/get/windows/thanks/');
        const m = html.match(/["'](\/get\/windows\/\d+\.\d+\/)["']/i);
        if (m) return `https://www.trillian.im${m[1]}`;
    } catch (_) {}
    // Fallback: current major.minor download path (redirects to trillian-vX.Y.Z.exe)
    return 'https://www.trillian.im/get/windows/6.6/';
}

// Resolve latest NVDA installer from download page
async function getLatestNvdaWinUrl() {
    try {
        const html = await fetchTextWithRedirects('https://www.nvaccess.org/download/');
        const m = html.match(/href\s*=\s*"(https?:[^"']*nvda_[^"']*\.exe)"/i);
        if (m) return m[1];
    } catch (_) {}
    return 'https://downloads.nvaccess.org/nvda/releases/stable/nvda_2024.3.exe';
}

// ---- Ninite parity resolvers (2026-10-02) ----
// Strict GitHub latest-release asset lookup: only returns an asset matching pattern.
async function getGithubAssetStrict(repo, pattern) {
    const json = await fetchTextWithRedirects(`https://api.github.com/repos/${repo}/releases/latest`, 10, GITHUB_API_HEADERS);
    const obj = JSON.parse(json);
    const asset = (obj.assets || []).find((a) => pattern.test(a.name));
    if (asset && asset.browser_download_url) return asset.browser_download_url;
    throw new Error(`No asset matching ${pattern} in ${repo}`);
}
async function getLatestVivaldiUrl() {
    const html = await fetchTextWithRedirects('https://vivaldi.com/download/');
    const urls = [...html.matchAll(/https:\/\/downloads\.vivaldi\.com\/stable\/Vivaldi\.([\d.]+)\.x64\.exe/g)];
    if (!urls.length) throw new Error('No Vivaldi x64 installer link found');
    const cmp = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pb[i] || 0) - (pa[i] || 0); if (d) return d; } return 0; };
    const best = urls.map((m) => m[1]).sort(cmp)[0];
    return `https://downloads.vivaldi.com/stable/Vivaldi.${best}.x64.exe`;
}
async function getLatestKeePassUrl() {
    const html = await fetchTextWithRedirects('https://keepass.info/download.html');
    const m = html.match(/KeePass%202\.x\/([\d.]+)\/KeePass-\1-Setup\.exe/i);
    if (!m) throw new Error('No KeePass 2 setup link found');
    return `https://downloads.sourceforge.net/project/keepass/KeePass%202.x/${m[1]}/KeePass-${m[1]}-Setup.exe`;
}
async function getLatestWinScpUrl() {
    const html = await fetchTextWithRedirects('https://winscp.net/eng/download.php');
    const m = html.match(/WinSCP-([\d.]+)-Setup\.exe/i);
    if (!m) throw new Error('No WinSCP setup link found');
    return `https://downloads.sourceforge.net/project/winscp/WinSCP/${m[1]}/WinSCP-${m[1]}-Setup.exe`;
}
async function getLatestWizTreeUrl() {
    const html = await fetchTextWithRedirects('https://diskanalyzer.com/download');
    const m = html.match(/files\/(wiztree_[\d_]+_setup\.exe)/i);
    if (!m) throw new Error('No WizTree setup link found');
    return `https://diskanalyzer.com/files/${m[1]}`;
}
async function getLatestPuttyUrl() {
    const html = await fetchTextWithRedirects('https://the.earth.li/~sgtatham/putty/latest/w64/');
    const m = html.match(/href="(putty-64bit-[\d.]+-installer\.msi)"/i);
    if (!m) throw new Error('No PuTTY x64 MSI link found');
    return `https://the.earth.li/~sgtatham/putty/latest/w64/${m[1]}`;
}

// Resolve latest PeaZip via GitHub API
async function getLatestPeaZipUrl() {
    try {
        const json = await fetchTextWithRedirects('https://api.github.com/repos/peazip/PeaZip/releases/latest');
        const obj = JSON.parse(json);
        const asset = (obj.assets || []).find(a => /peazip-.*\.WIN64\.exe$/i.test(a.name));
        if (asset && asset.browser_download_url) return asset.browser_download_url;
    } catch (_) {}
    // Fallback to latest tag redirect
    return 'https://github.com/peazip/PeaZip/releases/latest/download/peazip-10.6.1.WIN64.exe';
}

// Resolve latest Inkscape Windows x64 via release page
async function getLatestInkscapeUrl() {
    try {
        // First try to get the latest version from the releases page
        const releasePage = await fetchTextWithRedirects('https://inkscape.org/release/');
        const versionMatch = releasePage.match(/inkscape-([\d.]+).*windows.*64-bit/i);
        const version = versionMatch ? versionMatch[1] : '1.3.2';

        // Now fetch the specific version download page
        const downloadPageUrl = `https://inkscape.org/release/inkscape-${version}/windows/64-bit/exe/dl/`;
        const downloadPage = await fetchTextWithRedirects(downloadPageUrl);

        // Look for the gallery redirect URL in the download page
        const galleryMatch = downloadPage.match(/href="([^"]*inkscape[^"]*\.exe)"/i) ||
                           downloadPage.match(/url=([^"'\s]+inkscape[^"'\s]*\.exe)/i) ||
                           downloadPage.match(/href='([^']*inkscape[^']*\.exe)'/i);

        if (galleryMatch) {
            const galleryUrl = galleryMatch[1];
            if (galleryUrl.startsWith('http')) {
                return galleryUrl;
            } else if (galleryUrl.startsWith('/')) {
                return 'https://inkscape.org' + galleryUrl;
            }
        }

        // If we can't find the direct link, try the gallery pattern
        const fallbackPage = await fetchTextWithRedirects(downloadPageUrl);
        const fallbackMatch = fallbackPage.match(/href="\/gallery\/item\/\d+\/inkscape[^"]*"/i);
        if (fallbackMatch) {
            return 'https://inkscape.org' + fallbackMatch[0].match(/href="([^"]+)"/)[1];
        }
    } catch (e) {
        console.warn(`Inkscape URL resolution failed: ${e.message}`);
    }

    // Final fallback to known working URL
    return 'https://inkscape.org/gallery/item/44617/inkscape-1.3.2_2023-11-25_091e20e-x64.exe';
}

// Resolve latest KLite Codec Pack URL by checking the official website
async function getLatestKLiteCodecUrl() {
    try {
        const pageUrl = 'https://www.codecguide.com/download_kl.htm';
        const html = await fetchTextWithRedirects(pageUrl);
        
        // Look for the Standard version download link
        const standardMatch = html.match(/href="(https:\/\/files2\.codecguide\.com\/K-Lite_Codec_Pack_\d+_Standard\.exe)"/);
        if (standardMatch) {
            return standardMatch[1];
        }
        
        // Fallback: look for any K-Lite Codec Pack download
        const genericMatch = html.match(/href="(https:\/\/files2\.codecguide\.com\/K-Lite_Codec_Pack_\d+_.*\.exe)"/);
        if (genericMatch) {
            return genericMatch[1];
        }
        
        throw new Error('No KLite Codec Pack download link found');
    } catch (e) {
        throw new Error(`Failed to get latest KLite Codec Pack URL: ${e.message}`);
    }
}

// Resolve latest Discord installer by using their API
async function getLatestDiscordUrl() {
    try {
        // Discord API endpoint for latest stable Windows x64 installer
        const apiUrl = 'https://discord.com/api/downloads/distributions/app/installers/latest?channel=stable&platform=win&arch=x64';
        
        // Make a HEAD request to get the final redirect URL
        const response = await new Promise((resolve, reject) => {
            const req = https.request(apiUrl, { method: 'HEAD', timeout: 30000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    resolve(res.headers.location);
                } else if (res.statusCode === 200) {
                    resolve(apiUrl);
                } else {
                    reject(new Error(`Discord API returned status ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Discord API request timed out'));
            });
            req.end();
        });
        
        return response;
    } catch (e) {
        throw new Error(`Failed to get latest Discord URL: ${e.message}`);
    }
}

// Resolve latest Cursor Windows (x64) User installer
async function getLatestCursorUrl() {
    try {
        // Try the official API endpoint first
        const apiUrl = 'https://api2.cursor.sh/updates/download/golden/win32-x64/cursor/1.6';
        const response = await new Promise((resolve, reject) => {
            const protocol = apiUrl.startsWith('https') ? https : http;
            const req = protocol.request(apiUrl, { method: 'HEAD', timeout: 10000 }, (res) => {
                resolve(res);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
        });
        if (response.statusCode < 400) {
            return apiUrl;
        }
    } catch (_) {}
    
    try {
        // Fallback to main download page
        const pageUrl = 'https://cursor.com/download';
        const html = await fetchTextWithRedirects(pageUrl);
        const exeLinks = [...html.matchAll(/href\s*=\s*"(https?:[^"']*CursorSetup\.exe)"/gi)].map((m) => m[1]);
        if (exeLinks.length > 0) {
            return exeLinks[0];
        }
    } catch (_) {}
    
    // Final fallback to API endpoint
    return 'https://api2.cursor.sh/updates/download/golden/win32-x64/cursor/1.6';
}

// Resolve latest Android Studio Windows installer
async function getLatestAndroidStudioUrl() {
    try {
        // Try the official download redirect endpoint
        const redirectUrl = 'https://redirector.gvt1.com/edgedl/android/studio/install/2024.2.1.12/android-studio-2024.2.1.12-windows.exe';
        
        // Check if the direct link works
        try {
            const response = await new Promise((resolve, reject) => {
                https.get(redirectUrl, { timeout: 10000, method: 'HEAD' }, (res) => {
                    resolve(res);
                }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
            });
            if (response.statusCode === 200 || response.statusCode === 302) {
                return redirectUrl;
            }
        } catch (_) {}
        
        // Fallback to developer.android.com download page
        const pageUrl = 'https://developer.android.com/studio';
        const html = await fetchTextWithRedirects(pageUrl);
        
        // Look for Windows .exe download link
        const exeMatch = html.match(/href="(https?:[^"']*android-studio[^"']*windows[^"']*\.exe)"/i) ||
                         html.match(/href="(https?:[^"']*\/edgedl\/android\/studio\/install\/[^"']*\.exe)"/i);
        
        if (exeMatch) {
            return exeMatch[1];
        }
        
        // Final fallback to a known stable download URL structure
        return 'https://redirector.gvt1.com/edgedl/android/studio/install/latest/android-studio-windows.exe';
        
    } catch (error) {
        // Ultimate fallback
        return 'https://developer.android.com/studio/install';
    }
}

// Resolve latest Everything (Voidtools) installer
async function getLatestEverythingUrl() {
    const pageUrl = 'https://www.voidtools.com/downloads/';
    const html = await fetchTextWithRedirects(pageUrl);
    const match = html.match(/href="(https?:[^"']*Everything-[\d\.]+\.x64-Setup\.exe)"/i);
    if (match) return match[1];
    throw new Error('No Everything x64 installer link found');
}

// Resolve latest WinDirStat installer from GitHub releases
async function getLatestWinDirStatUrl() {
    const json = await fetchTextWithRedirects('https://api.github.com/repos/windirstat/windirstat/releases/latest');
    const obj = JSON.parse(json);
    const asset = (obj.assets || []).find(a => /WinDirStat-x64\.msi$/i.test(a.name));
    if (asset && asset.browser_download_url) return asset.browser_download_url;
    throw new Error('No WinDirStat x64 installer found');
}

// Resolve latest NVDA installer
async function getLatestNvdaUrl() {
    try {
        // Try GitHub releases first
        const json = await fetchTextWithRedirects('https://api.github.com/repos/nvaccess/nvda/releases/latest');
        const obj = JSON.parse(json);
        const asset = (obj.assets || []).find(a => /nvda_.*\.exe$/i.test(a.name));
        if (asset && asset.browser_download_url) return asset.browser_download_url;
    } catch (_) {}
    
    try {
        // Fallback to official website
        const pageUrl = 'https://www.nvaccess.org/download/';
        const html = await fetchTextWithRedirects(pageUrl);
        const match = html.match(/href="(https?:[^"']*nvda_[^"']*\.exe)"/i);
        if (match) return match[1];
    } catch (_) {}
    
    // Final fallback
    return 'https://github.com/nvaccess/nvda/releases/latest/download/nvda_2025.3.exe';
}

async function getGithubReleaseAsset(repo, pattern, fallbackUrl) {
    try {
        const json = await fetchTextWithRedirects(`https://api.github.com/repos/${repo}/releases/latest`, 10, GITHUB_API_HEADERS);
        const obj = JSON.parse(json);
        const assets = obj.assets || [];
        const asset = assets.find((a) => pattern.test(a.name) && !/arm64|aarch64/i.test(a.name));
        if (asset && asset.browser_download_url) return asset.browser_download_url;
        const ranked = assets
            .filter((a) => /\.(exe|msi)$/i.test(a.name) && !/arm64|aarch64/i.test(a.name))
            .sort((a, b) => scoreWindowsAsset(b.name) - scoreWindowsAsset(a.name));
        if (ranked[0] && ranked[0].browser_download_url) return ranked[0].browser_download_url;
    } catch (e) {
        console.warn(`GitHub resolver failed for ${repo}: ${e.message}`);
    }
    if (fallbackUrl) return fallbackUrl;
    throw new Error(`No matching asset found for ${repo}`);
}

function scoreWindowsAsset(name) {
    const n = String(name || '').toLowerCase();
    let score = 0;
    if (/x64|win64|amd64|64bit|64-bit/.test(n)) score += 5;
    if (n.endsWith('.exe')) score += 3;
    else if (n.endsWith('.msi')) score += 2;
    if (/setup|install/.test(n)) score += 1;
    if (/arm|aarch64|ia32|x86/.test(n) && !/x64|win64|amd64/.test(n)) score -= 4;
    return score;
}

// Match latest GitHub release asset using the prior serverlist filename as a template
async function autoResolveGithubReleaseUrl(appUrl) {
    const match = appUrl.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/[^/]+\/([^/?#]+)/i);
    if (!match) return null;
    const [, owner, repo, oldFile] = match;
    const json = await fetchTextWithRedirects(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, 10, GITHUB_API_HEADERS);
    const obj = JSON.parse(json);
    const assets = obj.assets || [];
    if (!assets.length) return null;
    const ext = path.extname(oldFile).toLowerCase();
    const stem = oldFile.slice(0, oldFile.length - ext.length);
    const prefix = stem.replace(/[\d.]+/g, '').replace(/-+$/, '');
    const ranked = assets
        .filter((a) => a.name.toLowerCase().endsWith(ext))
        .sort((a, b) => {
            const aScore = (prefix && a.name.startsWith(prefix) ? 10 : 0) + (/x64|win64|amd64/i.test(a.name) ? 4 : 0) - (/arm64|aarch64/i.test(a.name) ? 20 : 0);
            const bScore = (prefix && b.name.startsWith(prefix) ? 10 : 0) + (/x64|win64|amd64/i.test(b.name) ? 4 : 0) - (/arm64|aarch64/i.test(b.name) ? 20 : 0);
            return bScore - aScore;
        });
    const pick = ranked[0] || assets.find((a) => a.name.toLowerCase().endsWith(ext)) || assets[0];
    return pick && pick.browser_download_url ? pick.browser_download_url : null;
}

function extractGithubReleaseTag(url) {
    try {
        const m = String(url).match(/releases\/download\/([^/]+)\//i);
        if (m && m[1] && m[1] !== 'latest') return m[1].replace(/^v/i, '');
    } catch (_) {}
    return null;
}

// Resolve latest OBS Studio via GitHub API (Windows x64 full installer)
async function getLatestObsUrl() {
    return getGithubReleaseAsset(
        'obsproject/obs-studio',
        /OBS-Studio-.*-Windows-x64-Installer\.exe$/i,
        null
    );
}

async function getLatestNotepadPlusPlusUrl() {
    return getGithubReleaseAsset(
        'notepad-plus-plus/notepad-plus-plus',
        /npp\.[\d.]+\.Installer\.x64\.exe$/i,
        null
    );
}

async function getLatestFirefox64Url() {
    const url = 'https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=en-US';
    if (await headProbeOk(url)) return url;
    return url;
}

async function getLatestVlcUrl() {
    // get.videolan.org answers with an HTML mirror-picker page; download.videolan.org serves the EXE
    try {
        const base = 'https://download.videolan.org/pub/videolan/vlc/last/win64/';
        const listing = await fetchTextWithRedirects(base);
        const m = listing.match(/href="(vlc-[\d.]+-win64\.exe)"/i);
        if (m) return base + m[1];
    } catch (_) {}
    try {
        const html = await fetchTextWithRedirects('https://www.videolan.org/vlc/download-windows.html');
        const m = html.match(/href="(https?:\/\/get\.videolan\.org\/vlc\/[\d.]+\/win64\/vlc-[\d.]+-win64\.exe)"/i);
        if (m) return m[1].replace('https://get.videolan.org/vlc/', 'https://download.videolan.org/pub/videolan/vlc/');
    } catch (_) {}
    return 'https://download.videolan.org/pub/videolan/vlc/last/win64/vlc-3.0.24-win64.exe';
}

async function getLatest7zipUrl() {
    try {
        const html = await fetchTextWithRedirects('https://www.7-zip.org/download.html');
        const gh = html.match(/href="(https:\/\/github\.com\/ip7z\/7zip\/releases\/download\/[^"]+\/7z\d+-x64\.exe)"/i);
        if (gh) return gh[1];
        const matches = [...html.matchAll(/href="a\/(7z(\d+)-x64\.exe)"/gi)];
        if (matches.length) {
            matches.sort((a, b) => Number(b[2]) - Number(a[2]));
            return `https://www.7-zip.org/a/${matches[0][1]}`;
        }
    } catch (_) {}
    return 'https://github.com/ip7z/7zip/releases/download/26.01/7z2601-x64.exe';
}

async function getLatestVscodeUrl() {
    const url = 'https://update.code.visualstudio.com/latest/win32-x64-user/stable';
    if (await headProbeOk(url)) return url;
    return url;
}

async function getLatestEdgeUrl() {
    return 'https://go.microsoft.com/fwlink/?linkid=2093437&platform=Win64';
}

async function getLatestTeamsUrl() {
    // New Teams bootstrapper (teamsbootstrapper.exe). The old link served an MSIX that can't run with /S
    return 'https://go.microsoft.com/fwlink/?linkid=2243204';
}

async function getLatestZoomUrl() {
    return 'https://zoom.us/client/latest/ZoomInstallerFull.msi?archType=x64';
}

async function getLatestCcleanerUrl() {
    const url = 'https://download.ccleaner.com/ccsetup.exe';
    if (await headProbeOk(url)) return url;
    return url;
}

async function getLatestWinsockFixUrl() {
    const mirrors = [
        'https://www.majorgeeks.com/mg/getmirror/winsockfix,1.html',
        'https://www.majorgeeks.com/mg/getmirror/winsockfix,2.html',
    ];
    for (const mirror of mirrors) {
        try {
            const html = await fetchTextWithRedirects(mirror);
            const m = html.match(/https:\/\/files\d*\.majorgeeks\.com\/[^"'<\s]+\/internet\/winsockfix\.exe/i);
            if (m && await headProbeOk(m[0])) return m[0];
            if (m) return m[0];
        } catch (_) {}
    }
    return 'https://files1.majorgeeks.com/0b93caee71a9d214d0bbbc5622ea29507e3b8a7a/internet/winsockfix.exe';
}

async function getLatestQbittorrentUrl() {
    try {
        const json = await fetchTextWithRedirects('https://api.github.com/repos/qbittorrent/qBittorrent/releases/latest', 10, GITHUB_API_HEADERS);
        const obj = JSON.parse(json);
        const asset = (obj.assets || []).find((a) => /qbittorrent.*x64.*setup\.exe$/i.test(a.name));
        if (asset) return asset.browser_download_url;
    } catch (_) {}
    return 'https://sourceforge.net/projects/qbittorrent/files/latest/download';
}

async function getLatestDotnet481Url(arch = 'x64') {
    // fwlink 2203303 incorrectly redirects to SSMS; use direct Microsoft URL
    void arch;
    return 'https://download.microsoft.com/download/4/b/2/cd00d4ed-ebdd-49ee-8a33-eabc3d1030e3/NDP481-Web.exe';
}

async function getLatestMalwarebytesUrl() {
    const url = 'https://downloads.malwarebytes.com/file/mb-windows';
    if (await headProbeOk(url)) return url;
    return 'https://data-cdn.mbamupdates.com/web/mb5-setup-consumer/MBSetup.exe';
}

async function getLatestAvgUrl() {
    try {
        const html = await fetchTextWithRedirects('https://www.avg.com/en-us/download-thank-you.php?product=freegsr&variant=1720');
        const m = html.match(/href='(https:\/\/bits\.avcdn\.net\/[^']+)'/i);
        if (m) return m[1];
    } catch (_) {}
    return 'https://bits.avcdn.net/productfamily_ANTIVIRUS/insttype_FREE/platform_WIN_AVG/installertype_ONLINE/build_RELEASE/cookie_mmm_bav_998_999_000_m:dlid_FREEGSR?alt=en-us';
}

async function getLatestAviraUrl() {
    try {
        const page = await fetchTextWithRedirects('https://www.avira.com/en/free-security');
        const token = page.match(/href="(\/en\/start-download\/product\/2262\/[^"]+)"/i);
        if (token) {
            const start = await fetchTextWithRedirects(`https://www.avira.com${token[1]}`);
            const m = start.match(/window\.downloadPath\s*=\s*"([^"]+)"/i);
            if (m) return m[1];
        }
    } catch (_) {}
    return 'https://package.avira.com/download/spotlight-windows-bootstrapper/avira_en_sptl1___pfsws-spotlight-release.exe';
}

async function getLatestSpybotUrl() {
    const base = 'https://updates2.safer-networking.org/spybot1/spybotsd-';
    const fallback = `${base}2.9.85.5.exe`;
    for (let minor = 99; minor >= 85; minor--) {
        for (let patch = 9; patch >= 0; patch--) {
            const ver = `2.9.${minor}.${patch}`;
            const url = `${base}${ver}.exe`;
            if (await headProbeOk(url)) return url;
        }
    }
    return fallback;
}

async function getLatestTdmGccUrl() {
    return getGithubReleaseAsset(
        'jmeubank/tdm-gcc',
        /tdm64-gcc-.*\.exe$/i,
        null
    );
}

async function getLatestTransmissionUrl() {
    return getGithubReleaseAsset(
        'transmission/transmission',
        /transmission-.*-(x64|qt5-x64)\.msi$/i,
        null
    );
}

async function getLatestDelugeUrl() {
    try {
        const html = await fetchTextWithRedirects('http://download.deluge-torrent.org/windows/?C=M&O=D');
        const match = html.match(/deluge-[\d.]+-win64-setup\.exe/);
        if (match) return `http://download.deluge-torrent.org/windows/${match[0]}`;
    } catch (_) {}
    return 'http://download.deluge-torrent.org/windows/deluge-2.2.0-win64-setup.exe';
}

async function getLatestBiglyBtUrl() {
    return getGithubReleaseAsset(
        'BiglySoftware/BiglyBT',
        /GitHub_BiglyBT_Windows_Installer\.exe$/i,
        'https://github.com/BiglySoftware/BiglyBT/releases/download/v4.1.0.0/GitHub_BiglyBT_Windows_Installer.exe'
    );
}

async function getLatestAudacityUrl() {
    return getGithubReleaseAsset(
        'audacity/audacity',
        /audacity-win-.*64bit\.exe$/i,
        'https://github.com/audacity/audacity/releases/download/Audacity-3.7.8/audacity-win-3.7.8-64bit.exe'
    );
}

async function getLatestCccpUrl() {
    return 'https://web.archive.org/web/20210702013306/http://www.cccp-project.net/public/Combined-Community-Codec-Pack-64bit-2015-10-18.exe';
}

async function getLatestHandbrakeUrl() {
    return getGithubReleaseAsset(
        'HandBrake/HandBrake',
        /HandBrake-.*-x86_64-Win_GUI\.exe$/i,
        'https://github.com/HandBrake/HandBrake/releases/download/1.11.2/HandBrake-1.11.2-x86_64-Win_GUI.exe'
    );
}

async function getLatestJanUrl() {
    return getGithubReleaseAsset(
        'janhq/jan',
        /Jan_.*_x64-setup\.exe$/i,
        'https://github.com/janhq/jan/releases/download/v0.8.3/Jan_0.8.3_x64-setup.exe'
    );
}

async function getLatestOllamaUrl() {
    return getGithubReleaseAsset(
        'ollama/ollama',
        /^OllamaSetup\.exe$/i,
        'https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe'
    );
}

async function getLatestClaudeDesktopUrl() {
    return 'https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest-win-x64/Claude-Setup-x64.exe';
}

async function getLatestGpt4AllUrl() {
    const url = 'https://gpt4all.io/installers/gpt4all-installer-win64.exe';
    if (await headProbeOk(url)) return url;
    return url;
}

async function getLatestDotnet9Url(kind, arch) {
    const archSlug = arch === 'x86' ? 'win-x86' : 'win-x64';
    const slug = kind === 'desktop' ? 'windowsdesktop-runtime' : 'dotnet-runtime';
    return `https://aka.ms/dotnet/9.0/${slug}-${archSlug}.exe`;
}

async function getLatestLmStudioUrl() {
    const html = await fetchTextWithRedirects('https://lmstudio.ai/download');
    const versionMatch = html.match(/Download for Windows\s+(0\.\d+\.\d+)/i)
        || html.match(/LM Studio forrunningversion[\s\S]{0,200}?(0\.\d+\.\d+)/i)
        || html.match(/(0\.\d+\.\d+)/);
    if (!versionMatch) throw new Error('No LM Studio version found');
    const baseVersion = versionMatch[1];
    const suffixes = ['-2', '-1', '-4', '-3', ''];
    for (const suffix of suffixes) {
        const version = `${baseVersion}${suffix}`;
        const url = `https://installers.lmstudio.ai/win32/x64/${version}/LM-Studio-${version}-x64.exe`;
        try {
            const response = await new Promise((resolve, reject) => {
                const req = https.request(url, { method: 'HEAD', timeout: 10000, headers: DEFAULT_HEADERS }, (res) => resolve(res));
                req.on('error', (e) => reject(e));
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.end();
            });
            if (response.statusCode >= 200 && response.statusCode < 400) return url;
        } catch (_) {}
    }
    throw new Error(`No LM Studio installer found for version ${baseVersion}`);
}

async function getLatestMediaMonkeyUrl() {
    const html = await fetchTextWithRedirects('https://www.mediamonkey.com/download/');
    const full = html.match(/https?:\/\/[^"']+MediaMonkey[^"']+\.exe/i);
    if (full) return full[0];
    const rel = html.match(/MediaMonkey[^"']+\.exe/i);
    if (rel) return `https://www.mediamonkey.com/${rel[0].replace(/^\//, '')}`;
    throw new Error('No MediaMonkey installer link found');
}

// Resolve latest QEMU Windows installer from Stefan Weil's repository
async function getLatestQemuUrl() {
    try {
        const base = 'https://qemu.weilnetz.de/w64/';
        const html = await fetchTextWithRedirects(base);
        // Match filenames like qemu-w64-setup-20250826.exe
        const re = /href="(qemu-w64-setup-(\d{8})\.exe)"/gi;
        const matches = [];
        let m;
        while ((m = re.exec(html)) !== null) {
            matches.push({ name: m[1], ts: m[2] });
        }
        if (!matches.length) throw new Error('No QEMU installers found');
        matches.sort((a, b) => Number(b.ts) - Number(a.ts));
        return base + matches[0].name;
    } catch (e) {
        throw new Error(`Failed to get latest QEMU URL: ${e.message}`);
    }
}

// Resolve latest QtEmu Windows installer from SourceForge
async function getLatestQtEmuUrl() {
    try {
        // Use the SourceForge latest download endpoint
        return 'https://sourceforge.net/projects/qtemu/files/latest/download';
    } catch (e) {
        throw new Error(`Failed to get latest QtEmu URL: ${e.message}`);
    }
}

// Resolve Brave latest (stable) for Windows x64
async function getLatestBraveUrl() {
    // Known stable endpoint that redirects to current installer
    return 'https://laptop-updates.brave.com/latest/winx64';
}

// Resolve latest DuckDuckGo for Windows
async function getLatestDuckDuckGoUrl() {
    try {
        const pageUrl = 'https://duckduckgo.com/download/windows/desktop/';
        const html = await fetchTextWithRedirects(pageUrl);
        // Look for the download link in the page
        const match = html.match(/href="(https?:[^"']*DuckDuckGo[^"']*\.exe)"/i);
        if (match) return match[1];
        // Fallback to direct download endpoint
        return 'https://duckduckgo.com/download/windows/desktop/';
    } catch (e) {
        throw new Error(`Failed to get latest DuckDuckGo URL: ${e.message}`);
    }
}

// Resolve latest Pidgin Windows x64 installer from SourceForge directory listing
async function getLatestPidginUrl() {
    const base = 'https://sourceforge.net/projects/pidgin/files/Pidgin/';
    const html = await fetchTextWithRedirects(base);
    // Extract version directories like 2.14.13/
    const versions = [...html.matchAll(/href="(\d+\.\d+\.\d+)\//g)].map(m => m[1]);
    if (!versions.length) throw new Error('No Pidgin versions found');
    versions.sort((a,b)=>{
        const pa=a.split('.').map(Number), pb=b.split('.').map(Number);
        for (let i=0;i<Math.max(pa.length,pb.length);i++){const ai=pa[i]||0, bi=pb[i]||0; if (ai!==bi) return bi-ai;}
        return 0;
    });
    for (const v of versions) {
        try {
            const dirHtml = await fetchTextWithRedirects(`${base}${v}/`);
            const m = dirHtml.match(/href="([^"']*pidgin-\d+\.\d+\.\d+-win64\.exe)/i);
            if (m) {
                const url = m[1].startsWith('http') ? m[1] : `https://sourceforge.net${m[1]}`;
                return url;
            }
        } catch (_) {}
    }
    throw new Error('No Pidgin Windows x64 installer link found');
}

// Resolve latest FastStone Image Viewer installer from their page
async function getLatestFastStoneUrl() {
    const pageUrl = 'https://www.faststone.org/FSViewerDownload.htm';
    const html = await fetchTextWithRedirects(pageUrl);
    const m = html.match(/href="(https?:[^"']*FSViewerSetup[^"']*\.exe)"/i);
    if (m) return m[1];
    throw new Error('No FastStone installer link found');
}

// Resolve latest Go (Golang) Windows amd64 MSI from official download page
async function getLatestGoUrl() {
    try {
        const pageUrl = 'https://go.dev/dl/';
        const html = await fetchTextWithRedirects(pageUrl);
        // Look for first Windows amd64 MSI link e.g., go1.22.6.windows-amd64.msi
        const m = html.match(/href="(https?:\/\/go\.dev\/dl\/go[\d\.]+\.windows-amd64\.msi)"/i);
        if (m) return m[1];
        // Fallback: generic CDN path
        const m2 = html.match(/https?:\/\/dl\.google\.com\/go\/go[\d\.]+\.windows-amd64\.msi/i);
        if (m2) return m2[0];
        throw new Error('No Go Windows amd64 MSI link found');
    } catch (e) {
        throw new Error(`Failed to get latest Go URL: ${e.message}`);
    }
}

// Resolve latest Apache OpenOffice Windows installer from SourceForge
async function getLatestOpenOfficeUrl() {
    // openoffice.org/download links to the "openofficeorg.mirror" SourceForge project
    try {
        const html = await fetchTextWithRedirects('https://www.openoffice.org/download/', 10, DEFAULT_HEADERS);
        const vm = [...html.matchAll(/(4\.\d+\.\d+)/g)].map(m => m[1]);
        const ver = vm.sort((a, b) => cmpVer(b, a))[0] || '4.1.16';
        const url = `https://downloads.sourceforge.net/project/openofficeorg.mirror/${ver}/binaries/en-US/Apache_OpenOffice_${ver}_Win_x86_install_en-US.exe`;
        const pr = await probeFinal(url);
        if (pr.ok) return url;
    } catch (_) {}
    try {
        // Use SourceForge latest download endpoint which auto-redirects to newest version
        const sourceforgeUrl = 'https://sourceforge.net/projects/openoffice/files/latest/download';
        
        // Try to get more specific by checking the main files page
        try {
            const filesPage = 'https://sourceforge.net/projects/openoffice/files/';
            const html = await fetchTextWithRedirects(filesPage);
            
            // Look for version numbers in directory listings (e.g., 4.1.15/)
            const versionMatches = [...html.matchAll(/href="\/projects\/openoffice\/files\/(\d+\.\d+\.\d+)\//g)].map(m => m[1]);
            if (versionMatches && versionMatches.length > 0) {
                // Sort versions to get latest
                const sorted = versionMatches.sort((a, b) => {
                    const pa = a.split('.').map(Number);
                    const pb = b.split('.').map(Number);
                    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                        const ai = pa[i] || 0;
                        const bi = pb[i] || 0;
                        if (ai !== bi) return bi - ai;
                    }
                    return 0;
                });
                
                const latestVersion = sorted[0];
                // Try to find Windows installer in the version directory
                try {
                    const versionPage = `https://sourceforge.net/projects/openoffice/files/${latestVersion}/binaries/en-US/`;
                    const versionHtml = await fetchTextWithRedirects(versionPage);
                    const exeMatch = versionHtml.match(/href="([^"]*Apache_OpenOffice_[^"]*_Win_x86_install[^"]*\.exe)"/i);
                    if (exeMatch) {
                        const url = exeMatch[1].startsWith('http') ? exeMatch[1] : `https://sourceforge.net${exeMatch[1]}`;
                        return url;
                    }
                } catch (_) {}
            }
        } catch (_) {}
        
        // Fallback to SourceForge latest endpoint (auto-redirects to newest)
        return sourceforgeUrl;
    } catch (e) {
        throw new Error(`Failed to get latest OpenOffice URL: ${e.message}`);
    }
}

// Oracle script-friendly JDK URLs stay stable across point releases:
// https://download.oracle.com/java/{version}/latest/jdk-{version}_windows-x64_bin.exe
async function getLatestJdkUrl(version, arch = 'x64') {
    const archSuffix = arch === 'x64' ? 'x64' : 'x86';
    const url = `https://download.oracle.com/java/${version}/latest/jdk-${version}_windows-${archSuffix}_bin.exe`;
    if (await headProbeOk(url)) return url;
    return url;
}

function comparePythonVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da !== db) return da - db;
    }
    return 0;
}

// Resolve latest stable Python Windows installer (catalog id is python315*)
async function getLatestPython315Url(arch = 'amd64') {
    const html = await fetchTextWithRedirects('https://www.python.org/ftp/python/');
    const versions = [...html.matchAll(/href="(3\.\d+\.\d+)\/"/g)]
        .map((m) => m[1])
        .filter((v) => !/[abrc]/i.test(v));
    if (!versions.length) throw new Error('No stable Python versions found');
    versions.sort(comparePythonVersions);
    for (let i = versions.length - 1; i >= 0; i--) {
        const version = versions[i];
        const filename = arch === 'amd64' ? `python-${version}-amd64.exe` : `python-${version}.exe`;
        const url = `https://www.python.org/ftp/python/${version}/${filename}`;
        if (await headProbeOk(url)) return url;
    }
    throw new Error('No downloadable stable Python installer found');
}

// Resolve latest LibreOffice Windows x64 installer
async function getLatestLibreOfficeUrl() {
    try {
        const pageUrl = 'https://www.libreoffice.org/download/download/';
        const html = await fetchTextWithRedirects(pageUrl);
        
        // Look for Windows x64 MSI download link
        const match = html.match(/href="(https?:[^"']*LibreOffice[^"']*_Win_x86-64[^"']*\.msi)"/i);
        if (match) return match[1];
        
        // Alternative: try to find version and construct URL
        const versionMatch = html.match(/LibreOffice\s+([\d.]+)/i);
        if (versionMatch) {
            const version = versionMatch[1];
            // LibreOffice typically follows this pattern
            return `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/LibreOffice_${version}_Win_x86-64.msi`;
        }
        
        throw new Error('No LibreOffice Windows x64 installer link found');
    } catch (e) {
        throw new Error(`Failed to get latest LibreOffice URL: ${e.message}`);
    }
}

// Fetch latest Chrome stable version (Windows x64) using Chromium Dash API
async function fetchLatestChromeVersion() {
    const url = 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows';
    const jsonText = await fetchTextWithRedirects(url);
    const parsed = JSON.parse(jsonText);
    // Get the latest stable version
    if (parsed && parsed.length > 0) {
        return parsed[0].version;
    }
    return null;
}

function cmpVer(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
}

async function getLatestFoobar2000Url() {
    const html = await fetchTextWithRedirects('https://www.foobar2000.org/download');
    const m = html.match(/href="(\/downloads\/foobar2000-x64_v[\d.]+\.exe)"/i) || html.match(/href="(\/downloads\/foobar2000_v[\d.]+\.exe)"/i);
    if (!m) throw new Error('No foobar2000 installer link found');
    return 'https://www.foobar2000.org' + m[1];
}

async function getLatestBlenderUrl() {
    const html = await fetchTextWithRedirects('https://www.blender.org/download/');
    const vers = [...html.matchAll(/blender-(\d+\.\d+\.\d+)-windows-x64\.msi/gi)].map(m => m[1]);
    if (!vers.length) throw new Error('No Blender MSI version found');
    const v = vers.sort((a, b) => cmpVer(b, a))[0];
    const mm = v.split('.').slice(0, 2).join('.');
    return `https://download.blender.org/release/Blender${mm}/blender-${v}-windows-x64.msi`;
}

async function getLatestIrfanViewUrl() {
    const html = await fetchTextWithRedirects('https://www.irfanview.com/64bit.htm');
    // the page links the German build (iview476g_...) directly; the English build is the same name without "g"
    const m = html.match(/iview(\d+)g?_x64(?:_setup\.exe|\.zip)/i);
    if (!m) throw new Error('No IrfanView x64 installer found');
    return `https://www.irfanview.info/files/iview${m[1]}_x64_setup.exe`;
}

async function getLatestPaintNetUrl() {
    return await getGithubAssetStrict('paintdotnet/release', /^paint\.net\.[\d.]+\.install\.x64\.zip$/i);
}

async function getLatestFoxitReaderUrl() {
    // Foxit's "latest" redirect points at the _Prom (bundled offers) build; use the plain build next to it
    const pr = await probeFinal('https://www.foxit.com/downloads/latest.html?product=Foxit-Reader&platform=Windows&version=&package_type=exe&language=English');
    if (!pr.ok || !pr.finalUrl) throw new Error('Foxit redirect failed');
    const plain = pr.finalUrl.replace(/_Prom(_x64)?\.exe/i, '$1.exe');
    if (plain !== pr.finalUrl && (await probeFinal(plain)).ok) return plain;
    return pr.finalUrl;
}

async function getLatestNpcapUrl() {
    const html = await fetchTextWithRedirects('https://npcap.com/');
    const vers = [...html.matchAll(/dist\/npcap-(\d+\.\d+)\.exe/gi)].map(m => m[1]);
    if (!vers.length) throw new Error('No Npcap installer link found on npcap.com');
    const v = vers.sort((a, b) => cmpVer(b, a))[0];
    return `https://npcap.com/dist/npcap-${v}.exe`;
}

// ---- Added 2026-10-02 (pass e) ----
async function getLatestSignalUrl() {
    const yml = await fetchTextWithRedirects('https://updates.signal.org/desktop/latest.yml');
    const m = yml.match(/signal-desktop-win-x64-([\d.]+)\.exe/i);
    if (!m) throw new Error('No Signal x64 installer in latest.yml');
    return `https://updates.signal.org/desktop/${m[0]}`;
}

async function getLatestBitwardenUrl() {
    // bitwarden/clients publishes desktop, browser, web and cli releases; pick the newest desktop-v* one
    const json = await fetchTextWithRedirects('https://api.github.com/repos/bitwarden/clients/releases?per_page=40', 10, GITHUB_API_HEADERS);
    const rels = JSON.parse(json).filter((r) => /^desktop-v/i.test(r.tag_name || '') && !r.draft && !r.prerelease);
    for (const r of rels) {
        const a = (r.assets || []).find((x) => /^Bitwarden-Installer-[\d.]+\.exe$/i.test(x.name));
        if (a) return a.browser_download_url;
    }
    throw new Error('No Bitwarden desktop installer found');
}

async function getLatestObsidianUrl() {
    // the newest tag is sometimes published before its Windows asset; take the newest release that has one
    const json = await fetchTextWithRedirects('https://api.github.com/repos/obsidianmd/obsidian-releases/releases?per_page=10', 10, GITHUB_API_HEADERS);
    for (const r of JSON.parse(json)) {
        if (r.draft || r.prerelease) continue;
        const a = (r.assets || []).find((x) => /^Obsidian-[\d.]+\.exe$/i.test(x.name));
        if (a) return a.browser_download_url;
    }
    throw new Error('No Obsidian Windows installer found');
}

async function getLatestHwinfoUrl() {
    const html = await fetchTextWithRedirects('https://www.hwinfo.com/download/');
    const vers = [...html.matchAll(/files\/hwi64_(\d+)\.exe/gi)].map((m) => Number(m[1]));
    if (!vers.length) throw new Error('No HWiNFO64 installer link found');
    return `https://www.hwinfo.com/files/hwi64_${Math.max(...vers)}.exe`;
}

async function getLatestCrystalDiskInfoUrl() {
    // crystalmark.info's "latest installer" redirect points at the SourceForge file (via an ad page)
    const res = await requestHeaders('https://crystalmark.info/redirect.php?product=CrystalDiskInfoInstaller', 'GET');
    const loc = String(res.headers.location || '');
    const m = decodeURIComponent(loc).match(/sourceforge\.net\/projects\/crystaldiskinfo\/files\/([^/]+)\/(CrystalDiskInfo[\w.]+\.exe)/i);
    if (!m) throw new Error(`Unexpected CrystalDiskInfo redirect: ${loc}`);
    return `https://downloads.sourceforge.net/project/crystaldiskinfo/${m[1]}/${m[2]}`;
}

async function readStoredVersion(appId) {
    try {
        await fs.promises.mkdir(versionsDir, { recursive: true });
        const file = path.join(versionsDir, `${appId}.txt`);
        return (await fs.promises.readFile(file, 'utf8')).trim();
    } catch (_) {
        return null;
    }
}

async function writeStoredVersion(appId, version) {
    try {
        await fs.promises.mkdir(versionsDir, { recursive: true });
        const file = path.join(versionsDir, `${appId}.txt`);
        await fs.promises.writeFile(file, String(version || ''), 'utf8');
    } catch (_) {}
}

// Best-effort version extraction from URL/filename
function extractVersionFromUrl(urlOrName) {
    try {
        const s = String(urlOrName || '');
        // Prefer dotted semantic versions like 3.0.4 or 24.04.1
        const m1 = s.match(/(?:[^\d]|^)(\d+\.\d+(?:\.\d+){0,2})(?:[^\d]|$)/);
        if (m1 && m1[1]) return m1[1];
        // Fallback: continuous digits with underscore separators (e.g., 591_9313)
        const m2 = s.match(/(\d{2,}(?:[_\-]\d{2,})+)/);
        if (m2 && m2[1]) return m2[1];
    } catch (_) {}
    return null;
}

// Extract SpaceMonger.exe from the spcmn140.zip archive (Sixty-Five freeware v1.4).
async function extractSpaceMongerInstaller(zipPath, installersBaseDir) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const exeName = 'SpaceMonger.exe';
    const exePath = path.join(installersBaseDir, exeName);
    const installerLink = path.join(installersBaseDir, 'spacemonger_installer.exe');
    const clientLink = path.join(installersBaseDir, 'spacemonger.exe');

    await execFileAsync('unzip', ['-o', '-j', zipPath, exeName, '-d', installersBaseDir], { timeout: 60000 });
    await fs.promises.unlink(installerLink).catch(() => {});
    await fs.promises.symlink(exeName, installerLink);
    await fs.promises.unlink(clientLink).catch(() => {});
    await fs.promises.symlink('spacemonger_installer.exe', clientLink);
    return exePath;
}

// Normalize legacy/mismatched app IDs to those used in the UI/app catalog
function normalizeAppId(appId) {
    if (appId === 'opera') return 'opera64';
    return appId;
}

// Remove older vendor installer files for the same app/version pattern, keeping the current file
async function cleanupOldVendorFiles(dirPath, currentVendorFilename, keepCount = 1) {
    try {
        const currentBase = path.basename(currentVendorFilename);
        if (isProtectedIsoName(currentBase)) return; // ISOs are never cleaned up
        const ext = path.extname(currentBase);
        const name = currentBase.slice(0, -ext.length);
        const firstDigitIdx = name.search(/\d/);
        if (firstDigitIdx === -1) return; // not a versioned filename; skip
        const prefix = name.slice(0, firstDigitIdx);
        // suffix is the non-digit tail after the last digit in the name
        let suffix = '';
        {
            const m = name.match(/\d[^]*?(\D*)$/);
            suffix = (m && m[1]) ? m[1] : '';
        }
        if (!prefix) return; // safety: avoid broad matches
        const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp('^' + escapeRe(prefix) + '\\d[\\d._-]*' + escapeRe(suffix) + escapeRe(ext) + '$', 'i');

        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        // Collect symlink targets to avoid deleting files still referenced
        const symlinkTargets = new Set();
        await Promise.all(entries.map(async (ent) => {
            try {
                if (ent.isSymbolicLink && typeof ent.isSymbolicLink === 'function' ? ent.isSymbolicLink() : ent.isSymbolicLink) {
                    const target = await fs.promises.readlink(path.join(dirPath, ent.name)).catch(() => null);
                    if (target) symlinkTargets.add(path.basename(target));
                }
            } catch (_) {}
        }));

        // Find candidate files matching the same vendor pattern
        const candidates = [];
        for (const ent of entries) {
            try {
                if (!ent.isFile || (typeof ent.isFile === 'function' && !ent.isFile())) continue;
            } catch (_) {
                // Fallback: if Dirent API differs, check by stat
                try { const st = await fs.promises.stat(path.join(dirPath, ent.name)); if (!st.isFile()) continue; } catch { continue; }
            }
            if (!ent.name.toLowerCase().endsWith(ext.toLowerCase())) continue;
            if (!rx.test(ent.name)) continue;
            if (ent.name === currentBase) continue;
            if (symlinkTargets.has(ent.name)) continue;
            if (isProtectedIsoName(ent.name)) continue;
            const full = path.join(dirPath, ent.name);
            if (await isProtectedIsoPath(full)) continue;
            let mtime = 0;
            try { const st = await fs.promises.stat(full); mtime = st.mtimeMs || 0; } catch (_) {}
            candidates.push({ name: ent.name, full, mtime });
        }
        if (!candidates.length) return;
        candidates.sort((a, b) => b.mtime - a.mtime);
        // Keep the most recent (keepCount - 1) besides the current file
        const toDelete = candidates.slice(Math.max(0, (keepCount - 1)));
        let deletedCount = 0;
        await Promise.all(toDelete.map(async (c) => {
            try { 
                await fs.promises.unlink(c.full); 
                deletedCount++;
                console.log(`Deleted old file: ${c.name}`);
            } catch (err) {
                console.warn(`Failed to delete ${c.name}: ${err.message}`);
            }
        }));
        if (deletedCount > 0) {
            console.log(`Cleaned up ${deletedCount} old file(s) for pattern ${prefix}*${suffix}${ext}`);
        }
    } catch (err) {
        console.warn(`Cleanup error for ${currentVendorFilename}: ${err.message}`);
    }
}

// Cleanup old Python version files (e.g., python-3.14.0-amd64.exe when python-3.15.0-amd64.exe exists)
async function cleanupOldPythonVersions(dirPath, currentPythonFilename) {
    try {
        const currentBase = path.basename(currentPythonFilename);
        // Match pattern: python-3.X.Y-amd64.exe or python-3.X.Y.exe
        const versionMatch = currentBase.match(/python-3\.(\d+)\.\d+(-amd64)?\.exe$/i);
        if (!versionMatch) return; // Not a Python versioned file
        
        const currentMajorMinor = versionMatch[1]; // e.g., "15" from "3.15.0"
        const isAmd64 = versionMatch[2] !== undefined;
        const archSuffix = isAmd64 ? '-amd64' : '';
        
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const toDelete = [];
        
        for (const ent of entries) {
            try {
                if (!ent.isFile || (typeof ent.isFile === 'function' && !ent.isFile())) continue;
            } catch (_) {
                try { const st = await fs.promises.stat(path.join(dirPath, ent.name)); if (!st.isFile()) continue; } catch { continue; }
            }
            
            // Match old Python version files (e.g., python-3.14.0-amd64.exe, python-3.13.0.exe)
            const oldMatch = ent.name.match(/^python-3\.(\d+)\.\d+(-amd64)?\.exe$/i);
            if (!oldMatch) continue;
            
            const oldMajorMinor = oldMatch[1];
            const oldIsAmd64 = oldMatch[2] !== undefined;
            
            // Only delete if same architecture and older version
            if (oldIsAmd64 === isAmd64 && parseInt(oldMajorMinor) < parseInt(currentMajorMinor)) {
                // Keep the 2 most recent versions (current + 1 previous)
                if (parseInt(currentMajorMinor) - parseInt(oldMajorMinor) > 1) {
                    const full = path.join(dirPath, ent.name);
                    toDelete.push(full);
                }
            }
        }
        
        // Delete old Python version files
        let deletedCount = 0;
        for (const filePath of toDelete) {
            try {
                await fs.promises.unlink(filePath);
                deletedCount++;
                console.log(`Deleted old Python version file: ${path.basename(filePath)}`);
            } catch (err) {
                console.warn(`Failed to delete ${path.basename(filePath)}: ${err.message}`);
            }
        }
        
        if (deletedCount > 0) {
            console.log(`Cleaned up ${deletedCount} old Python version file(s), keeping latest versions`);
        }
    } catch (err) {
        console.warn(`Python version cleanup error: ${err.message}`);
    }
}

// Cleanup old JDK version files (e.g., jdk-23_windows-x64_bin.exe when jdk-24_windows-x64_bin.exe exists)
async function cleanupOldJdkVersions(dirPath, currentJdkFilename) {
    try {
        const currentBase = path.basename(currentJdkFilename);
        // Match pattern: jdk-X_windows-x64_bin.exe or jdk-X_windows-x86_bin.exe
        const versionMatch = currentBase.match(/jdk-(\d+)_windows-(x64|x86)_bin\.exe$/i);
        if (!versionMatch) return; // Not a JDK versioned file
        
        const currentVersion = parseInt(versionMatch[1]); // e.g., 24 from "jdk-24_windows-x64_bin.exe"
        const arch = versionMatch[2]; // "x64" or "x86"
        
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const toDelete = [];
        
        for (const ent of entries) {
            try {
                if (!ent.isFile || (typeof ent.isFile === 'function' && !ent.isFile())) continue;
            } catch (_) {
                try { const st = await fs.promises.stat(path.join(dirPath, ent.name)); if (!st.isFile()) continue; } catch { continue; }
            }
            
            // Match old JDK version files (e.g., jdk-23_windows-x64_bin.exe, jdk-22_windows-x86_bin.exe)
            const oldMatch = ent.name.match(/^jdk-(\d+)_windows-(x64|x86)_bin\.exe$/i);
            if (!oldMatch) continue;
            
            const oldVersion = parseInt(oldMatch[1]);
            const oldArch = oldMatch[2];
            
            // Only delete if same architecture and older version
            if (oldArch.toLowerCase() === arch.toLowerCase() && oldVersion < currentVersion) {
                // Keep the 2 most recent versions (current + 1 previous)
                if (currentVersion - oldVersion > 1) {
                    const full = path.join(dirPath, ent.name);
                    toDelete.push(full);
                }
            }
        }
        
        // Delete old JDK version files
        let deletedCount = 0;
        for (const filePath of toDelete) {
            try {
                await fs.promises.unlink(filePath);
                deletedCount++;
                console.log(`Deleted old JDK version file: ${path.basename(filePath)}`);
            } catch (err) {
                console.warn(`Failed to delete ${path.basename(filePath)}: ${err.message}`);
            }
        }
        
        if (deletedCount > 0) {
            console.log(`Cleaned up ${deletedCount} old JDK version file(s), keeping latest versions`);
        }
    } catch (err) {
        console.warn(`JDK version cleanup error: ${err.message}`);
    }
}

// Cleanup old installer symlinks and files for a specific app
async function cleanupOldInstallerFiles(dirPath, appId, currentInstallerFilename) {
    if (PROTECTED_ISO_APP_IDS.has(appId)) return; // ISOs are never cleaned up
    try {
        const currentBase = path.basename(currentInstallerFilename);
        
        // Special handling for Python versions
        if (appId.startsWith('python3')) {
            await cleanupOldPythonVersions(dirPath, currentInstallerFilename);
        }
        
        // Special handling for JDK versions
        if (appId.startsWith('jdk')) {
            await cleanupOldJdkVersions(dirPath, currentInstallerFilename);
        }
        
        // Never delete canonical installer names or known download aliases
        const protectedNames = new Set([currentBase, getInstallerFileName(appId)]);
        try {
            const candidates = getInstallerCandidates(appId);
            (candidates.x64 || []).forEach((n) => protectedNames.add(n));
        } catch (_) {}

        // For apps like winrar, also clean up old _installer.exe files
        // This handles cases where old installer files exist with different naming
        const oldPatterns = [
            `${appId}_installer.exe`,
            `${appId}-installer.exe`,
            `${appId}installer.exe`
        ];
        
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const toDelete = [];
        
        // Collect symlink targets to avoid deleting files still referenced
        const symlinkTargets = new Set();
        await Promise.all(entries.map(async (ent) => {
            try {
                if (ent.isSymbolicLink && typeof ent.isSymbolicLink === 'function' ? ent.isSymbolicLink() : ent.isSymbolicLink) {
                    const target = await fs.promises.readlink(path.join(dirPath, ent.name)).catch(() => null);
                    if (target) symlinkTargets.add(path.basename(target));
                }
            } catch (_) {}
        }));
        
        for (const ent of entries) {
            try {
                // Skip if it's the current file or symlink target
                if (ent.name === currentBase) continue;
                if (protectedNames.has(ent.name)) continue;
                if (symlinkTargets.has(ent.name)) continue;

                // Never delete intentional installer symlinks/aliases
                let isSymlink = false;
                try {
                    const fullPath = path.join(dirPath, ent.name);
                    const lst = await fs.promises.lstat(fullPath);
                    isSymlink = lst.isSymbolicLink();
                } catch (_) {}
                if (isSymlink) continue;
                
                // Check if it matches old installer patterns
                const matchesOldPattern = oldPatterns.some(pattern => {
                    return ent.name.toLowerCase() === pattern.toLowerCase();
                });
                
                // Also check for old versioned files with appId in name (but not the current vendor file)
                const hasAppId = ent.name.toLowerCase().includes(appId.toLowerCase());
                const isExe = ent.name.toLowerCase().endsWith('.exe');
                
                // Only delete if it's an old installer pattern or old app-specific exe
                // But skip vendor files (those are handled by cleanupOldVendorFiles)
                const isVendorFile = ent.name.match(/^[a-z]+-x?\d+[a-z]?-\d+[a-z]?\.exe$/i);
                
                if ((matchesOldPattern || (hasAppId && isExe && !isVendorFile)) && ent.name !== currentBase) {
                    // Check if it's a file (not symlink)
                    let isFile = false;
                    try {
                        if (ent.isFile && (typeof ent.isFile === 'function' ? ent.isFile() : ent.isFile)) {
                            isFile = true;
                        } else {
                            const st = await fs.promises.stat(path.join(dirPath, ent.name));
                            isFile = st.isFile();
                        }
                    } catch (_) {}
                    
                    if (isFile) {
                        const full = path.join(dirPath, ent.name);
                        toDelete.push(full);
                    }
                }
            } catch (_) {}
        }
        
        // Delete old installer files
        let deletedCount = 0;
        for (const filePath of toDelete) {
            try {
                if (await isProtectedIsoPath(filePath)) { console.warn(`Refusing to delete ISO ${path.basename(filePath)}`); continue; }
                await fs.promises.unlink(filePath);
                deletedCount++;
                console.log(`Deleted old installer file: ${path.basename(filePath)}`);
            } catch (err) {
                console.warn(`Failed to delete ${path.basename(filePath)}: ${err.message}`);
            }
        }
        
        if (deletedCount > 0) {
            console.log(`Cleaned up ${deletedCount} old installer file(s) for ${appId}`);
        }
    } catch (err) {
        console.warn(`Installer cleanup error for ${appId}: ${err.message}`);
    }
}

async function checkUpdates(progressLogger) {
    // Prevent overlapping runs
    const gotLock = await acquireRunLock();
    if (!gotLock) {
        console.log('Another update-check run is in progress; skipping.');
        return;
    }
    let restore = null;
    try {
        // If a logger provided, temporarily tee console to it
        if (typeof progressLogger === 'function') {
            const origLog = console.log;
            const origErr = console.error;
            console.log = (...args) => { try { progressLogger(args.join(' ')); } catch(_) {} try { origLog(...args); } catch(_) {} };
            console.error = (...args) => { try { progressLogger(args.join(' ')); } catch(_) {} try { origErr(...args); } catch(_) {} };
            restore = () => { console.log = origLog; console.error = origErr; };
        }
        await fs.promises.mkdir(installersBaseDir, { recursive: true }); // Ensure installer directory exists
        // Ensure public directory exists for latest updates
        const publicDir = path.join(__dirname, 'public');
        await fs.promises.mkdir(publicDir, { recursive: true });
        const data = await fs.promises.readFile(serverListPath, 'utf8');
        const lines = data.trim().split('\n');
        const updatedLines = [];
        let changesMade = false;
        const updatedAppsThisRun = [];
        const updatedSet = new Set();
        const processedIds = new Set();
        const results = new Map();
        const onlyIds = process.env.STACKDROP_UC_ONLY ? new Set(process.env.STACKDROP_UC_ONLY.split(',').map((x) => x.trim()).filter(Boolean)) : null;
        const skippedByFilter = new Set();
        const recordResult = (id, status, reason = '', extra = {}) => { results.set(id, { appId: id, status, reason, ...extra }); };

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (line.startsWith('//') || line.trim() === '') { updatedLines.push(line); continue; }

            const firstColonIndex = line.indexOf(':');
            if (firstColonIndex === -1) { updatedLines.push(line); continue; }
            let appId; let urlStart;
            const firstToken = line.substring(0, firstColonIndex);
            if (/^\d+$/.test(firstToken)) {
                const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
                if (secondColonIndex === -1) { updatedLines.push(line); continue; }
                appId = line.substring(firstColonIndex + 1, secondColonIndex);
                urlStart = secondColonIndex + 1;
            } else {
                appId = firstToken;
                urlStart = firstColonIndex + 1;
            }

            // Collect all lines for this appId (primary + backups)
            if (processedIds.has(appId)) { continue; }
            const appLines = [line];
            for (let j = i + 1; j < lines.length; j += 1) {
                const l2 = lines[j];
                if (l2.startsWith('//') || l2.trim() === '') continue;
                const fc2 = l2.indexOf(':'); if (fc2 === -1) continue;
                const ft2 = l2.substring(0, fc2);
                let aid2;
                if (/^\d+$/.test(ft2)) {
                    const sc2 = l2.indexOf(':', fc2 + 1); if (sc2 === -1) continue;
                    aid2 = l2.substring(fc2 + 1, sc2);
                } else { aid2 = ft2; }
                if (aid2 === appId) appLines.push(l2);
            }

            // Helper to extract URL and metadata from a line
            const parseUrl = (l) => {
                const fc = l.indexOf(':');
                let us = fc + 1;
                const ft = l.substring(0, fc);
                if (/^\d+$/.test(ft)) { const sc = l.indexOf(':', fc + 1); us = sc + 1; }
                const p = l.indexOf('://', us); if (p === -1) return { url: null, etag: 'N/A', lm: 'N/A' };
                const ue = l.indexOf(':', p + 3);
                const url = ue === -1 ? l.substring(us) : l.substring(us, ue);
                const rest = ue === -1 ? '' : l.substring(ue + 1);
                const parts = rest.split(':');
                return { url, etag: parts[0] || 'N/A', lm: parts.length > 1 ? parts.slice(1).join(':') : 'N/A' };
            };

            // Optional: STACKDROP_UC_ONLY=id1,id2 limits a manual run to those apps (others kept as-is)
            if (onlyIds && !onlyIds.has(appId)) {
                for (const l of appLines) updatedLines.push(l);
                processedIds.add(appId); skippedByFilter.add(appId);
                continue;
            }
            const candidates = appLines.map(parseUrl).filter(x => x.url && (x.url.startsWith('http://') || x.url.startsWith('https://')));
            if (candidates.length === 0) { updatedLines.push(line); processedIds.add(appId); recordResult(appId, 'flagged', 'no vendor URL in serverlist'); continue; }
            if (SKIP_DOWNLOAD_APP_IDS.has(appId)) {
                for (const l of appLines) updatedLines.push(l);
                processedIds.add(appId);
                recordResult(appId, 'skipped', PROTECTED_ISO_APP_IDS.has(appId)
                    ? 'protected server-hosted ISO: never downloaded/validated/replaced/deleted'
                    : 'not downloaded by the checker (local file)');
                continue;
            }

            // Determine installer paths
            const installerFilenamePre = getInstallerFileName(appId);
            const installerPathPre = path.join(installersBaseDir, installerFilenamePre);
            let installerExistsPre = false; try { await fs.promises.access(installerPathPre); installerExistsPre = true; } catch {}
            let preValidation = null;
            if (installerExistsPre) {
                preValidation = await validateInstallerFile(installerPathPre, appId, installerFilenamePre);
                if (!preValidation.ok) {
                    console.warn(`Stored installer for ${appId} is invalid (${preValidation.reason}); forcing re-download`);
                    installerExistsPre = false;
                }
            }

            let outputEtag = candidates[0].etag; let outputLastModified = candidates[0].lm;
            let latestVersionForApp = null; let storedVersionForApp = null;
            const installerFilename = installerFilenamePre; // Define early for use in catch block
            console.log(`Checking ${appId}...`);
            
            // Add delay for apps known to have rate limiting issues
            if (appId === 'anydesk') {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            // Dynamic resolvers (may override first candidate)
            let appUrl = candidates[0].url;
            if (appId === 'opera' || appId === 'opera64') { try { appUrl = await getLatestOperaUrl(); } catch(_) {} }
            else if (appId === 'tor') { try { appUrl = await getLatestTorUrl(); } catch(_) {} }
            else if (appId === 'foobar2000') { try { appUrl = await getLatestFoobar2000Url(); } catch(_) {} }
            else if (appId === 'blender') { try { appUrl = await getLatestBlenderUrl(); } catch(_) {} }
            else if (appId === 'irfanview') { try { appUrl = await getLatestIrfanViewUrl(); } catch(_) {} }
            else if (appId === 'paintnet') { try { appUrl = await getLatestPaintNetUrl(); } catch(_) {} }
            else if (appId === 'foxitreader') { try { appUrl = await getLatestFoxitReaderUrl(); } catch(_) {} }
            else if (appId === 'npcap') { try { appUrl = await getLatestNpcapUrl(); } catch(_) {} }
            else if (appId === 'signal') { try { appUrl = await getLatestSignalUrl(); } catch(_) {} }
            else if (appId === 'telegram') { appUrl = 'https://telegram.org/dl/desktop/win64'; }
            else if (appId === 'bitwarden') { try { appUrl = await getLatestBitwardenUrl(); } catch(_) {} }
            else if (appId === 'mpchc') { try { appUrl = await getGithubAssetStrict('clsid2/mpc-hc', /^MPC-HC\.[\d.]+\.x64\.exe$/i); } catch(_) {} }
            else if (appId === 'potplayer') { appUrl = 'https://t1.daumcdn.net/potplayer/PotPlayer/Version/Latest/PotPlayerSetup64.exe'; }
            else if (appId === 'obsidian') { try { appUrl = await getLatestObsidianUrl(); } catch(_) {} }
            else if (appId === 'joplin') { try { appUrl = await getGithubAssetStrict('laurent22/joplin', /^Joplin-Setup-[\d.]+\.exe$/i); } catch(_) {} }
            else if (appId === 'calibre') { appUrl = 'https://calibre-ebook.com/dist/win64'; }
            else if (appId === 'crystaldiskinfo') { try { appUrl = await getLatestCrystalDiskInfoUrl(); } catch(_) {} }
            else if (appId === 'notepad3') { try { appUrl = await getGithubAssetStrict('rizonesoft/Notepad3', /^Notepad3_[\d.]+_x64_Setup\.exe$/i); } catch(_) {} }
            else if (appId === 'winamp') { try { appUrl = await getLatestWinampUrl(); } catch(_) {} }
            else if (appId === 'musicbee') { try { appUrl = await getLatestMusicBeeUrl(); } catch(_) {} }
            else if (appId === 'gom') { try { appUrl = await getLatestGomUrl(); } catch(_) {} }
            else if (appId === 'spotify') { try { appUrl = await getLatestSpotifyUrl(); } catch(_) {} }
            else if (appId === 'thunderbird') { try { appUrl = await getLatestThunderbirdUrl(); } catch(_) {} }
            else if (appId === 'emclient') { try { appUrl = await getLatestEmClientUrl(); } catch(_) {} }
            else if (appId === 'rufus') { try { appUrl = await getLatestRufusUrl(); } catch(_) {} }
            else if (appId === 'klitecodecs') { try { appUrl = await getLatestKLiteCodecUrl(); } catch(_) {} }
            else if (appId === 'cursor') { try { appUrl = await getLatestCursorUrl(); } catch(_) {} }
            else if (appId === 'androidstudio') { try { appUrl = await getLatestAndroidStudioUrl(); } catch(_) {} }
            else if (appId === 'discord') { try { appUrl = await getLatestDiscordUrl(); } catch(_) {} }
            else if (appId === 'everything') { try { appUrl = await getLatestEverythingUrl(); } catch(_) {} }
            else if (appId === 'windirstat') { try { appUrl = await getLatestWinDirStatUrl(); } catch(_) {} }
            else if (appId === 'nvaccess') { try { appUrl = await getLatestNvdaUrl(); } catch(_) {} }
            else if (appId === 'brave') { try { appUrl = await getLatestBraveUrl(); } catch(_) {} }
            else if (appId === 'duckduckgo') {
                // DuckDuckGo no longer has a Windows desktop app - mark as removed
                console.log('DuckDuckGo Windows app no longer available, skipping');
                updatedLines.push(line.replace(/:.*/, ':REMOVED:No longer available for Windows desktop:N/A'));
                processedIds.add(appId);
                continue;
            }
            else if (appId === 'pidgin') { try { appUrl = await getLatestPidginUrl(); } catch(_) {} }
            else if (appId === 'faststone') { try { appUrl = await getLatestFastStoneUrl(); } catch(_) {} }
            else if (appId === 'golang') { try { appUrl = await getLatestGoUrl(); } catch(_) {} }
            else if (appId === 'qemu') { try { appUrl = await getLatestQemuUrl(); } catch(_) {} }
            else if (appId === 'obs') { try { appUrl = await getLatestObsUrl(); } catch(_) {} }
            else if (appId === 'transmission') { try { appUrl = await getLatestTransmissionUrl(); } catch(_) {} }
            else if (appId === 'deluge') { try { appUrl = await getLatestDelugeUrl(); } catch(_) {} }
            else if (appId === 'biglybt') { try { appUrl = await getLatestBiglyBtUrl(); } catch(_) {} }
            else if (appId === 'audacity') { try { appUrl = await getLatestAudacityUrl(); } catch(_) {} }
            else if (appId === 'cccp') { try { appUrl = await getLatestCccpUrl(); } catch(_) {} }
            else if (appId === 'handbrake') { try { appUrl = await getLatestHandbrakeUrl(); } catch(_) {} }
            else if (appId === 'jan') { try { appUrl = await getLatestJanUrl(); } catch(_) {} }
            else if (appId === 'lmstudio') { try { appUrl = await getLatestLmStudioUrl(); } catch(_) {} }
            else if (appId === 'ollama') { try { appUrl = await getLatestOllamaUrl(); } catch(_) {} }
            else if (appId === 'claudedesktop') { try { appUrl = await getLatestClaudeDesktopUrl(); } catch(_) {} }
            else if (appId === 'gpt4all') { try { appUrl = await getLatestGpt4AllUrl(); } catch(_) {} }
            else if (appId === 'mediamonkey') { try { appUrl = await getLatestMediaMonkeyUrl(); } catch(_) {} }
            else if (appId === 'dotnet9') { try { appUrl = await getLatestDotnet9Url('runtime', 'x64'); } catch(_) {} }
            else if (appId === 'dotnet9x86') { try { appUrl = await getLatestDotnet9Url('runtime', 'x86'); } catch(_) {} }
            else if (appId === 'dotnet9desktop') { try { appUrl = await getLatestDotnet9Url('desktop', 'x64'); } catch(_) {} }
            else if (appId === 'dotnet9desktopx86') { try { appUrl = await getLatestDotnet9Url('desktop', 'x86'); } catch(_) {} }
            else if (appId === 'greenshot') { try { appUrl = await getLatestGreenshotUrl(); } catch(_) {} }
            else if (appId === 'sharex') { try { appUrl = await getLatestShareXUrl(); } catch(_) {} }
            else if (appId === 'inkscape') { try { appUrl = await getLatestInkscapeUrl(); } catch(_) {} }
            else if (appId === 'bluestacks') { try { appUrl = await getLatestBlueStacksUrl(); } catch(_) {} }
            else if (appId === 'winrar') { try { appUrl = await getLatestWinrarUrl(); } catch(_) {} }
            else if (appId === 'gimp') { try { appUrl = await getLatestGimpUrl(); } catch(_) {} }
            else if (appId === 'sumatrapdf') { try { appUrl = await getLatestSumatraUrl(); } catch(_) {} }
            else if (appId === 'cutepdf') { try { appUrl = await getLatestCutePdfUrl(); } catch(_) {} }
            else if (appId === 'trillian') { try { appUrl = await getLatestTrillianUrl(); } catch(_) {} }
            else if (appId === 'vivaldi') { try { appUrl = await getLatestVivaldiUrl(); } catch(_) {} }
            else if (appId === 'keepass2') { try { appUrl = await getLatestKeePassUrl(); } catch(_) {} }
            else if (appId === 'winscp') { try { appUrl = await getLatestWinScpUrl(); } catch(_) {} }
            else if (appId === 'wiztree') { try { appUrl = await getLatestWizTreeUrl(); } catch(_) {} }
            else if (appId === 'putty') { try { appUrl = await getLatestPuttyUrl(); } catch(_) {} }
            else if (appId === 'powertoys') { try { appUrl = await getGithubAssetStrict('microsoft/PowerToys', /^PowerToysSetup-[\d.]+-x64\.exe$/i); } catch(_) {} }
            else if (appId === 'winmerge') { try { appUrl = await getGithubAssetStrict('WinMerge/winmerge', /^WinMerge-[\d.]+-x64-Setup\.exe$/i); } catch(_) {} }
            else if (appId === 'gitscm') { try { appUrl = await getGithubAssetStrict('git-for-windows/git', /^Git-[\d.]+-64-bit\.exe$/i); } catch(_) {} }
            else if (appId === 'openshell') { try { appUrl = await getGithubAssetStrict('Open-Shell/Open-Shell-Menu', /^OpenShellSetup_[\d_]+\.exe$/i); } catch(_) {} }
            else if (appId === 'bambustudio') { try { appUrl = await getGithubAssetStrict('bambulab/BambuStudio', /^Bambu_Studio_win.*\.exe$/i); } catch(_) {} }
            else if (appId === 'ultimakercura') { try { appUrl = await getGithubAssetStrict('Ultimaker/Cura', /^UltiMaker-Cura-[\d.]+-win64-X64\.msi$/i); } catch(_) {} }
            else if (appId === 'peazip') { try { appUrl = await getLatestPeaZipUrl(); } catch(_) {} }
            else if (appId === 'openoffice') { try { appUrl = await getLatestOpenOfficeUrl(); } catch(_) {} }
            else if (appId === 'libreoffice') { try { appUrl = await getLatestLibreOfficeUrl(); } catch(_) {} }
            else if (appId === 'python315x64') { try { appUrl = await getLatestPython315Url('amd64'); } catch(_) {} }
            else if (appId === 'python315x86') { try { appUrl = await getLatestPython315Url('x86'); } catch(_) {} }
            else if (appId === 'jdk26x64') { try { appUrl = await getLatestJdkUrl(26, 'x64'); } catch(_) {} }
            else if (appId === 'jdk21x64') { try { appUrl = await getLatestJdkUrl(21, 'x64'); } catch(_) {} }
            else if (appId === 'epicgames') { try { appUrl = await getLatestEpicGamesUrl(); } catch(_) {} }
            else if (appId === 'googleearth') { try { appUrl = await getLatestGoogleEarthUrl(); } catch(_) {} }
            else if (appId === 'qtemu') { try { appUrl = await getLatestQtEmuUrl(); } catch(_) {} }
            else if (appId === 'notepadplusplus') { try { appUrl = await getLatestNotepadPlusPlusUrl(); } catch(_) {} }
            else if (appId === 'firefox64') { try { appUrl = await getLatestFirefox64Url(); } catch(_) {} }
            else if (appId === 'vlc') { try { appUrl = await getLatestVlcUrl(); } catch(_) {} }
            else if (appId === '7zip') { try { appUrl = await getLatest7zipUrl(); } catch(_) {} }
            else if (appId === 'vscode') { try { appUrl = await getLatestVscodeUrl(); } catch(_) {} }
            else if (appId === 'edge') { try { appUrl = await getLatestEdgeUrl(); } catch(_) {} }
            else if (appId === 'teams') { try { appUrl = await getLatestTeamsUrl(); } catch(_) {} }
            else if (appId === 'zoom') { try { appUrl = await getLatestZoomUrl(); } catch(_) {} }
            else if (appId === 'ccleaner') { try { appUrl = await getLatestCcleanerUrl(); } catch(_) {} }
            else if (appId === 'winsockfix') { try { appUrl = await getLatestWinsockFixUrl(); } catch(_) {} }
            else if (appId === 'qbittorrent') { try { appUrl = await getLatestQbittorrentUrl(); } catch(_) {} }
            else if (appId === 'dotnet481') { try { appUrl = await getLatestDotnet481Url('x64'); } catch(_) {} }
            else if (appId === 'dotnet481x86') { try { appUrl = await getLatestDotnet481Url('x86'); } catch(_) {} }
            else if (appId === 'tdmgcc') { try { appUrl = await getLatestTdmGccUrl(); } catch(_) {} }
            else if (appId === 'malwarebytes') { try { appUrl = await getLatestMalwarebytesUrl(); } catch(_) {} }
            else if (appId === 'avg') { try { appUrl = await getLatestAvgUrl(); } catch(_) {} }
            else if (appId === 'avira') { try { appUrl = await getLatestAviraUrl(); } catch(_) {} }
            else if (appId === 'spybot2') { try { appUrl = await getLatestSpybotUrl(); } catch(_) {} }
            else if (/github\.com\/[^/]+\/[^/]+\/releases/.test(appUrl)) {
                try {
                    const auto = await autoResolveGithubReleaseUrl(appUrl);
                    if (auto) appUrl = auto;
                } catch (e) {
                    console.warn(`GitHub auto-resolve failed for ${appId}: ${e.message}`);
                }
            }

            try {
                if (appId === 'chrome64') {
                    try { latestVersionForApp = await fetchLatestChromeVersion(); storedVersionForApp = await readStoredVersion(appId); } catch (e) { console.warn(`Chrome version lookup failed: ${e.message}`); }
                }

                // Try HEAD across dynamic URL first, then backup candidates in order
                const tryOrder = [appUrl, ...candidates.map(c => c.url).filter(u => u !== appUrl)];
                let liveEtag = 'N/A', liveLastModified = 'N/A', redirectLocation = null, chosenUrl = null, liveVersionRef = null, liveSize = null;
                for (const url of tryOrder) {
                    const probed = await probeFinal(url);
                    if (!probed.ok) continue;
                    liveEtag = probed.etag;
                    liveLastModified = probed.lastModified;
                    liveSize = probed.size;
                    redirectLocation = probed.finalUrl;
                    chosenUrl = probed.finalUrl || url;
                    break;
                }
                if (!chosenUrl) chosenUrl = appUrl;
                // Try to infer version from final URL if not already known
                if (!liveVersionRef) {
                    let inferred = extractVersionFromUrl(redirectLocation || chosenUrl);
                    if (inferred) liveVersionRef = inferred;
                }
                if (!liveVersionRef && chosenUrl) {
                    const ghTag = extractGithubReleaseTag(chosenUrl);
                    if (ghTag) liveVersionRef = ghTag;
                }

                const installerPath = installerPathPre;
                let isUpdateAvailable = (liveEtag !== 'N/A' && liveEtag !== outputEtag) || (liveLastModified !== 'N/A' && liveLastModified !== outputLastModified);
                // Only trust structured version sources; avoid using redirect URLs as versions
                if (appId === 'chrome64' && latestVersionForApp) {
                    liveVersionRef = latestVersionForApp;
                }
                if (!storedVersionForApp) { try { storedVersionForApp = await readStoredVersion(appId); } catch(_){} }
                if (liveVersionRef && storedVersionForApp !== liveVersionRef) { isUpdateAvailable = true; }
                if (!isUpdateAvailable && installerExistsPre && liveSize && liveEtag === 'N/A' && liveLastModified === 'N/A') {
                    try {
                        const st = await fs.promises.stat(installerPathPre);
                        if (st.size !== liveSize) isUpdateAvailable = true;
                    } catch (_) {}
                }

                if (!installerExistsPre || isUpdateAvailable) {
                    console.log(`Attempting to download from ${chosenUrl} to ${installerPath}`);
                    const dl = await downloadValidated(appId, chosenUrl, installerPath, installerFilename);
                    const vendorFilename = dl.vendorFilename;
                    const vendorPath = dl.vendorPath;
                    try {
                        if (appId === 'spacemonger' && vendorFilename.toLowerCase().endsWith('.zip')) {
                            await extractSpaceMongerInstaller(vendorPath, installersBaseDir);
                            liveVersionRef = '1.4.0';
                        }
                        if (appId === 'musicbee' && vendorFilename.toLowerCase().endsWith('.zip')) {
                            const extracted = await extractMusicBeeInstaller(vendorPath, installersBaseDir);
                            const verMatch = path.basename(extracted).match(/MusicBeeSetup_([\d_]+)/i);
                            if (verMatch) liveVersionRef = verMatch[1].replace(/_/g, '.');
                        }
                    } catch (e) {
                        console.warn(`Post-download extract failed for ${appId}: ${e.message}`);
                    }
                    // Cleanup old files only after the new file is validated and in place
                    const keepCount = (appId.startsWith('python3') || appId.startsWith('jdk')) ? 2 : 1;
                    try { await cleanupOldVendorFiles(installersBaseDir, vendorFilename, keepCount); } catch (err) { console.warn(`Cleanup failed for ${appId}: ${err.message}`); }
                    try { await cleanupOldInstallerFiles(installersBaseDir, appId, installerFilename); } catch (err) { console.warn(`Installer cleanup failed for ${appId}: ${err.message}`); }
                    recordResult(appId, 'updated', preValidation && !preValidation.ok ? `replaced invalid file (${preValidation.reason})` : (installerExistsPre ? 'new version' : 'was missing'), { version: liveVersionRef || null, file: vendorFilename, bytes: dl.size, url: dl.finalUrl });
                    outputEtag = liveEtag; outputLastModified = liveLastModified;
                    const normId = normalizeAppId(appId);
                    if (!updatedSet.has(normId)) {
                        updatedAppsThisRun.push({
                            appId: normId,
                            updatedAt: new Date().toISOString(),
                            version: liveVersionRef || null,
                        });
                        updatedSet.add(normId);
                    }
                    if (liveVersionRef) { await writeStoredVersion(appId, liveVersionRef); }
                } else {
                    outputEtag = liveEtag; outputLastModified = liveLastModified;
                    recordResult(appId, 'unchanged', '', { version: storedVersionForApp || liveVersionRef || null, url: chosenUrl });
                    // Even if no update, still cleanup old files to keep directory clean
                    try {
                        await cleanupOldInstallerFiles(installersBaseDir, appId, installerFilename);
                        await cleanupOldVendorFiles(installersBaseDir, installerFilename, 1);
                    } catch(err) {
                        console.warn(`Cleanup failed for ${appId} (no update): ${err.message}`);
                    }
                }
            } catch (error) {
                console.error(`HEAD/download check failed for ${appId} at ${appUrl}: ${error.message}`);
                recordResult(appId, 'flagged', error.message, { url: appUrl, keptPrevious: installerExistsPre });
                // Still try to cleanup old files even if check failed
                try {
                    await cleanupOldInstallerFiles(installersBaseDir, appId, installerFilename);
                } catch(err) {
                    console.warn(`Cleanup failed for ${appId} (check error): ${err.message}`);
                }
                updatedLines.push(line); processedIds.add(appId); continue;
            }

            const newPrimary = `${appId}:${appUrl}:${outputEtag}:${outputLastModified}`;
            if (line !== newPrimary) { changesMade = true; }
            updatedLines.push(newPrimary);
            // Append remaining lines for same app unchanged so you keep your backup URLs in the file
            for (const l of appLines.slice(1)) { updatedLines.push(l); }
            processedIds.add(appId);
        }

        if (changesMade) {
            // Validate that we don't have duplicate appIds in the output
            const outputAppIds = new Set();
            const duplicates = [];
            for (const line of updatedLines) {
                if (line.startsWith('//') || line.trim() === '') continue;
                const firstColonIndex = line.indexOf(':');
                if (firstColonIndex === -1) continue;
                let appId;
                const firstToken = line.substring(0, firstColonIndex);
                if (/^\d+$/.test(firstToken)) {
                    const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
                    if (secondColonIndex === -1) continue;
                    appId = line.substring(firstColonIndex + 1, secondColonIndex);
                } else {
                    appId = firstToken;
                }
                if (outputAppIds.has(appId)) {
                    duplicates.push(appId);
                } else {
                    outputAppIds.add(appId);
                }
            }
            
            if (duplicates.length > 0) {
                console.error(`WARNING: Found duplicate appIds in output: ${duplicates.join(', ')}`);
                console.error('This should not happen - skipping file write to prevent corruption');
                return;
            }
            
            const tmpList = `${serverListPath}.tmp-${process.pid}`;
            await fs.promises.writeFile(tmpList, updatedLines.join('\n') + '\n', 'utf8');
            await fs.promises.rename(tmpList, serverListPath); // atomic replace
            console.log('Server list updated successfully (no status flags written).');
        } else {
            console.log('No updates found or no changes to serverlist.txt needed.');
        }

        // Build current allowed appIds from server list (used to prune old items)
        const allowedAppIds = (() => {
            const ids = new Set();
            for (const line of updatedLines) {
                if (line.startsWith('//') || line.trim() === '') continue;
                const fc = line.indexOf(':');
                if (fc === -1) continue;
                let appId;
                const firstToken = line.substring(0, fc);
                if (/^\d+$/.test(firstToken)) {
                    const sc = line.indexOf(':', fc + 1);
                    if (sc === -1) continue;
                    appId = line.substring(fc + 1, sc);
                } else {
                    appId = firstToken;
                }
                if (appId) ids.add(appId);
            }
            return ids;
        })();

        // Post-run validation of every serverlist app + per-app result log
        try {
            for (const id of processedIds) {
                if (SKIP_DOWNLOAD_APP_IDS.has(id) || skippedByFilter.has(id)) continue;
                const fname = getInstallerFileName(id);
                const v = await validateInstallerFile(path.join(installersBaseDir, fname), id, fname);
                const r = results.get(id);
                if (!v.ok) {
                    const prev = r ? `${r.status}${r.reason ? ': ' + r.reason : ''}; ` : '';
                    results.set(id, { ...(r || { appId: id }), status: 'flagged', reason: `${prev}served file ${fname} invalid (${v.reason})` });
                } else if (r) {
                    r.served = `${fname} (${v.kind}, ${v.size} bytes)`;
                    if (r.status === 'flagged' && r.keptPrevious) r.reason += ' [previous valid file still served]';
                }
            }
            await fs.promises.mkdir(logsDir, { recursive: true });
            const stamp = new Date().toISOString();
            const all = [...results.values()];
            const count = (st) => all.filter(r => r.status === st).length;
            const lines = [`=== update-checker run ${stamp}: ${all.length} apps, updated=${count('updated')} unchanged=${count('unchanged')} flagged=${count('flagged')} skipped=${count('skipped')} ===`];
            for (const r of all) {
                lines.push(`${stamp} ${r.appId.padEnd(22)} ${r.status.toUpperCase().padEnd(9)} ${[r.version ? 'v=' + r.version : '', r.served || '', r.reason || ''].filter(Boolean).join(' | ')}`);
            }
            await fs.promises.appendFile(resultLogPath, lines.join('\n') + '\n', 'utf8');
            await fs.promises.writeFile(resultJsonPath, JSON.stringify({ finishedAt: stamp, results: all }, null, 2), 'utf8');
            console.log(lines[0]);
        } catch (e) {
            console.error('Failed to write update-checker result log:', e.message);
        }

        // Write latest updates JSON for homepage (merge with prior items, keep latest 25, prune removed appIds)
        try {
            const latestUpdatesPath = path.join(__dirname, 'public', 'latest-updates.json');
            let previousItems = [];
            try { const prevRaw = await fs.promises.readFile(latestUpdatesPath, 'utf8'); const prevParsed = JSON.parse(prevRaw); previousItems = Array.isArray(prevParsed.items) ? prevParsed.items : []; } catch (_) { }
            previousItems = previousItems.map((it) => ({ ...it, appId: normalizeAppId(it.appId) }));
            // Drop items no longer present in current server list
            previousItems = previousItems.filter((it) => allowedAppIds.has(it.appId));
            // De-duplicate by appId, keeping the newest timestamp
            const merged = [...updatedAppsThisRun, ...previousItems];
            const newestByApp = new Map();
            for (const it of merged) {
                const prev = newestByApp.get(it.appId);
                if (!prev || (new Date(it.updatedAt)) > (new Date(prev.updatedAt))) {
                    newestByApp.set(it.appId, it);
                }
            }
            const thisRunIds = new Set(updatedAppsThisRun.map((it) => it.appId));
            const newest = Array.from(newestByApp.values());
            const fromThisRun = newest.filter((it) => thisRunIds.has(it.appId));
            const older = newest.filter((it) => !thisRunIds.has(it.appId));
            const byNewest = (a, b) => (new Date(b.updatedAt)) - (new Date(a.updatedAt));
            const deduped = [...fromThisRun.sort(byNewest), ...older.sort(byNewest)].slice(0, 80);
            const payload = { generatedAt: new Date().toISOString(), items: deduped };
            await fs.promises.writeFile(latestUpdatesPath, JSON.stringify(payload, null, 2), 'utf8');
            console.log(`Wrote latest updates to ${latestUpdatesPath}`);
        } catch (e) {
            console.error('Failed to write latest updates JSON:', e.message);
        }

    } catch (error) {
        console.error('Error processing server list:', error);
    } finally {
        if (restore) { try { restore(); } catch(_) {} }
        await releaseRunLock();
    }
}

module.exports = { checkUpdates };

// Run the update checker if this script is executed directly
if (require.main === module) {
    checkUpdates().catch(error => {
        console.error('Update checker failed:', error);
        process.exit(1);
    });
}
