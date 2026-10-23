(() => {
  const $ = (id) => document.getElementById(id);
  const files = {}; // name -> File
  const drops = [...document.querySelectorAll('.drop')];

  function setFile(name, file) {
    const el = drops.find((d) => d.dataset.name === name);
    if (!el) return;
    files[name] = file;
    el.classList.add('has-file');
    el.querySelector('small').textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`;
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      el.style.backgroundImage = `url("${url}")`;
    }
    if (name === 'config.json') {
      file.text().then((t) => {
        try {
          const c = JSON.parse(t);
          if (c.title && !$('title').value) $('title').value = c.title;
          if (c.size_mm?.width && !$('width').value) $('width').value = c.size_mm.width;
          if (c.size_mm?.height && !$('height').value) $('height').value = c.size_mm.height;
        } catch { status('config.json を解析できませんでした', true); }
      });
    }
  }

  function guessName(file) {
    const n = file.name.toLowerCase();
    if (n.endsWith('.json')) return 'config.json';
    if (n.includes('height') || n.includes('depth') || n.includes('hight') || n.includes('disp')) return 'heightmap.png';
    for (const k of ['original', 'base', 'texture', 'color', 'varnish']) if (n.includes(k)) return `${k}.png`;
    return null;
  }

  drops.forEach((d) => {
    const input = d.querySelector('input');
    input.addEventListener('change', () => { if (input.files[0]) setFile(d.dataset.name, input.files[0]); });
    d.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); d.classList.add('is-over'); });
    d.addEventListener('dragleave', () => d.classList.remove('is-over'));
    d.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); d.classList.remove('is-over');
      const list = [...e.dataTransfer.files];
      if (list.length === 1) setFile(d.dataset.name, list[0]);
      else list.forEach((f) => { const n = guessName(f); if (n) setFile(n, f); });
    });
  });

  const area = $('dropArea');
  area.addEventListener('dragover', (e) => e.preventDefault());
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    const unknown = [];
    [...e.dataTransfer.files].forEach((f) => { const n = guessName(f); n ? setFile(n, f) : unknown.push(f.name); });
    if (unknown.length) status(`振り分けできなかったファイル: ${unknown.join(', ')}`, true);
  });

  function status(msg, err = false) {
    $('status').textContent = msg;
    $('status').classList.toggle('is-error', err);
  }

  async function api(method, url, body, headers = {}) {
    const res = await fetch(url, { method, body, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function buildConfig() {
    let cfg = {};
    if (files['config.json']) {
      try { cfg = JSON.parse(await files['config.json'].text()); } catch { throw new Error('config.json が不正な JSON です'); }
    }
    const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };
    if ($('title').value && !cfg.title) cfg.title = $('title').value;
    cfg.size_mm = cfg.size_mm || {};
    if (num('width') && !cfg.size_mm.width) cfg.size_mm.width = num('width');
    if (num('height') && !cfg.size_mm.height) cfg.size_mm.height = num('height');
    cfg.layers = cfg.layers || {};
    if (num('heightmapH') != null) cfg.layers.heightmap = { max_height_mm: num('heightmapH'), ...cfg.layers.heightmap };
    if (num('baseH') != null) cfg.layers.base = { max_height_mm: num('baseH'), ...cfg.layers.base };
    if (num('texH') != null) cfg.layers.texture = { max_height_mm: num('texH'), ...cfg.layers.texture };
    return cfg;
  }

  $('submitBtn').addEventListener('click', async () => {
    if (!files['heightmap.png'] && !files['base.png'] && !files['texture.png']) {
      status('Heightmap（ハイトマップ）、または Base / Texture 画像を選択してください', true);
      return;
    }
    const btn = $('submitBtn');
    btn.disabled = true;
    try {
      const cfg = await buildConfig();
      status('リンクを作成しています…');
      const { token, url } = await api('POST', '/api/admin/projects', JSON.stringify({
        title: $('title').value || cfg.title || '',
        expires_days: parseFloat($('expires').value) || null,
      }), { 'Content-Type': 'application/json' });

      const uploads = Object.entries(files).filter(([n]) => n !== 'config.json');
      let i = 0;
      for (const [name, file] of uploads) {
        status(`アップロード中… ${name} (${++i}/${uploads.length})`);
        await api('PUT', `/api/admin/projects/${token}/files/${name}`, file, { 'Content-Type': 'application/octet-stream' });
      }
      await api('PUT', `/api/admin/projects/${token}/files/config.json`,
        new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }), { 'Content-Type': 'application/json' });

      const full = new URL(url, location.origin).href;
      $('shareUrl').value = full;
      $('openBtn').href = full;
      $('result').classList.add('is-show');
      status('共有リンクを発行しました。このURLをお客様に送ってください。');
      loadList();
    } catch (e) {
      status(`エラー: ${e.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('resetBtn').addEventListener('click', () => location.reload());

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    const old = btn.textContent; btn.textContent = 'COPIED'; setTimeout(() => { btn.textContent = old; }, 1400);
  }
  $('copyBtn').addEventListener('click', (e) => copy($('shareUrl').value, e.currentTarget));

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function loadList() {
    const { projects } = await api('GET', '/api/admin/projects');
    $('empty').hidden = projects.length > 0;
    $('list').innerHTML = projects.map((p) => {
      const d = p.created_at ? new Date(p.created_at * 1000) : null;
      const date = d && !isNaN(d.getTime())
        ? `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
        : '—';
      const exp = p.expires_at ? `<br><small>〜${new Date(p.expires_at * 1000).toLocaleDateString('ja-JP')}</small>` : '';
      const url = new URL(`/p/${p.token}`, location.origin).href;
      const filesList = Array.isArray(p.files) ? p.files.map(esc).join(' / ') : '';
      const action = p.is_static
        ? '<span class="badge-preset" style="display:inline-block;margin-left:6px;padding:4px 8px;font-size:11px;font-weight:600;color:#666;background:#f0f0f0;border:1px solid #ddd;border-radius:2px;letter-spacing:0.04em;vertical-align:middle;">プリセット</span>'
        : `<button class="danger" data-del="${esc(p.token)}">Delete</button>`;
      return `<tr>
        <td class="date">${date}${exp}</td>
        <td>${esc(p.title) || '<span style="color:#aaa">（無題）</span>'}</td>
        <td class="files">${filesList}</td>
        <td class="ops">
          <button data-copy="${esc(url)}">Copy</button>
          <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open</a>
          ${action}
        </td></tr>`;
    }).join('');
  }

  $('list').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copy(c.dataset.copy, c);
    const d = e.target.closest('[data-del]');
    if (d && confirm('このリンクを削除しますか？\n削除するとお客様も閲覧できなくなります。')) {
      await api('DELETE', `/api/admin/projects/${d.dataset.del}`);
      loadList();
    }
  });

  loadList().catch((e) => status(`一覧の取得に失敗しました: ${e.message}`, true));
})();
