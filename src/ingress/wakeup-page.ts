/**
 * The pages the ingress serves when a subdomain has no live sandbox behind it.
 *
 * Self-contained by necessity: the proxy has no view engine, no static asset
 * directory and no way to reach one — it answers on the sandbox's own hostname,
 * so any external reference would be a request to the sandbox itself. Styles
 * and script are inline, and there are no images or fonts.
 *
 * Pure string builders, so the markup is unit-testable without a server.
 */

const STATUS_PATH = '/__devic/status';

/** Escape text interpolated into HTML. Messages can carry daemon output. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BASE_STYLE = `
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;
    justify-content:center;padding:24px;
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    background:#fff;color:#1f2328}
  main{max-width:30rem;text-align:center}
  h1{margin:0 0 .5rem;font-size:1.15rem;font-weight:600}
  p{margin:0 0 .75rem;color:#59636e}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;
    background:#f6f8fa;padding:.15em .4em;border-radius:4px}
  .spinner{width:26px;height:26px;margin:0 auto 1.25rem;border-radius:50%;
    border:2.5px solid #d0d7de;border-top-color:#1f2328;
    animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .detail{font-size:.85rem;color:#818b98}
  .err{white-space:pre-wrap;text-align:left;background:#f6f8fa;border-radius:6px;
    padding:.6rem .75rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:.8rem;color:#59636e;margin-top:1rem}
  @media (prefers-color-scheme:dark){
    body{background:#0d1117;color:#e6edf3}
    p{color:#9198a1}
    code,.err{background:#151b23;color:#9198a1}
    .spinner{border-color:#2a313c;border-top-color:#e6edf3}
  }
`;

function shell(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

/**
 * Shown while a snapshot is being restored. Polls instead of holding the
 * request open: the edge (Cloudflare) cuts a response that takes ~100s, and a
 * cold restore from a tarball can exceed that.
 */
export function waitingPage(opts: {
  timeoutSeconds: number;
  pollIntervalMs?: number;
}): string {
  const poll = opts.pollIntervalMs ?? 1500;
  const script = `
(function(){
  var deadline = Date.now() + ${opts.timeoutSeconds * 1000};
  var el = document.getElementById('detail');
  function fail(msg){
    document.getElementById('spin').style.display='none';
    document.getElementById('title').textContent='The sandbox is up, but nothing is serving';
    document.getElementById('lead').textContent =
      'The files were restored and the sandbox is running, but no process is ' +
      'listening on its HTTP port. Start the service from Devic and reload ' +
      'this page.';
    el.textContent = msg || '';
  }
  function tick(){
    fetch(${JSON.stringify(STATUS_PATH)},{cache:'no-store'})
      .then(function(r){return r.json()})
      .then(function(s){
        if(s.state==='ready'){ location.reload(); return; }
        if(s.state==='error'){ fail(s.message); return; }
        if(Date.now()>deadline){ fail('Timed out after ${opts.timeoutSeconds}s.'); return; }
        if(typeof s.elapsedSeconds==='number' && s.elapsedSeconds>3){
          el.textContent = s.elapsedSeconds + 's';
        }
        setTimeout(tick, ${poll});
      })
      .catch(function(){ setTimeout(tick, ${poll}); });
  }
  setTimeout(tick, ${poll});
})();`;

  return shell(
    'Starting sandbox…',
    `<div class="spinner" id="spin"></div>
<h1 id="title">Starting this sandbox</h1>
<p id="lead">It was stopped, so it is being restored from its latest snapshot. This page reloads as soon as something answers on its HTTP port.</p>
<p class="detail" id="detail"></p>`,
    script,
  );
}

/** Shown when the snapshot exists but its owner turned auto-restart off. */
export function disabledPage(): string {
  return shell(
    'Sandbox stopped',
    `<h1>This sandbox is stopped</h1>
<p>Automatic restart is turned off for it, so visiting this address will not start it. Start it from Devic and the URL will work again.</p>`,
  );
}

/** Shown when nothing at all answers to this subdomain. */
export function notFoundPage(): string {
  return shell(
    'Not found',
    `<h1>Nothing is served here</h1>
<p>This address does not match any sandbox or snapshot.</p>`,
  );
}

/** Shown when a wake-up already failed, so the visitor is not left spinning. */
export function errorPage(message: string): string {
  return shell(
    'Sandbox failed to start',
    `<h1>This sandbox could not be started</h1>
<p>Restoring it from its snapshot failed. Trying again in a moment may work.</p>
${message ? `<div class="err">${esc(message)}</div>` : ''}`,
  );
}

export { STATUS_PATH };
