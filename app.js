const express = require('express');
const path = require('path');
const fs = require('fs');           // Standard fs with synchronous methods
const fsPromises = fs.promises;     // Promise-based fs methods
const util = require('util');
const execCallback = require('child_process').exec;
const exec = util.promisify(execCallback);
const crypto = require('crypto');
const { EventEmitter } = require('events');
const app = express();
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
        
        app.listen(port, () => {
            console.log(`Stackdrop app listening at http://localhost:${port}`);
        });
    } catch (error) {
        console.error('Failed to initialize app:', error);
        process.exit(1);
    }
}

init();

// Set view engine and static files
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve silent installers
app.use('/silentinstallers', express.static('/var/www/stackdrop/silentinstallers'));

// Serve downloads for the installer
app.use('/downloads', express.static('/var/www/stackdrop/silentinstallers'));

// Serve test.html
app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'test.html'));
});

// App categories and software
const apps = {
    browsers: {
        title: '🌐 Web Browsers 🌐',
        
        items: [
            { id: 'chrome64', name: 'Chrome' },
            { id: 'firefox64', name: 'Firefox' },
            { id: 'edge', name: 'Edge' },
            { id: 'opera64', name: 'Opera' }
        ]
    },
    messaging: {
        title: '💬  Messaging  💬',

        items: [
            { id: 'zoom', name: 'Zoom' },
            { id: 'discord', name: 'Discord' },
            { id: 'teams', name: 'Microsoft Teams' },
            { id: 'skype', name: 'Skype' },
            { id: 'slack', name: 'Slack' }
        ]
    },
    media: {
        title: '🎵  Media  🎵',
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
            { id: 'handbrake', name: 'HandBrake' }
        ]
    },
    security: {
        title: '🔒  Security  🔒',
        items: [
            { id: 'malwarebytes', name: 'Malwarebytes' },
            { id: 'avast', name: 'Avast Free Antivirus' },
            { id: 'avg', name: 'AVG Free Antivirus' },
            { id: 'spybot2', name: 'Spybot 2' },
            { id: 'avira', name: 'Avira Free Antivirus' },
            { id: 'superantispyware', name: 'SUPERAntiSpyware' }
        ]
    },
    storage: {
        title: '☁️  Online Storage  ☁️',
        items: [
            { id: 'dropbox', name: 'Dropbox' },
            { id: 'googledrive', name: 'Google Drive' },
            { id: 'onedrive', name: 'OneDrive' }
        ]
    },
    utilities: {
        title: '🔧  Utilities  🔧',
        items: [
            { id: 'ccleaner', name: 'CCleaner' },
            { id: 'teamviewer', name: 'TeamViewer' },
            { id: 'anydesk', name: 'AnyDesk' },
            { id: 'imgburn', name: 'ImgBurn' }
        ]
    },
    development: {
        title: '💻  Developer Tools  💻',
        items: [
            { id: 'notepadplusplus', name: 'Notepad++' },
            { id: 'filezilla', name: 'FileZilla' },
            { id: 'vscode', name: 'Visual Studio Code' }
        ]
    },
    dotnet: {
        title: '🔧  .NET Frameworks (with System Variables)  🔧',
        items: [
            { id: 'dotnet481', name: '.NET Framework 4.8.1 (64-bit)' },
            { id: 'dotnet481x86', name: '.NET Framework 4.8.1 (32-bit)' },
            { id: 'dotnet9', name: '.NET 9.0 Runtime (64-bit)' },
            { id: 'dotnet9x86', name: '.NET 9.0 Runtime (32-bit)' },
            { id: 'dotnet9desktop', name: '.NET 9.0 Desktop Runtime (64-bit)' },
            { id: 'dotnet9desktopx86', name: '.NET 9.0 Desktop Runtime (32-bit)' }
        ]
    },
    developmentkits: {
        title: '💻  Development Kits (with System Variables)  💻',
        items: [
            { id: 'jdk24x64', name: 'Java JDK 24 (64-bit)' },
            { id: 'jdk24x86', name: 'Java JDK 24 (32-bit)' },
            { id: 'jdk21x64', name: 'Java JDK 21 LTS (64-bit)' },
            { id: 'jdk21x86', name: 'Java JDK 21 LTS (32-bit)' },
            { id: 'python311x64', name: 'Python 3.11 (64-bit)' },
            { id: 'python311x86', name: 'Python 3.11 (32-bit)' },
            { id: 'python312x64', name: 'Python 3.12 (64-bit)' },
            { id: 'python312x86', name: 'Python 3.12 (32-bit)' },
            { id: 'python313x64', name: 'Python 3.13 (64-bit)' },
            { id: 'python313x86', name: 'Python 3.13 (32-bit)' }
        ]
    },
    documents: {
        title: '📄  Documents  📄',
        items: [
            { id: 'libreoffice', name: 'LibreOffice' },
            { id: 'foxitreader', name: 'Foxit Reader' },
            { id: 'openoffice', name: 'OpenOffice' }
        ]
    },
    imaging: {
        title: '🖼️  Imaging 🖼️',
        items: [
            { id: 'gimp', name: 'GIMP' },
            { id: 'blender', name: 'Blender' },
            { id: 'krita', name: 'Krita' }
        ]
    }
};
// Routes - Place this section right after your apps object definition and before the /generate route

// Main index route
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'Stackdrop - install and update your complete software stack with 1 click',
        apps: apps
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

// Serve EXE files for download by the installer
app.get('/downloads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join('/var/www/stackdrop/silentinstallers', filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    // Serve the file for download
    res.download(filePath, filename, (err) => {
        if (err) {
            console.error('Download error:', err);
            res.status(500).json({ error: 'Download failed' });
        }
    });
});

// Generate installer endpoint (your existing route)
app.post('/generate', async (req, res) => {
    const selectedApps = req.body.apps || [];
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
        
        // Create a dynamic multi-app NSIS script
        const multiAppScript = generateMultiAppNSIS(selectedApps, exePath);
        const nsisScriptPath = path.join(tempDir, 'multi_app_installer.nsi');
        await fsPromises.writeFile(nsisScriptPath, multiAppScript, 'utf8');

        // Run makensis from the temp directory
        const makensisCmd = `cd "${tempDir}" && makensis -V4 -NOCD "multi_app_installer.nsi"`;
        const { stdout, stderr } = await exec(makensisCmd);
        console.log('makensis stdout:', stdout);
        if (stderr) console.error('makensis stderr:', stderr);

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

// App installer filename mapping
const installerFileMap = {
    opera32: 'operasilentinstaller_32.nsi',
    opera64: 'operasilentinstaller_64.nsi',
    firefox32: 'firefoxsilentinstaller_32.nsi',
    firefox64: 'firefoxsilentinstaller_64.nsi',
    chrome32: 'chromesilentinstaller_32.nsi',
    chrome64: 'chromesilentinstaller_64.nsi',
    anydesk: 'anydesksilentinstaller.nsi',
    avast: 'avastsilentinstaller.nsi',
    avira: 'avirasilentinstaller.nsi',
    ccleaner: 'ccleanersilentinstaller.nsi',
    edge: 'edgesilentinstaller.nsi',
    filezilla: 'filezillasilentinstaller.nsi',
    imgburn: 'imgburnsilentinstaller.nsi',
    itunes: 'itunessilentinstaller.nsi',
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
    // .NET Framework mappings
    dotnet481: 'dotnet481silentinstaller.nsi',
    dotnet481x86: 'dotnet481x86silentinstaller.nsi',
    dotnet9: 'dotnet9silentinstaller.nsi',
    dotnet9x86: 'dotnet9x86silentinstaller.nsi',
    dotnet9desktop: 'dotnet9desktopsilentinstaller.nsi',
    dotnet9desktopx86: 'dotnet9desktopx86silentinstaller.nsi',
    // Development tools mappings
    jdk24x64: 'jdk24x64silentinstaller.nsi',
    jdk24x86: 'jdk24x86silentinstaller.nsi',
    jdk21x64: 'jdk21x64silentinstaller.nsi',
    jdk21x86: 'jdk21x86silentinstaller.nsi',
    python311x64: 'python311x64silentinstaller.nsi',
    python311x86: 'python311x86silentinstaller.nsi',
    python312x64: 'python312x64silentinstaller.nsi',
    python312x86: 'python312x86silentinstaller.nsi',
    python313x64: 'python313x64silentinstaller.nsi',
    python313x86: 'python313x86silentinstaller.nsi',
    // Add more mappings as needed for other .nsi files in the folder
};

// Routes
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'Stackdrop - install and update your complete software stack with 1 click',
        apps: apps
    });
});

// Generate installer endpoint
app.post('/generate', async (req, res) => {
    const selectedApps = req.body.apps || [];
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
        
        // Create a dynamic multi-app NSIS script
        const multiAppScript = generateMultiAppNSIS(selectedApps, exePath);
        const nsisScriptPath = path.join(tempDir, 'multi_app_installer.nsi');
        await fsPromises.writeFile(nsisScriptPath, multiAppScript, 'utf8');

        // Run makensis from the temp directory
        const makensisCmd = `cd "${tempDir}" && makensis -V4 -NOCD "multi_app_installer.nsi"`;
        const { stdout, stderr } = await exec(makensisCmd);
        console.log('makensis stdout:', stdout);
        if (stderr) console.error('makensis stderr:', stderr);

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

// Function to generate multi-app NSIS script
function generateMultiAppNSIS(selectedApps, exePath) {
    // Use the actual server IP address for downloads
    const serverIP = '69.48.166.160';
    const serverPort = process.env.PORT || '3000';
    const serverUrl = `http://${serverIP}:${serverPort}`;
    
    const appInstallSections = selectedApps.map((appId, index) => {
        const appName = getAppDisplayName(appId);
        const installerFileName = getInstallerFileName(appId);
        const silentFlag = getSilentFlag(appId);
        
        return `
Section "Install${appName.replace(/\s+/g, '')}" SEC${index + 1}
    DetailPrint "Downloading ${appName}..."
    DetailPrint "Downloading ${installerFileName}..."
    
    ; Test connection first
    DetailPrint "Testing connection to server..."
    NSISdl::download "${serverUrl}/server-info" "$$TEMP\\connection_test.txt"
    Pop $0
    StrCmp $0 "success" connection_ok_${index} connection_fail_${index}
    
    connection_ok_${index}:
        Delete "$$TEMP\\connection_test.txt"
        DetailPrint "Connection test successful. Downloading ${installerFileName}..."
        NSISdl::download "${serverUrl}/downloads/${installerFileName}" "$$TEMP\\${installerFileName}"
        Pop $0
        StrCmp $0 "success" download_ok_${index} download_fail_${index}
    
    connection_fail_${index}:
        DetailPrint "Connection test failed. Error: $$0"
        MessageBox MB_OK|MB_ICONSTOP "Cannot connect to server. Error code: $$0. Check firewall and antivirus settings."
        Goto end_${index}
    
    download_ok_${index}:
        DetailPrint "Download successful. Installing ${appName}..."
        ExecWait '"$$TEMP\\${installerFileName}" ${silentFlag}'
        DetailPrint "${appName} installation complete."
        Delete "$$TEMP\\${installerFileName}"
        Goto end_${index}
    
    download_fail_${index}:
        DetailPrint "Download failed for ${appName}. Error: $$0"
        MessageBox MB_OK|MB_ICONSTOP "Failed to download ${appName}. Error: $$0"
    
    end_${index}:
SectionEnd`;
    }).join('\n');

    return `!include "MUI2.nsh"

; Multi-App Stackdrop Downloader & Installer
Name "Stackdrop Multi-App Installer"
OutFile "${exePath.replace(/\\/g, '\\\\')}"
InstallDir "$$TEMP\\StackdropInstaller"

ShowInstDetails show

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
    DetailPrint "Checking internet connection..."
    NSISdl::download "http://www.google.com" "$$TEMP\\internet_test.txt"
    Pop $0
    StrCmp $0 "success" internet_ok internet_fail
    
    internet_ok:
        Delete "$$TEMP\\internet_test.txt"
        DetailPrint "Internet connection verified."
        Goto init_done
        
    internet_fail:
        DetailPrint "Initial internet test failed, but will try server connection later."
        DetailPrint "Internet test error code: $$0"
        
    init_done:
FunctionEnd

${appInstallSections}

Function .onInstSuccess
    DetailPrint "All applications installed successfully!"
    MessageBox MB_OK|MB_ICONINFORMATION "Stackdrop installation complete! All selected applications have been installed."
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

// Helper function to get installer filename
function getInstallerFileName(appId) {
    const installerMap = {
        'chrome64': 'ChromeSetup64.exe',
        'firefox64': 'FirefoxSetup141.0.exe',
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

// Helper function to get silent install flags
function getSilentFlag(appId) {
    const silentFlags = {
        'chrome64': '/silent /install',
        'firefox64': '/S',
        'edge': '/silent /install',
        'opera64': '/S',
        'zoom': '/S',
        'discord': '/S',
        'teams': '/S',
        'skype': '/S',
        'slack': '/S',
        'vlc': '/S',
        'itunes': '/S',
        'winamp': '/S',
        'spotify': '/S',
        'aimp': '/S',
        'foobar2000': '/S',
        'musicbee': '/S',
        'audacity': '/S',
        'klitecodecs': '/S',
        'gom': '/S',
        'cccp': '/S',
        'mediamonkey': '/S',
        'handbrake': '/S',
        'malwarebytes': '/S',
        'avast': '/S',
        'avg': '/S',
        'spybot2': '/S',
        'avira': '/S',
        'superantispyware': '/S',
        'dropbox': '/S',
        'googledrive': '/S',
        'onedrive': '/S',
        'ccleaner': '/S',
        'teamviewer': '/S',
        'anydesk': '/S',
        'imgburn': '/S',
        'notepadplusplus': '/S',
        'filezilla': '/S',
        'vscode': '/VERYSILENT /NORESTART',
        'libreoffice': '/S',
        'openoffice': '/S',
        'foxitreader': '/S',
        'gimp': '/S',
        'blender': '/S',
        'krita': '/S',
        // .NET Framework silent install flags with system variables
        'dotnet481': '/q /norestart',
        'dotnet481x86': '/q /norestart',
        'dotnet9': '/install /quiet /norestart',
        'dotnet9x86': '/install /quiet /norestart',
        'dotnet9desktop': '/install /quiet /norestart',
        'dotnet9desktopx86': '/install /quiet /norestart',
        // Development tools silent install flags
        'jdk24x64': '/s ADDLOCAL=ToolsFeature,SourceFeature,PublicJREFeature',
        'jdk24x86': '/s ADDLOCAL=ToolsFeature,SourceFeature,PublicJREFeature',
        'jdk21x64': '/s ADDLOCAL=ToolsFeature,SourceFeature,PublicJREFeature',
        'jdk21x86': '/s ADDLOCAL=ToolsFeature,SourceFeature,PublicJREFeature',
        'python311x64': '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0',
        'python311x86': '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0',
        'python312x64': '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0',
        'python312x86': '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0',
        'python313x64': '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0',
        'python313x86': '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0'
    };
    return silentFlags[appId] || '/S';
}

// Add error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error'
    });
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