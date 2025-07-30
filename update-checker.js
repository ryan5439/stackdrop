const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const serverListPath = path.join(__dirname, 'silentinstallers', 'serverlist.txt');
const installersBaseDir = path.join(__dirname, 'silentinstallers'); // Directory to store downloaded EXEs

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
        'notepadplusplus': 'npp.8.8.1.Installer.x64.exe',
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

async function checkUpdates() {
    try {
        await fs.promises.mkdir(installersBaseDir, { recursive: true }); // Ensure installer directory exists
        const data = await fs.promises.readFile(serverListPath, 'utf8');
        const lines = data.trim().split('\n');
        const updatedLines = [];
        let changesMade = false;

        for (const line of lines) {
            if (line.startsWith('//') || line.trim() === '') {
                updatedLines.push(line);
                continue;
            }

            // Fix URL parsing - each line should be in this format:
            // status:appId:url:etag:lastModified
            // But we need to be careful about the URL which may contain colons
            
            // First, separate status and appId which are guaranteed to not have colons
            const firstColonIndex = line.indexOf(':');
            if (firstColonIndex === -1) {
                console.warn(`Malformed line (no colon found): "${line}"`);
                updatedLines.push(line);
                continue;
            }
            const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
            if (secondColonIndex === -1) {
                console.warn(`Malformed line (only one colon found): "${line}"`);
                updatedLines.push(line);
                continue;
            }
            
            const storedStatus = line.substring(0, firstColonIndex);
            const appId = line.substring(firstColonIndex + 1, secondColonIndex);
            
            // Now find the URL which will start right after appId and may contain colons
            // Look for http:// or https:// and then find the next colon after the URL
            const urlStart = secondColonIndex + 1;
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
                updatedLines.push(`0:${appId}:${appUrl}:${storedEtag}:${storedLastModified}`); // 0 = not updated
                if (storedStatus !== '0') changesMade = true;
                continue;
            }

            // Only update if status is 0 (not updated/missing) or 2 (manual update needed)
            if (storedStatus === '0' || storedStatus === '2') {
                let outputStatus = '0';
                let outputEtag = storedEtag;
                let outputLastModified = storedLastModified;
                console.log(`Checking ${appId}...`);
                try {
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
                    const installerFilename = getInstallerFileName(appId);
                    const installerPath = path.join(installersBaseDir, installerFilename);
                    let installerExists = false;
                    try {
                        await fs.promises.access(installerPath);
                        installerExists = true;
                    } catch {
                        // Installer does not exist
                    }
                    const isUpdateAvailable = (liveEtag !== 'N/A' && liveEtag !== storedEtag) ||
                                              (liveLastModified !== 'N/A' && liveLastModified !== storedLastModified);
                    if (isUpdateAvailable || !installerExists) {
                        console.log(`Action required for ${appId}: Update available: ${isUpdateAvailable}, Installer exists: ${installerExists}.`);
                        console.log(`Attempting to download from ${appUrl} to ${installerPath}`);
                        const downloadProtocol = appUrl.startsWith('https') ? https : http;
                        try {
                            await new Promise((resolve, reject) => {
                                const request = downloadProtocol.get(appUrl, { timeout: 120000 }, (response) => {
                                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                                        // Handle redirect
                                        console.log(`Redirecting to ${response.headers.location} for ${appId}`);
                                        const redirectProtocol = response.headers.location.startsWith('https') ? https : http;
                                        const redirectRequest = redirectProtocol.get(response.headers.location, { timeout: 120000 }, (redirectResponse) => {
                                            if (redirectResponse.statusCode !== 200) {
                                                reject(new Error(`Download failed after redirect with status: ${redirectResponse.statusCode} for URL: ${response.headers.location}`));
                                                return;
                                            }
                                            const fileStream = fs.createWriteStream(installerPath);
                                            redirectResponse.pipe(fileStream);
                                            fileStream.on('finish', () => {
                                                fileStream.close(() => {
                                                    console.log(`Successfully downloaded ${appId} after redirect.`);
                                                    resolve();
                                                });
                                            });
                                            fileStream.on('error', (err) => {
                                                fs.unlink(installerPath, () => {});
                                                reject(new Error(`File stream error after redirect: ${err.message}`));
                                            });
                                        });
                                        redirectRequest.on('error', (err) => {
                                            reject(new Error(`Request error during redirected download: ${err.message}`));
                                        });
                                        redirectRequest.on('timeout', () => {
                                            redirectRequest.destroy();
                                            reject(new Error('Redirected download request timed out'));
                                        });
                                        return;
                                    }
                                    if (response.statusCode !== 200) {
                                        reject(new Error(`Download failed with status: ${response.statusCode} for URL: ${appUrl}`));
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
                            });
                            // If download is successful
                            outputStatus = '1'; // Mark as updated/done
                            outputEtag = liveEtag;
                            outputLastModified = liveLastModified;
                        } catch (downloadError) {
                            console.error(`Download failed for ${appId}: ${downloadError.message}`);
                            outputStatus = '0'; // Mark as not updated
                            // Keep previous ETag/LastModified
                        }
                    } else {
                        // No update needed and file exists
                        outputStatus = '1'; // Mark as updated/done
                        outputEtag = liveEtag;
                        outputLastModified = liveLastModified;
                    }
                } catch (error) {
                    console.error(`Failed to check ${appId} at ${appUrl}: ${error.message}`);
                    outputStatus = '0'; // Mark as not updated
                }
                const newLine = `${outputStatus}:${appId}:${appUrl}:${outputEtag}:${outputLastModified}`;
                if (line !== newLine) {
                    changesMade = true;
                }
                updatedLines.push(newLine);
            } else {
                // If status is 1, just keep as is (already updated/done)
                updatedLines.push(line);
            }
        }

        if (changesMade) {
            await fs.promises.writeFile(serverListPath, updatedLines.join('\n') + '\n', 'utf8');
            console.log('Server list updated successfully.');
        } else {
            console.log('No updates found or no changes to serverlist.txt needed.');
        }

    } catch (error) {
        console.error('Error processing server list:', error);
    }
}

checkUpdates();
