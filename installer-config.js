/**
 * Single source of truth for Stackdrop installer filenames, silent flags,
 * and install methods. Used by app.js, update-checker.js, test-downloads.js.
 */

const INSTALLER_FILENAMES = {
    chrome64: 'ChromeSetup64.exe',
    firefox64: 'firefox_installer.exe',
    edge: 'EdgeInstaller.msi',
    opera64: 'Opera_119.0.5497.56_Setup_x64.exe',
    tor: 'tor_installer.exe',
    zoom: 'zoom_installer.exe',
    discord: 'discord_installer.exe',
    teams: 'teams_installer.exe',
    skype: 'skype_installer.exe',
    slack: 'slack_installer.exe',
    vlc: 'vlc_installer.exe',
    itunes: 'itunes_installer.exe',
    winamp: 'winamp_installer.exe',
    spotify: 'spotify_installer.exe',
    aimp: 'aimp_installer.exe',
    foobar2000: 'foobar2000_installer.exe',
    musicbee: 'musicbee_installer.exe',
    audacity: 'audacity_installer.exe',
    klitecodecs: 'klitecodecs_installer.exe',
    gom: 'gom_installer.exe',
    cccp: 'Combined-Community-Codec-Pack-64bit-2015-10-18.exe',
    mediamonkey: 'mediamonkey_installer.exe',
    handbrake: 'handbrake_installer.exe',
    malwarebytes: 'malwarebytes_installer.exe',
    avast: 'avast_installer.exe',
    avg: 'avg_installer.exe',
    spybot2: 'spybot2_installer.exe',
    avira: 'avira_installer.exe',
    superantispyware: 'superantispyware_installer.exe',
    dropbox: 'dropbox_installer.exe',
    googledrive: 'googledrive_installer.exe',
    onedrive: 'onedrive_installer.exe',
    ccleaner: 'ccleaner_installer.exe',
    teamviewer: 'teamviewer_installer.exe',
    anydesk: 'anydesk_installer.exe',
    imgburn: 'imgburn_installer.exe',
    thinkorswim: 'thinkorswim_x64_installer.exe',
    revo: 'revosetup.exe',
    windirstat: 'windirstat_installer.msi',
    spacemonger: 'spacemonger_installer.exe',
    registryworkshop: 'RegistryWorkshop.exe',
    notepadplusplus: 'notepadplusplus_installer.exe',
    filezilla: 'filezilla_installer.exe',
    vscode: 'vscode_installer.exe',
    cursor: 'CursorSetup.exe',
    androidstudio: 'android-studio-windows.exe',
    libreoffice: 'libreoffice_installer.exe',
    openoffice: 'openoffice_installer.exe',
    foxitreader: 'foxitreader_installer.exe',
    gimp: 'gimp_installer.exe',
    blender: 'blender_installer.exe',
    krita: 'krita_installer.exe',
    brave: 'BraveBrowserSetup.exe',
    pidgin: 'pidgin_installer.exe',
    thunderbird: 'ThunderbirdSetup.exe',
    emclient: 'emclient.msi',
    trillian: 'trillian_installer.exe',
    sumatrapdf: 'SumatraPDF-64-install.exe',
    cutepdf: 'CuteWriter.exe',
    qbittorrent: 'qbittorrent_x64_setup.exe',
    transmission: 'transmission_installer.msi',
    deluge: 'deluge_installer.exe',
    biglybt: 'biglybt_installer.exe',
    '7zip': '7zip_x64.exe',
    peazip: 'peazip_WIN64.exe',
    winrar: 'winrar-x64.exe',
    epicgames: 'EpicGamesLauncherInstaller.msi',
    bluestacks: 'bluestacks_installer.exe',
    everything: 'Everything-x64-Setup.exe',
    nvaccess: 'nvda_setup.exe',
    irfanview: 'iview64_setup.exe',
    xnview: 'XnViewMP-win-x64.exe',
    inkscape: 'inkscape-x64.exe',
    faststone: 'FSViewerSetup.exe',
    greenshot: 'Greenshot-INSTALLER-RELEASE.exe',
    sharex: 'ShareX-Setup.exe',
    rufus: 'rufus-4.14.exe',
    ollama: 'OllamaSetup.exe',
    claudedesktop: 'Claude-Setup-x64.exe',
    lmstudio: 'LM-Studio-0.4.16-2-x64.exe',
    jan: 'Jan_0.8.3_x64-setup.exe',
    gpt4all: 'gpt4all-installer-win64.exe',
    steam: 'SteamSetup.exe',
    win11_iso: 'Win11_24H2_English_x64.iso',
    win10_iso: 'Win10_22H2_English_x64.iso',
    ubuntu_iso: 'ubuntu-24.04.3-desktop-amd64.iso',
    paintnet: 'paint.net.install.x64.zip',
    obs: 'obs_installer.exe',
    qemu: 'qemu-w64-setup-20250826.exe',
    dotnet481: 'dotnetfx481_x64.exe',
    dotnet481x86: 'dotnetfx481_x86.exe',
    dotnet9: 'dotnet-runtime-9.0-win-x64.exe',
    dotnet9x86: 'dotnet-runtime-9.0-win-x86.exe',
    dotnet9desktop: 'dotnet-desktop-runtime-9.0-win-x64.exe',
    dotnet9desktopx86: 'dotnet-desktop-runtime-9.0-win-x86.exe',
    jdk26x64: 'jdk-26_windows-x64_bin.exe',
    jdk21x64: 'jdk-21_windows-x64_bin.exe',
    python315x64: 'python-3.15.0-amd64.exe',
    python315x86: 'python-3.15.0.exe',
    chrometransparency: 'ChromeTransparency.exe',
    golang: 'go_windows_amd64.msi',
    tightvnc: 'tightvnc-2.8.85-gpl-setup-64bit.msi',
    keepass2: 'KeePass-Setup.exe',
    evernote: 'EvernoteSetup.exe',
    googleearth: 'googleearthprowin.exe',
    qtemu: 'qtemu_installer.exe',
    realvncserver: 'VNC-Server-7.12.1-Windows.exe',
    realvncviewer: 'VNC-Viewer-7.12.1-Windows.exe',
    tdmgcc: 'tdmgcc_installer.exe',
    ubuntu_usb: 'ubuntu_usb_installer.exe',
    'vcredist2015-2022x64': 'vc_redist.x64.exe',
    'vcredist2015-2022x86': 'vc_redist.x86.exe',
    duckduckgo: 'DuckDuckGo_Setup.exe',
    winsockfix: 'winsockfix.exe',
    // Ninite parity additions (2026-10-02)
    vivaldi: 'Vivaldi-x64-Setup.exe',
    sugarsync: 'SugarSyncSetup.exe',
    wireshark: 'Wireshark-x64-Setup.exe',
    powertoys: 'PowerToysSetup-x64.exe',
    teracopy: 'teracopy.exe',
    cdburnerxp: 'cdburnerxp_x64_setup.exe',
    infrarecorder: 'infrarecorder_x64.msi',
    launchy: 'Launchy-Setup.exe',
    wiztree: 'wiztree_setup.exe',
    glary: 'gusetup.exe',
    openshell: 'OpenShellSetup.exe',
    gitscm: 'Git-64-bit-Setup.exe',
    winscp: 'WinSCP-Setup.exe',
    putty: 'putty-64bit-installer.msi',
    winmerge: 'WinMerge-x64-Setup.exe',
    eclipse: 'eclipse-inst-jre-win64.exe',
    bambustudio: 'Bambu_Studio_win-Setup.exe',
    ultimakercura: 'UltiMaker-Cura-win64-X64.msi',
    dotnet10: 'dotnet-runtime-10.0-win-x64.exe',
    dotnet10desktop: 'dotnet-desktop-runtime-10.0-win-x64.exe',
    temurin25x64: 'OpenJDK25U-jdk_x64_windows_hotspot.msi',
    // Hidden helper: official Npcap installer, run interactively after Wireshark
    npcap: 'npcap-setup.exe',
    // Added 2026-10-02 (pass e)
    signal: 'signal-desktop-win-x64.exe',
    telegram: 'tsetup-x64.exe',
    bitwarden: 'Bitwarden-Installer.exe',
    mpchc: 'MPC-HC.x64.exe',
    potplayer: 'PotPlayerSetup64.exe',
    obsidian: 'Obsidian-Setup.exe',
    joplin: 'Joplin-Setup.exe',
    calibre: 'calibre-64bit.msi',
    crystaldiskinfo: 'CrystalDiskInfo-Setup.exe',
    notepad3: 'Notepad3_x64_Setup.exe',
};

// Extra download filenames to try when canonical name is missing on server
const INSTALLER_CANDIDATE_EXTRAS = {
    chrome64: ['chrome_installer.exe', 'ChromeSetup.exe'],
    opera64: ['opera_installer.exe', 'Opera_119.0.5497.56_Setup_x64.exe'],
    winrar: ['winrar-x64.exe', 'winrar-x64-713.exe', 'winrar_installer.exe'],
    cursor: ['cursor_installer.exe', 'CursorSetup.exe'],
    vscode: ['vscode_installer.exe', 'VSCodeSetup-x64.exe'],
    obs: ['OBS-Studio-32.1.2-Windows-x64-Installer.exe', 'OBS-Studio-31.0-Full-Installer.exe'],
    qemu: ['qemu_installer.exe', 'qemu-w64-setup-20250826.exe'],
    paintnet: ['paint.net.5.0.10.install.zip'],
    epicgames: ['epicgames_installer.exe', 'EpicGamesLauncherInstaller.msi'],
    blender: ['blender_installer.exe'],
    libreoffice: ['libreoffice_installer.exe', 'LibreOffice_26.2.2_Win_x86-64.msi'],
    zoom: ['zoom_installer.exe', 'ZoomInstallerFull.msi'],
    transmission: ['transmission_installer.msi', 'transmission_installer.exe'],
    '7zip': ['7z_installer.exe', '7zip_x64.exe', '7z2601-x64.exe', '7z2408-x64.exe'],
    peazip: ['peazip_installer.exe', 'peazip_WIN64.exe'],
    steam: ['steam_installer.exe', 'SteamSetup.exe'],
    sumatrapdf: ['sumatrapdf_installer.exe', 'SumatraPDF-64-install.exe'],
    cutepdf: ['cutepdf_installer.exe', 'CuteWriter.exe'],
    irfanview: ['irfanview_installer.exe', 'iview64_setup.exe'],
    xnview: ['xnview_installer.exe', 'XnViewMP-win-x64.exe'],
    inkscape: ['inkscape_installer.exe', 'inkscape-x64.exe'],
    faststone: ['faststone_installer.exe', 'FSViewerSetup.exe'],
    greenshot: ['greenshot_installer.exe', 'Greenshot-INSTALLER-RELEASE.exe'],
    sharex: ['sharex_installer.exe', 'ShareX-Setup.exe'],
    cccp: ['cccp_installer.exe', 'cccp-new-setup.exe', 'Combined-Community-Codec-Pack-64bit-2015-10-18.exe'],
    ollama: ['ollama_installer.exe', 'OllamaSetup.exe'],
    lmstudio: ['lmstudio_installer.exe', 'LM-Studio-0.3.5-Setup.exe', 'LM-Studio-0.4.16-2-x64.exe'],
    jan: ['jan_installer.exe', 'jan-win-x64-2.2.4.exe', 'Jan_0.8.3_x64-setup.exe'],
    gpt4all: ['gpt4all_installer.exe', 'gpt4all-installer-win64.exe'],
    emclient: ['setup.msi', 'emclient.msi'],
    androidstudio: ['androidstudio_installer.exe', 'android-studio-windows.exe'],
    qbittorrent: ['qbittorrent_installer.exe', 'qbittorrent_x64_setup.exe'],
    googledrive: ['googledrive_installer.exe', 'GoogleDriveSetup.exe'],
    googleearth: ['googleearthprowin.exe', 'googleearthprowin-x64.exe'],
    rufus: ['rufus_installer.exe', 'rufus-4.14.exe', 'rufus-4.14p.exe', 'rufus-4.11p.exe'],
    winsockfix: ['winsockfix_installer.exe', 'winsockfix.exe', 'WinSockFix.exe'],
};

// Apps that must use msiexec even when stored with .exe symlink
const MSI_APP_IDS = new Set([
    'edge', 'windirstat', 'transmission', 'epicgames', 'zoom', 'libreoffice', 'blender',
    'golang', 'tightvnc', 'audacity',
]);

// install method: exe | msi | open_url | copy_exe | copy_portable | unzip_exe | download_only | download_shortcuts
const INSTALL_METHODS = {
    spacemonger: 'copy_exe',
    rufus: 'download_shortcuts',
    // Microsoft only serves Windows ISOs through its interactive download page
    win11_iso: 'download_only',   // server-hosted ISO -> %USERPROFILE%\\Downloads
    win10_iso: 'download_only',
    ubuntu_iso: 'download_only',
    paintnet: 'unzip_exe',
    chrometransparency: 'copy_exe',
    winsockfix: 'copy_exe',
    // Eclipse installer has no unattended mode: save it to the Downloads folder
    eclipse: 'download_only',
};

const INNO_SILENT = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-';

const SILENT_FLAGS = {
    chrome64: '/silent /install',
    firefox64: '/S',
    edge: '/qn',
    opera64: '/silent /install /launchopera=0 /setdefaultbrowser=0 /allusers=1',
    tor: '/S',
    zoom: '/quiet /qn /norestart',
    discord: '--silent',  // Squirrel
    teams: '-p',  // teamsbootstrapper.exe: provision new Teams for all users
    slack: '--silent',  // Squirrel
    vlc: '/L=1033 /S',
    itunes: '/qn /norestart',
    winamp: '/S',
    spotify: '/silent',
    aimp: '/AUTO /SILENT',
    foobar2000: '/S',
    musicbee: '/S',
    audacity: '/qn /norestart',  // official x64 MSI
    klitecodecs: '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES',
    gom: '/S',
    cccp: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-',
    mediamonkey: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-',
    handbrake: '/S',
    malwarebytes: '/VERYSILENT /NORESTART',
    avast: '/silent',
    avg: '/SILENT /NORESTART',
    spybot2: INNO_SILENT,
    avira: '/SILENT /NORESTART',
    superantispyware: INNO_SILENT,
    dropbox: '/S',
    googledrive: '--silent',
    // Official silent switch for Google Earth Pro offline installer
    googleearth: 'OMAHA=1 DESKTOPSHORTCUT=0',
    onedrive: '/silent /allusers',
    ccleaner: '/S',
    teamviewer: '/S',
    anydesk: '--install "$PROGRAMFILES32\\AnyDesk" --start-with-win --create-shortcuts --silent',
    imgburn: '/S',
    // install4j (not Inno): /VERYSILENT is ignored and shows Language Selection
    thinkorswim: '-q -Dinstall4j.language=en -overwrite',
    biglybt: '-q -Dinstall4j.language=en -overwrite',
    revo: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-',
    windirstat: '/quiet /norestart',
    spacemonger: 'COPY_EXE',
    registryworkshop: '/S',
    winsockfix: 'COPY_EXE',
    notepadplusplus: '/S',
    filezilla: '/S',
    vscode: '/verysilent /mergetasks=!runcode',
    libreoffice: '/qn /norestart',
    openoffice: '/S',
    gimp: '/VERYSILENT /NORESTART',
    blender: '/quiet /norestart',
    krita: '/S',
    qemu: '/S',
    obs: '/S',
    cursor: '/verysilent /mergetasks=!runcode',
    paintnet: '/auto',
    irfanview: '/silent /allusers=1 /group=1 /desktop=0',
    xnview: INNO_SILENT,
    inkscape: '/S',
    faststone: '/S',
    greenshot: '/VERYSILENT /NORESTART /ALLUSERS /NORUN',
    sharex: '/SP- /VERYSILENT /NORESTART /NORUN',
    thunderbird: '/S',
    emclient: '/qn MAILCLIENT_ASSOCIATE=0 MAILCLIENT_LAUNCH=0',
    steam: '/S',
    epicgames: '/quiet /norestart',
    bluestacks: '--silent',
    '7zip': '/S',
    peazip: INNO_SILENT,
    winrar: '/S',
    foxitreader: '/quiet /norestart',  // usage text inside the Foxit EXE: "/quiet  Silent installation"
    sumatrapdf: '-s -all-users',
    cutepdf: INNO_SILENT,
    // Squirrel.Windows — Inno /VERYSILENT does nothing
    claudedesktop: '--silent',
    ollama: INNO_SILENT,
    lmstudio: '/S',
    jan: '/S',
    // Qt Installer Framework — not Inno
    gpt4all: 'install --accept-licenses --default-answer --confirm-command',
    qbittorrent: '/S',
    transmission: '/quiet /norestart',
    deluge: '/S',
    androidstudio: '/S',
    golang: '/qn /norestart',
    tightvnc: '/qn /norestart',
    dotnet481: '/q /norestart',
    dotnet481x86: '/q /norestart',
    dotnet9: '/install /quiet /norestart',
    dotnet9x86: '/install /quiet /norestart',
    dotnet9desktop: '/install /quiet /norestart',
    dotnet9desktopx86: '/install /quiet /norestart',
    jdk26x64: '/s',
    jdk21x64: '/s',
    python315x64: '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0',
    python315x86: '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0',
    'vcredist2015-2022x64': '/install /quiet /norestart',
    'vcredist2015-2022x86': '/install /quiet /norestart',
    rufus: '',
    win11_iso: '',
    win10_iso: '',
    ubuntu_iso: '',
    // Ninite parity additions (2026-10-02)
    brave: '/silent /install',
    vivaldi: '--vivaldi-silent --do-not-launch-chrome --system-level',
    pidgin: '/S',
    trillian: '/S',
    sugarsync: '/S',
    wireshark: '/S',
    powertoys: '/quiet /norestart',
    teracopy: '/exenoui /qn /norestart',
    cdburnerxp: INNO_SILENT,
    infrarecorder: '/qn /norestart',
    launchy: INNO_SILENT,
    wiztree: INNO_SILENT,
    glary: '/S',
    openshell: '/qn ADDLOCAL=StartMenu',
    everything: '/S',
    keepass2: INNO_SILENT,
    evernote: '/S',
    nvaccess: '--install-silent',
    gitscm: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS',
    winscp: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /ALLUSERS',
    putty: '/qn /norestart',
    winmerge: INNO_SILENT,
    eclipse: '',
    bambustudio: '/S',
    ultimakercura: '/qn /norestart',
    dotnet10: '/install /quiet /norestart',
    dotnet10desktop: '/install /quiet /norestart',
    temurin25x64: '/qn /norestart ADDLOCAL=FeatureMain,FeatureEnvironment,FeatureJarFileRunWith,FeatureJavaHome',
    // Npcap free edition has no silent mode: always run interactively (no flags)
    npcap: '',
    // Added 2026-10-02 (pass e)
    signal: '/S',                 // electron-builder NSIS
    telegram: INNO_SILENT,        // Inno Setup
    bitwarden: '/allusers /S',    // electron-builder NSIS (web package)
    mpchc: INNO_SILENT,
    potplayer: '/S',              // NSIS
    obsidian: '/S',               // electron-builder NSIS
    joplin: '/S',                 // electron-builder NSIS
    calibre: '/qn /norestart',   // official x64 MSI
    crystaldiskinfo: INNO_SILENT,
    notepad3: INNO_SILENT,
};

const PORTABLE_FOLDERS = {
    spacemonger: 'SpaceMonger',
    rufus: 'Rufus',
    chrometransparency: 'ChromeTransparency',
    winsockfix: 'WinSockFix',
};

const PORTABLE_EXE_NAMES = {
    spacemonger: 'SpaceMonger.exe',
    rufus: 'Rufus.exe',
    chrometransparency: 'ChromeTransparency.exe',
    winsockfix: 'WinSockFix.exe',
};

function getInstallerFileName(appId) {
    return INSTALLER_FILENAMES[appId] || `${appId}_installer.exe`;
}

function getInstallerCandidates(appId) {
    const primary = getInstallerFileName(appId);
    const extras = INSTALLER_CANDIDATE_EXTRAS[appId] || [];
    const legacy = `${appId}_installer.exe`;
    const all = [primary, legacy, ...extras];
    const unique = [...new Set(all.filter(Boolean))];
    return { x64: unique, x86: unique };
}

function getSilentFlag(appId) {
    // An explicit '' means "no flags" (interactive / not executed); unknown apps default to /S
    return Object.prototype.hasOwnProperty.call(SILENT_FLAGS, appId) ? SILENT_FLAGS[appId] : '/S';
}

function getInstallMethod(appId) {
    if (INSTALL_METHODS[appId]) return INSTALL_METHODS[appId];
    if (MSI_APP_IDS.has(appId)) return 'msi';
    const fname = getInstallerFileName(appId).toLowerCase();
    if (fname.endsWith('.msi')) return 'msi';
    return 'exe';
}

function isMsiApp(appId) {
    return getInstallMethod(appId) === 'msi';
}

function getPortableFolder(appId) {
    return PORTABLE_FOLDERS[appId] || null;
}

function getPortableExeName(appId) {
    return PORTABLE_EXE_NAMES[appId] || null;
}

module.exports = {
    INSTALLER_FILENAMES,
    INSTALLER_CANDIDATE_EXTRAS,
    MSI_APP_IDS,
    INSTALL_METHODS,
    SILENT_FLAGS,
    getInstallerFileName,
    getInstallerCandidates,
    getSilentFlag,
    getInstallMethod,
    isMsiApp,
    getPortableFolder,
    getPortableExeName,
};
