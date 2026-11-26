'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const engine = require('./engine');

const PORT = Number(process.env.REEL_PORT) || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function openFolder(target, res) {
  if (!target || typeof target !== 'string') return sendJson(res, 400, { error: 'No folder given' });
  const resolved = path.resolve(target);
  const root = path.resolve(engine.getStatus().root);
  const isUnderRoot = resolved === root || resolved.startsWith(root + path.sep);
  if (!isUnderRoot) return sendJson(res, 403, { error: 'Folder is outside the library root' });
  if (!fs.existsSync(resolved)) return sendJson(res, 404, { error: 'Folder does not exist' });
  const child = spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', err => sendJson(res, 500, { error: err.message }));
  child.unref();
  sendJson(res, 200, { ok: true });
}

// Windows Vista+ folder picker (IFileOpenDialog with FOS_PICKFOLDERS)
// the same "Choose a folder" sheet Explorer uses.
// Pure PowerShell COM interop via a temp .ps1 file (no C# compilation).
const FOLDER_PICKER_PS1 = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.InteropServices

$clsid = [Guid]'DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7'
$iidFileDialog = [Guid]'42f85136-db7e-439c-85f1-e4075d135fc8'
$iidShellItem = [Guid]'43826d1e-e718-42ee-bc55-a1e261c37bfe'
$SIGDN_FILESYSPATH = 0x80058000
$FOS_PICKFOLDERS = 0x00000020
$FOS_FORCEFILESYSTEM = 0x00000040
$FOS_PATHMUSTEXIST = 0x00000800

$dlg = [Activator]::CreateInstance([Type]::GetTypeFromCLSID($clsid))
$pdf = $dlg

$pdf.GetOptions([ref]$opts)
$pdf.SetOptions($opts -bor $FOS_PICKFOLDERS -bor $FOS_FORCEFILESYSTEM -bor $FOS_PATHMUSTEXIST)
$pdf.SetTitle('Choose where Snagly saves music')
$pdf.SetOkButtonLabel('Choose Folder')

if ('$initial' -and [IO.Directory]::Exists('$initial')) {
    $psi = $null
    $hr = [System.Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer(
        (Add-Type -MemberDefinition '
            [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
            public static extern void SHCreateItemFromParsingName(
                string pszPath, IntPtr pbc, ref Guid riid, out object ppv);
        ' -Name 'SH' -PassThru).GetMethod('SHCreateItemFromParsingName').MethodHandle.GetFunctionPointer(),
        [Func[string, IntPtr, [Guid].MakeByRefType(), [Object].MakeByRefType()]]
    ).Invoke('$initial', [IntPtr]::Zero, [ref]$iidShellItem, [ref]$psi)
    if ($hr -eq 0 -and $psi) { $pdf.SetFolder($psi) }
}

$hr = $pdf.Show([IntPtr]::Zero)
if ($hr -eq 0) {
    $result = $null
    $pdf.GetResult([ref]$result)
    $path = ''
    $result.GetDisplayName($SIGDN_FILESYSPATH, [ref]$path)
    $path
}
`;

function pickFolder(current, res) {
  // Simple fallback for non-Chromium: return null so UI shows "type a path"
  sendJson(res, 200, { path: null, error: 'Use a Chromium browser for the folder picker, or type a path manually' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    engine.addSSE(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, engine.getStatus());
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    try {
      engine.reconcileLibrary();
      return sendJson(res, 200, {
        jobs: engine.publicJobs(),
        status: engine.getStatus()
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/preview') {
    const body = await readBody(req);
    const urls = (Array.isArray(body.urls) ? body.urls : [body.url])
      .map(u => String(u || '').trim())
      .filter(u => /youtube\.com|youtu\.be/i.test(u));
    if (!urls.length) return sendJson(res, 400, { error: 'Paste at least one YouTube link' });
    try {
      return sendJson(res, 200, await engine.previewSources(urls));
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/probe') {
    const body = await readBody(req);
    const url = String(body.url || '').trim();
    if (!/youtube\.com|youtu\.be/i.test(url)) return sendJson(res, 400, { error: 'A YouTube link is required' });
    try {
      return sendJson(res, 200, { formats: await engine.probeFormats(url) });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    const body = await readBody(req);
    const rawItems = Array.isArray(body.items) ? body.items : (Array.isArray(body.urls) ? body.urls : [body.url]);
    const items = rawItems
      .map(item => {
        const obj = typeof item === 'string' ? { url: item } : item;
        return { url: String(obj?.url || '').trim(), selected: Array.isArray(obj?.selected) ? obj.selected : null };
      })
      .filter(item => /youtube\.com|youtu\.be/i.test(item.url));
    if (!items.length) return sendJson(res, 400, { error: 'Paste at least one YouTube link' });
    try {
      const result = await engine.createJobs(items, {
        root: body.root,
        collection: body.collection,
        format: body.format,
        isVideo: body.isVideo
      });
      return sendJson(res, 201, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname.startsWith('/api/jobs/') && pathname.endsWith('/retry')) {
    const id = pathname.split('/')[3];
    try {
      const count = engine.retryJob(id);
      if (count === false) return sendJson(res, 404, { error: 'Job not found' });
      return sendJson(res, 200, { retried: count });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/jobs/')) {
    const id = pathname.split('/')[3];
    try {
      const ok = engine.removeJob(id);
      if (!ok) return sendJson(res, 409, { error: 'Job is still downloading. Cancel it first' });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname.startsWith('/api/jobs/') && pathname.endsWith('/cancel')) {
    const id = pathname.split('/')[3];
    try {
      const count = engine.cancelJob(id);
      if (count === false) return sendJson(res, 404, { error: 'Job not found' });
      return sendJson(res, 200, { cancelled: count });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/history') {
    try {
      return sendJson(res, 200, { history: engine.getHistory() });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/cache/clear') {
    try {
      const removed = engine.clearCache();
      return sendJson(res, 200, { removed });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/pause') {
    const body = await readBody(req);
    engine.setPaused(body.paused);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    if (body.workers !== undefined) engine.setWorkers(body.workers);
    if (body.useCookies !== undefined) engine.setUseCookies(body.useCookies);
    if (body.isVideo !== undefined) engine.setIsVideo(body.isVideo);
    return sendJson(res, 200, engine.getStatus());
  }

  if (req.method === 'POST' && pathname === '/api/open') {
    const body = await readBody(req);
    return openFolder(body.path, res);
  }

  if (req.method === 'POST' && pathname === '/api/browse') {
    const body = await readBody(req);
    return pickFolder(body.path, res);
  }

  if (req.method === 'GET' && pathname === '/api/formats') {
    return sendJson(res, 200, { formats: engine.formats() });
  }

  if (req.method === 'GET' && pathname === '/api/video-formats') {
    return sendJson(res, 200, { formats: engine.videoFormats() });
  }

  if (req.method === 'POST' && pathname === '/api/tags/edit') {
    const body = await readBody(req);
    const { file, tags } = body;
    if (!file || typeof tags !== 'object') {
      return sendJson(res, 400, { error: 'File and tags required' });
    }
    try {
      engine.editTags(file, tags);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  return sendJson(res, 405, { error: 'Method not allowed' });
});

engine.init();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Snagly is running at http://localhost:${PORT}`);
  console.log(`  Library root: ${engine.getStatus().root}`);
  console.log('  Press Ctrl+C to stop.\n');
});

process.on('SIGINT', () => { engine.saveStateNow(); process.exit(0); });
process.on('SIGTERM', () => { engine.saveStateNow(); process.exit(0); });
