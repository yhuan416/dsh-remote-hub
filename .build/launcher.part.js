export function launcherPage(hosts) {
  const items = hosts.map(function (host) {
    return '<li><a href="/remotes/' + encodeURIComponent(host.id) + '/">' + escapeHtml(host.label) + '</a>' +
      '<span class="muted"> ' + escapeHtml(host.id) + '</span></li>'
  }).join('')
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>DSH remotes</title><style>' +
    'html,body{margin:0;min-height:100%;font:13px/1.6 system-ui,sans-serif;background:#151517;color:#ddd}' +
    'main{max-width:640px;margin:0 auto;padding:32px 20px}' +
    'h1{font-size:16px;margin:0 0 6px}' +
    'p{color:#999;margin:0 0 14px}' +
    'ul{padding-left:18px;margin:0 0 18px}' +
    'li{margin:6px 0}' +
    'a{color:#8ab4f8;text-decoration:none}a:hover{text-decoration:underline}' +
    '.muted{color:#888;font-size:12px}' +
    '</style></head><body><main>' +
    '<p class="muted">dsh-remote-hub</p>' +
    '<h1>远端入口（兜底页）</h1>' +
    '<p>日常切换用顶栏；远端管理在「设置 → 插件 → dsh-remote-hub」。本页仅在顶栏不可用时使用。</p>' +
    '<ul>' + (items === '' ? '<li class="muted">还没有配置远端。</li>' : items) + '</ul>' +
    '<p><a href="/">&larr; 回到本机</a></p>' +
    '<p><a href="/remotes/_status">诊断 JSON</a></p>' +
    '</main></body></html>'
}