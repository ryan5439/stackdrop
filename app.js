const express = require('express');
const path = require('path');
const fs = require('fs');           // Standard fs with synchronous methods
const fsPromises = fs.promises;     // Promise-based fs methods
const util = require('util');
const execCallback = require('child_process').exec;
const exec = util.promisify(execCallback);
const crypto = require('crypto');
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

// App categories and software
const apps = {
    browsers: {
        title: '🌐 Web Browsers',
        items: [
            { id: 'chrome', name: 'Google Chrome' },
            { id: 'firefox', name: 'Mozilla Firefox' },
            { id: 'edge', name: 'Microsoft Edge' },
            { id: 'opera', name: 'Opera' },
            { id: 'brave', name: 'Brave' }
        ]
    },
    messaging: {
        title: '💬 Messaging',
        items: [
            { id: 'zoom', name: 'Zoom' },
            { id: 'discord', name: 'Discord' },
            { id: 'teams', name: 'Microsoft Teams' },
            { id: 'skype', name: 'Skype' },
            { id: 'slack', name: 'Slack' }
        ]
    },
    media: {
        title: '🎵 Media',
        items: [
            { id: 'vlc', name: 'VLC' },
            { id: 'itunes', name: 'iTunes' },
            { id: 'winamp', name: 'Winamp' },
            { id: 'spotify', name: 'Spotify' }
        ]
    },
    security: {
        title: '🔒 Security',
        items: [
            { id: 'malwarebytes', name: 'Malwarebytes' },
            { id: 'avast', name: 'Avast' },
            { id: 'avg', name: 'AVG' }
        ]
    },
    storage: {
        title: '☁️ Online Storage',
        items: [
            { id: 'dropbox', name: 'Dropbox' },
            { id: 'googledrive', name: 'Google Drive' },
            { id: 'onedrive', name: 'OneDrive' }
        ]
    },
    utilities: {
        title: '🔧 Utilities',
        items: [
            { id: 'ccleaner', name: 'CCleaner' },
            { id: 'teamviewer', name: 'TeamViewer' },
            { id: 'anydesk', name: 'AnyDesk' },
            { id: 'imgburn', name: 'ImgBurn' }
        ]
    },
    development: {
        title: '💻 Developer Tools',
        items: [
            { id: 'notepadplusplus', name: 'Notepad++' },
            { id: 'python', name: 'Python' },
            { id: 'filezilla', name: 'FileZilla' },
            { id: 'vscode', name: 'Visual Studio Code' }
        ]
    },
    documents: {
        title: '📄 Documents',
        items: [
            { id: 'libreoffice', name: 'LibreOffice' },
            { id: 'foxitreader', name: 'Foxit Reader' },
            { id: 'openoffice', name: 'OpenOffice' }
        ]
    },
    imaging: {
        title: '🖼️ Imaging',
        items: [
            { id: 'gimp', name: 'GIMP' },
            { id: 'blender', name: 'Blender' },
            { id: 'krita', name: 'Krita' }
        ]
    }
};

// App installer filename mapping
const installerFileMap = {
    firefox: 'ff_installer.exe',
    chrome: 'chrome_installer.exe',
    edge: 'edge_installer.exe',
    opera: 'opera_installer.exe',
    brave: 'brave_installer.exe',
    zoom: 'zoom_installer.exe',
    discord: 'discord_installer.exe',
    teams: 'teams_installer.exe',
    skype: 'skype_installer.exe',
    slack: 'slack_installer.exe',
    vlc: 'vlc_installer.exe',
    itunes: 'itunes_installer.exe',
    winamp: 'winamp_installer.exe',
    spotify: 'spotify_installer.exe',
    malwarebytes: 'malwarebytes_installer.exe',
    avast: 'avast_installer.exe',
    avg: 'avg_installer.exe',
    dropbox: 'dropbox_installer.exe',
    googledrive: 'googledrive_installer.exe',
    onedrive: 'onedrive_installer.exe',
    ccleaner: 'ccleaner_installer.exe',
    teamviewer: 'teamviewer_installer.exe',
    anydesk: 'anydesk_installer.exe',
    imgburn: 'imgburn_installer.exe',
    notepadplusplus: 'notepadplusplus_installer.exe',
    python: 'python_installer.exe',
    filezilla: 'filezilla_installer.exe',
    vscode: 'vscode_installer.exe',
    libreoffice: 'libreoffice_installer.exe',
    foxitreader: 'foxitreader_installer.exe',
    openoffice: 'openoffice_installer.exe',
    gimp: 'gimp_installer.exe',
    blender: 'blender_installer.exe',
    krita: 'krita_installer.exe'
};

// Routes
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'Stackdrop - install and update your complete software stack with 1 click',
        apps: apps
    });
});

// Generate installer endpoint - updated for proper permissions without sudo
app.post('/generate', async (req, res) => {
    const selectedApps = req.body.apps || [];
    const exeName = 'StackdropInstaller.exe';

    if (selectedApps.length === 0) {
        return res.status(400).json({ error: 'Please select at least one app.' });
    }

    // Check if multiple apps are selected
    if (selectedApps.length > 1) {
        // For multiple apps, we'll create a combined installer
        return await generateMultiAppInstaller(selectedApps, exeName, res);
    }

    // For a single app, use the existing approach
    const firstSelectedAppId = selectedApps[0];
    const installerFileName = installerFileMap[firstSelectedAppId] || `${firstSelectedAppId}_installer.exe`;
    const localInstallerPath = path.join(__dirname, 'silentinstallers', installerFileName);

    // Create a unique temp directory
    const baseTempDir = '/var/tmp/stackdrop-installer'; // Changed from /tmp to /var/tmp
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const tempDir = path.join(baseTempDir, uniqueId);

    try {
        // Ensure base and temp directories exist
        await fsPromises.mkdir(baseTempDir, { recursive: true });
        await fsPromises.mkdir(tempDir, { recursive: true });

        // Check if tempDir is writable
        try {
            await fsPromises.access(tempDir, fs.constants.W_OK);
        } catch {
            throw new Error(`Temp directory ${tempDir} is not writable`);
        }

        // Copy NSIS script to temp directory
        const nsisScriptSrc = path.join(__dirname, 'silentinstallers', `${firstSelectedAppId}silentinstaller.nsi`);
        const nsisScriptDest = path.resolve(tempDir, nsisScriptSrc);  // Full absolute path to script
        const exePath = path.resolve(tempDir, exeName);               // Full absolute path to output EXE
        await fsPromises.copyFile(nsisScriptSrc, nsisScriptDest);

        // Replace OutFile with absolute path
        let nsisScriptContent = await fsPromises.readFile(nsisScriptDest, 'utf8');
        if (nsisScriptContent.includes('OutFile ')) {
            nsisScriptContent = nsisScriptContent.replace(
                /^OutFile\s+.*$/m,
                `OutFile "${exePath.replace(/\\/g, '\\\\')}"`
            );
        } else {
            // If OutFile line doesn't exist, add it at the top
            nsisScriptContent = `OutFile "${exePath.replace(/\\/g, '\\\\')}"
${nsisScriptContent}`;
        }

        // Check if local installer exists
        let localInstallerExists = false;
        try {
            await fsPromises.access(localInstallerPath, fs.constants.R_OK);
            localInstallerExists = true;
            console.log(`Found local installer at ${localInstallerPath}`);
        } catch (error) {
            console.warn(`Local installer not found at ${localInstallerPath}. Will use online download.`);
        }

        // If local installer exists, modify NSIS script to use it instead of downloading
        if (localInstallerExists) {
            // Copy local installer to temp directory
            const localInstallerDest = path.join(tempDir, 'downloads', installerFileName);
            
            // Create downloads directory in temp
            await fsPromises.mkdir(path.join(tempDir, 'downloads'), { recursive: true });
            
            // Copy the local installer
            await fsPromises.copyFile(localInstallerPath, localInstallerDest);
            
            // Check for different variants of download code in NSIS scripts
            const downloadPatterns = [
                // Standard inetc::get pattern
                {
                    regex: /inetc::get\s+"[^"]+"\s+"(\$INSTDIR\\downloads\\[^"]+)"/g,
                    replacement: `File "/oname=$1" "${localInstallerDest.replace(/\\/g, '\\\\')}"`
                },
                // NSISdl::download pattern
                {
                    regex: /NSISdl::download\s+"[^"]+"\s+"(\$INSTDIR\\downloads\\[^"]+)"/g,
                    replacement: `File "/oname=$1" "${localInstallerDest.replace(/\\/g, '\\\\')}"`
                },
                // Remove download check - if download failed blocks
                {
                    regex: /(\s*)(Pop\s+\$\d+)(\s*\${If}\s+\$\d+\s+==\s+"OK")/g,
                    replacement: '$1$2$3\n$1DetailPrint "Using pre-downloaded installer."'
                }
            ];
            
            // Apply all replacement patterns
            for (const pattern of downloadPatterns) {
                nsisScriptContent = nsisScriptContent.replace(pattern.regex, pattern.replacement);
            }
            
            // If the script uses a specific installer filename, ensure it's using our local copy
            nsisScriptContent = nsisScriptContent.replace(
                /ExecWait\s+['"](\$INSTDIR\\downloads\\)[^'"]+\.exe\s+(.+?)['"]/g,
                `ExecWait '"$1${installerFileName} $2"'`
            );
            
            console.log('Modified NSIS script to use local installer file');
        }

        await fsPromises.writeFile(nsisScriptDest, nsisScriptContent, 'utf8');

        // Before running makensis
        console.log('Full NSIS script path:', nsisScriptDest);
        console.log('Full output EXE path:', exePath);
        console.log('NSIS script content:', nsisScriptContent);

        // Run makensis with full path to script
        const makensisCmd = `makensis -V4 -NOCD -DOUTPUT_FILE="${exePath}" "${nsisScriptDest}"`;
        console.log('Running makensis command:', makensisCmd);
        const { stdout, stderr } = await exec(makensisCmd);
        console.log('makensis stdout:', stdout);
        if (stderr) console.error('makensis stderr:', stderr);

        // Check if EXE was created
        try {
            const exeStats = await fsPromises.stat(exePath);
            if (exeStats.size === 0) {
                throw new Error('EXE file was created but has zero size');
            }
            console.log(`EXE created successfully at ${exePath}, size: ${exeStats.size} bytes`);
        } catch (error) {
            console.error('EXE file not created or not accessible:', error);
            throw new Error('Failed to create installer EXE');
        }

        // Send EXE for download, then clean up
        res.download(exePath, exeName, (err) => {
            if (err) console.error('Download error:', err);
            setTimeout(() => {
                fsPromises.rm(tempDir, { recursive: true, force: true })
                    .catch(e => console.error('Cleanup error:', e));
            }, 100000); // added more
        });
    } catch (error) {
        console.error('Error generating installer:', error);
        res.status(500).send('Failed to generate installer: ' + error.message);
        // Clean up on error
        fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}
)

// Function to generate a multi-app installer
async function generateMultiAppInstaller(selectedApps, exeName, res) {
    // Create a unique temp directory
    const baseTempDir = '/var/tmp/stackdrop-installer';
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const tempDir = path.join(baseTempDir, uniqueId);
    const downloadsDir = path.join(tempDir, 'downloads');

    try {
        // Ensure directories exist
        await fsPromises.mkdir(baseTempDir, { recursive: true });
        await fsPromises.mkdir(tempDir, { recursive: true });
        await fsPromises.mkdir(downloadsDir, { recursive: true });

        // Check all installers exist before proceeding
        let missingApps = [];
        for (const appId of selectedApps) {
            const installerFileName = installerFileMap[appId] || `${appId}_installer.exe`;
            const localInstallerPath = path.join(__dirname, 'silentinstallers', installerFileName);
            try {
                await fsPromises.access(localInstallerPath, fs.constants.R_OK);
            } catch (error) {
                missingApps.push(appId);
            }
        }
        if (missingApps.length > 0) {
            return res.status(400).send('Cannot generate installer. The following apps are missing local installer files: ' + missingApps.join(', '));
        }

        // Create a combined NSIS script
        const combinedScriptPath = path.join(tempDir, 'combined_installer.nsi');
        const exePath = path.resolve(tempDir, exeName);

        // Start building the combined script
        let combinedScript = `
!include "MUI2.nsh"
!include "LogicLib.nsh"

; Essential definitions
Name "Stackdrop Multi-App Installer"
OutFile "${exePath.replace(/\\/g, '\\\\')}"
Unicode True
RequestExecutionLevel admin
InstallDir "$TEMP\\StackdropInstaller"

; Interface settings
!define MUI_ABORTWARNING
!define MUI_ICON "/usr/share/nsis/Contrib/Graphics/Icons/modern-install.ico"

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  CreateDirectory "$INSTDIR\\downloads"
`;

        // Add a call to each app's section from MainSection
        let appSections = '';
        let appSectionDefs = '';
        for (const appId of selectedApps) {
            const installerFileName = installerFileMap[appId] || `${appId}_installer.exe`;
            const localInstallerPath = path.join(__dirname, 'silentinstallers', installerFileName);
            const localInstallerDest = path.join(downloadsDir, installerFileName);
            // Copy local installer to temp downloads dir
            await fsPromises.copyFile(localInstallerPath, localInstallerDest);
            // Add call to app section
            appSections += `  Call Install_${appId}\n`;
            // Define app section (no download logic)
            appSectionDefs += `\nSection "+Install ${appId}" Install_${appId}\n  DetailPrint \"Installing ${appId}...\"\n  File \"/oname=$INSTDIR\\\\downloads\\\\${installerFileName}\" \"$INSTDIR\\downloads\\${installerFileName}\"\n  ExecWait '\"$INSTDIR\\downloads\\${installerFileName}\" /silent /install'\n  DetailPrint \"${appId} installation complete.\"\nSectionEnd\n`;
        }
        combinedScript += appSections;
        combinedScript += `\n  ; Cleanup downloaded files\n  RMDir /r "$INSTDIR\\downloads"\nSectionEnd\n`;
        combinedScript += appSectionDefs;

        // Write the combined script to file
        await fsPromises.writeFile(combinedScriptPath, combinedScript, 'utf8');

        // Run makensis to create the installer
        const makensisCmd = `makensis -V4 -NOCD "${combinedScriptPath}"`;
        console.log('Running makensis command:', makensisCmd);
        const { stdout, stderr } = await exec(makensisCmd);
        console.log('makensis stdout:', stdout);
        if (stderr) console.error('makensis stderr:', stderr);

        // Verify the EXE was created
        try {
            const exeStats = await fsPromises.stat(exePath);
            if (exeStats.size === 0) {
                throw new Error('EXE file was created but has zero size');
            }
            console.log(`Multi-app EXE created successfully at ${exePath}, size: ${exeStats.size} bytes`);
        } catch (error) {
            console.error('Multi-app EXE file not created or not accessible:', error);
            throw new Error('Failed to create multi-app installer EXE');
        }

        // Send EXE for download, then clean up
        res.download(exePath, exeName, (err) => {
            if (err) console.error('Download error:', err);
            setTimeout(() => {
                fsPromises.rm(tempDir, { recursive: true, force: true })
                    .catch(e => console.error('Cleanup error:', e));
            }, 100000);
        });
    } catch (error) {
        console.error('Error generating multi-app installer:', error);
        res.status(500).send('Failed to generate multi-app installer: ' + error.message);
        // Clean up on error
        fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
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