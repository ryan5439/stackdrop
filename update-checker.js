const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const serverListPath = path.join(__dirname, 'silentinstallers', 'serverlist.txt');
const installersBaseDir = path.join(__dirname, 'silentinstallers'); // Directory to store downloaded EXEs
const versionsDir = path.join(installersBaseDir, 'versions');

// Helper function to get the correct installer filename (same as in app.js)
function getInstallerFileName(appId) {
    const installerMap = {
        'chrome64': 'ChromeSetup64.exe',
        'firefox64': 'firefox_installer.exe',
        'edge': 'EdgeInstaller.msi',
        'opera64': 'Opera_119.0.5497.56_Setup_x64.exe',
        'zoom': 'zoom_installer.exe',
        'discord': 'discord_installer.exe',
        'teams': 'teams_installer.exe',
        'skype': 'skype_installer.exe',
        'slack': 'slack_installer.exe',
        'vlc': 'vlc_installer.exe',
        'itunes': 'itunes_installer.exe',
        'winamp': 'winamp_installer.exe',
        'spotify': 'spotify_installer.exe',
        'aimp': 'aimp_installer.exe',
        'foobar2000': 'foobar2000_installer.exe',
        'musicbee': 'musicbee_installer.exe',
        'audacity': 'audacity_installer.exe',
        'klitecodecs': 'klitecodecs_installer.exe',
        'gom': 'gom_installer.exe',
        'cccp': 'cccp_installer.exe',
        'mediamonkey': 'mediamonkey_installer.exe',
        'handbrake': 'handbrake_installer.exe',
        'malwarebytes': 'malwarebytes_installer.exe',
        'avast': 'avast_installer.exe',
        'avg': 'avg_installer.exe',
        'spybot2': 'spybot2_installer.exe',
        'avira': 'avira_installer.exe',
        'superantispyware': 'superantispyware_installer.exe',
        'dropbox': 'dropbox_installer.exe',
        'googledrive': 'googledrive_installer.exe',
        'onedrive': 'onedrive_installer.exe',
        'ccleaner': 'ccleaner_installer.exe',
        'teamviewer': 'teamviewer_installer.exe',
        'anydesk': 'anydesk_installer.exe',
        'imgburn': 'imgburn_installer.exe',
        'notepadplusplus': 'notepadplusplus_installer.exe',
        'filezilla': 'filezilla_installer.exe',
        'vscode': 'vscode_installer.exe',
        'libreoffice': 'libreoffice_installer.exe',
        'openoffice': 'openoffice_installer.exe',
        'foxitreader': 'foxitreader_installer.exe',
        'gimp': 'gimp_installer.exe',
        'blender': 'blender_installer.exe',
        'krita': 'krita_installer.exe',
        // .NET Framework installer files
        'dotnet481': 'dotnetfx481_x64.exe',
        'dotnet481x86': 'dotnetfx481_x86.exe',
        'dotnet9': 'dotnet-runtime-9.0-win-x64.exe',
        'dotnet9x86': 'dotnet-runtime-9.0-win-x86.exe',
        'dotnet9desktop': 'dotnet-desktop-runtime-9.0-win-x64.exe',
        'dotnet9desktopx86': 'dotnet-desktop-runtime-9.0-win-x86.exe',
        // Development tools installer files
        'jdk24x64': 'jdk-24_windows-x64_bin.exe',
        'jdk24x86': 'jdk-24_windows-x86_bin.exe',
        'jdk21x64': 'jdk-21_windows-x64_bin.exe',
        'jdk21x86': 'jdk-21_windows-x86_bin.exe',
        'python311x64': 'python-3.11.9-amd64.exe',
        'python311x86': 'python-3.11.9.exe',
        'python312x64': 'python-3.12.7-amd64.exe',
        'python312x86': 'python-3.12.7.exe',
        'python313x64': 'python-3.13.0-amd64.exe',
        'python313x86': 'python-3.13.0.exe'
    };
    return installerMap[appId] || `${appId}_installer.exe`;
}

// Helper to fetch text content with basic redirect handling
async function fetchTextWithRedirects(url, maxRedirects = 10) {
    return await new Promise((resolve, reject) => {
        const visit = (currentUrl, remaining) => {
            if (remaining <= 0) {
                reject(new Error(`Too many redirects while fetching ${currentUrl}`));
                return;
            }
            const protocol = currentUrl.startsWith('https') ? https : http;
            const req = protocol.get(currentUrl, { timeout: 30000 }, (res) => {
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

// Fetch latest Chrome stable version (Windows x64) using omahaproxy
async function fetchLatestChromeVersion() {
    const url = 'https://omahaproxy.appspot.com/all.json';
    const jsonText = await fetchTextWithRedirects(url);
    const parsed = JSON.parse(jsonText);
    // Prefer win64 stable
    const pick = (osName) => {
        const osEntry = parsed.find(e => (e.os || '').toLowerCase() === osName);
        if (!osEntry) return null;
        const stable = (osEntry.versions || []).find(v => (v.channel || '').toLowerCase() === 'stable');
        return stable && stable.current_version ? String(stable.current_version) : null;
    };
    return pick('win64') || pick('win') || null;
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
// Normalize legacy/mismatched app IDs to those used in the UI/app catalog
function normalizeAppId(appId) {
    if (appId === 'opera') return 'opera64';
    return appId;
}

async function checkUpdates() {
    try {
        await fs.promises.mkdir(installersBaseDir, { recursive: true }); // Ensure installer directory exists
        // Ensure public directory exists for latest updates
        const publicDir = path.join(__dirname, 'public');
        await fs.promises.mkdir(publicDir, { recursive: true });
        const data = await fs.promises.readFile(serverListPath, 'utf8');
        const lines = data.trim().split('\n');
        const updatedLines = [];
        let changesMade = false;
        const updatedAppsThisRun = [];

        for (const line of lines) {
            if (line.startsWith('//') || line.trim() === '') {
                updatedLines.push(line);
                continue;
            }

            // Accept lines with or without a leading status flag. Supported formats:
            // - appId:url[:etag][:lastModified]
            // - status:appId:url[:etag][:lastModified] (status is ignored)
            const firstColonIndex = line.indexOf(':');
            if (firstColonIndex === -1) {
                console.warn(`Malformed line (no colon found): "${line}"`);
                updatedLines.push(line);
                continue;
            }
            let appId;
            let urlStart;
            const firstToken = line.substring(0, firstColonIndex);
            if (/^\d+$/.test(firstToken)) {
                const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
                if (secondColonIndex === -1) {
                    console.warn(`Malformed line (only one colon found after status): "${line}"`);
                    updatedLines.push(line);
                    continue;
                }
                appId = line.substring(firstColonIndex + 1, secondColonIndex);
                urlStart = secondColonIndex + 1;
            } else {
                appId = firstToken;
                urlStart = firstColonIndex + 1;
            }
            
            // Now find the URL which will start right after appId and may contain colons
            // Look for http:// or https:// and then find the next colon after the URL
            const urlProtocolEnd = line.indexOf('://', urlStart);
            if (urlProtocolEnd === -1) {
                console.warn(`Malformed URL (no protocol found): "${line}"`);
                updatedLines.push(line);
                continue;
            }
            
            // Find the next colon after the protocol
            const urlEnd = line.indexOf(':', urlProtocolEnd + 3);
            let appUrl, storedEtag, storedLastModified;
            
            if (urlEnd === -1) {
                // No more colons, URL goes to the end
                appUrl = line.substring(urlStart);
                storedEtag = 'N/A';
                storedLastModified = 'N/A';
            } else {
                appUrl = line.substring(urlStart, urlEnd);
                const remaining = line.substring(urlEnd + 1);
                const parts = remaining.split(':');
                storedEtag = parts[0] || 'N/A';
                storedLastModified = parts[1] || 'N/A';
            }

            if (!appUrl.startsWith('http://') && !appUrl.startsWith('https://')) {
                console.warn(`Skipping line for app "${appId}" due to invalid URL: "${appUrl}" in line: "${line}"`);
                updatedLines.push(line);
                continue;
            }

            // Determine installer path and existence before deciding whether to attempt download
            const installerFilenamePre = getInstallerFileName(appId);
            const installerPathPre = path.join(installersBaseDir, installerFilenamePre);
            let installerExistsPre = false;
            try {
                await fs.promises.access(installerPathPre);
                installerExistsPre = true;
            } catch {
                // missing
            }

            // Always perform a HEAD check to detect updates; decide whether to download
            let outputEtag = storedEtag;
            let outputLastModified = storedLastModified;
            let latestVersionForApp = null;
            let storedVersionForApp = null;
            console.log(`Checking ${appId}...`);

            // Special handling for Opera - always resolve latest valid installer URL
            if (appId === 'opera') {
                try {
                    appUrl = await getLatestOperaUrl();
                    console.log(`Found latest Opera URL: ${appUrl}`);
                } catch (error) {
                    console.error(`Failed to get latest Opera URL: ${error.message}`);
                    // Keep the original URL and continue
                }
            }

            try {
                if (appId === 'chrome64') {
                    try {
                        latestVersionForApp = await fetchLatestChromeVersion();
                        storedVersionForApp = await readStoredVersion(appId);
                    } catch (e) {
                        console.warn(`Chrome version lookup failed: ${e.message}`);
                    }
                }
                const protocol = appUrl.startsWith('https') ? https : http;
                const headResponse = await new Promise((resolve, reject) => {
                    const req = protocol.request(appUrl, { method: 'HEAD', timeout: 30000 }, (res) => {
                        resolve(res);
                    });
                    req.on('error', (e) => {
                        reject(new Error(`HEAD request error: ${e.message}`));
                    });
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('HEAD request timed out'));
                    });
                    req.end();
                });
                const liveEtag = headResponse.headers['etag'] || 'N/A';
                const liveLastModified = headResponse.headers['last-modified'] || 'N/A';
                const installerFilename = installerFilenamePre;
                const installerPath = installerPathPre;
                const installerExists = installerExistsPre;
                let isUpdateAvailable = (liveEtag !== 'N/A' && liveEtag !== storedEtag) ||
                                          (liveLastModified !== 'N/A' && liveLastModified !== storedLastModified);
                if (appId === 'chrome64' && latestVersionForApp && storedVersionForApp !== latestVersionForApp) {
                    console.log(`Chrome version change detected: ${storedVersionForApp || 'none'} -> ${latestVersionForApp}`);
                    isUpdateAvailable = true;
                }

                if (!installerExists || isUpdateAvailable) {
                    console.log(`Action required for ${appId}: Update available: ${isUpdateAvailable}, Installer exists: ${installerExists}.`);
                    console.log(`Attempting to download from ${appUrl} to ${installerPath}`);
                    await new Promise((resolve, reject) => {
                        // Function to handle downloads with recursive redirect following
                        const downloadWithRedirects = (url, maxRedirects = 10) => {
                            if (maxRedirects <= 0) {
                                reject(new Error(`Too many redirects for ${appId} at ${url}`));
                                return;
                            }

                            const currentProtocol = url.startsWith('https') ? https : http;
                            const request = currentProtocol.get(url, { timeout: 120000 }, (response) => {
                                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                                    // Handle redirect recursively - handle both absolute and relative URLs
                                    let redirectUrl = response.headers.location;
                                    if (redirectUrl.startsWith('/')) {
                                        // Relative URL - construct absolute URL from current domain
                                        const urlObj = new URL(url);
                                        redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                                    } else if (!redirectUrl.startsWith('http')) {
                                        // Relative URL without leading slash
                                        const urlObj = new URL(url);
                                        const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
                                        redirectUrl = `${urlObj.protocol}//${urlObj.host}${basePath}${redirectUrl}`;
                                    }
                                    console.log(`Redirecting to ${redirectUrl} for ${appId} (${maxRedirects} redirects remaining)`);
                                    downloadWithRedirects(redirectUrl, maxRedirects - 1);
                                    return;
                                }
                                if (response.statusCode !== 200) {
                                    reject(new Error(`Download failed with status: ${response.statusCode} for URL: ${url}`));
                                    return;
                                }
                                const fileStream = fs.createWriteStream(installerPath);
                                response.pipe(fileStream);
                                fileStream.on('finish', () => {
                                    fileStream.close(() => {
                                        console.log(`Successfully downloaded ${appId}.`);
                                        resolve();
                                    });
                                });
                                fileStream.on('error', (err) => {
                                    fs.unlink(installerPath, () => {});
                                    reject(new Error(`File stream error: ${err.message}`));
                                });
                            });
                            request.on('error', (err) => {
                                reject(new Error(`Request error during download: ${err.message}`));
                            });
                            request.on('timeout', () => {
                                request.destroy();
                                reject(new Error('Download request timed out'));
                            });
                        };

                        downloadWithRedirects(appUrl);
                    });
                    // If download is successful
                    outputEtag = liveEtag;
                    outputLastModified = liveLastModified;
                    // Track successful updates for homepage display (normalized to UI IDs)
                    updatedAppsThisRun.push({ appId: normalizeAppId(appId), updatedAt: new Date().toISOString() });
                    if (appId === 'chrome64' && latestVersionForApp) {
                        await writeStoredVersion(appId, latestVersionForApp);
                    }
                } else {
                    // No update needed and file exists
                    outputEtag = liveEtag;
                    outputLastModified = liveLastModified;
                }
            } catch (error) {
                console.error(`HEAD/download check failed for ${appId} at ${appUrl}: ${error.message}`);
                // Keep existing line as-is on failure
                updatedLines.push(line);
                continue;
            }

            const newLine = `${appId}:${appUrl}:${outputEtag}:${outputLastModified}`;
            if (line !== newLine) {
                changesMade = true;
            }
            updatedLines.push(newLine);
        }

        if (changesMade) {
            await fs.promises.writeFile(serverListPath, updatedLines.join('\n') + '\n', 'utf8');
            console.log('Server list updated successfully (no status flags written).');
        } else {
            console.log('No updates found or no changes to serverlist.txt needed.');
        }

        // Write latest updates JSON for homepage (merge with prior items, keep latest 25)
        try {
            const latestUpdatesPath = path.join(__dirname, 'public', 'latest-updates.json');
            let previousItems = [];
            try {
                const prevRaw = await fs.promises.readFile(latestUpdatesPath, 'utf8');
                const prevParsed = JSON.parse(prevRaw);
                previousItems = Array.isArray(prevParsed.items) ? prevParsed.items : [];
            } catch (_) { /* ignore */ }

            // Normalize legacy entries (e.g., opera -> opera64)
            previousItems = previousItems.map((it) => ({
                ...it,
                appId: normalizeAppId(it.appId)
            }));

            const merged = [...updatedAppsThisRun, ...previousItems]
                .sort((a, b) => (new Date(b.updatedAt)) - (new Date(a.updatedAt)))
                .slice(0, 25);

            const payload = {
                generatedAt: new Date().toISOString(),
                items: merged
            };
            await fs.promises.writeFile(latestUpdatesPath, JSON.stringify(payload, null, 2), 'utf8');
            console.log(`Wrote latest updates to ${latestUpdatesPath}`);
        } catch (e) {
            console.error('Failed to write latest updates JSON:', e.message);
        }

    } catch (error) {
        console.error('Error processing server list:', error);
    }
}

module.exports = { checkUpdates };
