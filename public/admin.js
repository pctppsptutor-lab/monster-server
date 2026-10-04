/* Admin page. Rules that keep it audit-clean:
 *  - the session lives in an HttpOnly cookie; this script never stores tokens or passwords (no localStorage/sessionStorage)
 *  - the CSRF token is kept in memory only and sent as x-csrf-token on every non-GET request
 *  - every value from the server or the question source is rendered with textContent, never as HTML
 *  - password fields are cleared right after each submit */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let csrf = '';

  const msg = (text, ok) => {
    const m = $('msg');
    m.textContent = text || '';
    m.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : '');
    if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const fmt = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN');
  };

  async function api(method, path, data) {
    const headers = { accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrf;
    }
    let res;
    try {
      res = await fetch(path, {
        method, headers,
        body: data ? JSON.stringify(data) : undefined,
        cache: 'no-store', credentials: 'same-origin', redirect: 'error'
      });
    } catch {
      throw Object.assign(new Error('Không kết nối được máy chủ.'), { code: 'NETWORK' });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = Object.assign(new Error(json.error || 'Lỗi ' + res.status), { code: json.code, status: res.status });
      if (res.status === 401 && path !== '/api/admin/login') {
        showLogin(path === '/api/admin/session' ? '' : err.message);
      } else if (json.code === 'PASSWORD_CHANGE_REQUIRED') {
        showPassword(true);
      }
      throw err;
    }
    return json;
  }

  async function busy(btn, fn) {
    if (!btn) return fn();
    btn.disabled = true;
    try { await fn(); }
    finally { btn.disabled = false; }
  }

  /* ------------------------------------------------------------- views */
  function showOnly(id) {
    for (const v of ['loginView', 'mainView']) {
      if ($(v)) $(v).hidden = v !== id;
    }
  }

  function showLogin(text) {
    csrf = '';
    $('who').hidden = true;
    showOnly('loginView');
    if (text) msg(text);
    $('loginPass').value = '';
    $('loginUser').focus();
  }

  function applySession(s) {
    csrf = s.csrf;
    $('whoName').textContent = s.username;
    $('who').hidden = false;
    $('pwUser').value = s.username;
    $('pwRules').textContent = s.passwordRules || '';
  }

  function showPassword(forced) {
    $('pwForced').hidden = !forced;
    switchTab('tabPassword');
    $('pwCurrent').focus();
  }

  function switchTab(activeTabId) {
    const tabs = [
      { tab: 'tabEditor', panel: 'panelEditor' },
      { tab: 'tabSources', panel: 'panelSources' },
      { tab: 'tabAudit', panel: 'panelAudit' },
      { tab: 'tabPassword', panel: 'panelPassword' }
    ];
    tabs.forEach(t => {
      const isCur = t.tab === activeTabId;
      $(t.tab)?.classList.toggle('active', isCur);
      if ($(t.panel)) $(t.panel).hidden = !isCur;
    });
  }

  async function showMain() {
    showOnly('mainView');
    switchTab('tabEditor');
    await refreshSources();
    await loadCurrentGameBank();
  }

  async function enter(s) {
    applySession(s);
    if (s.mustChange) showPassword(true);
    else await showMain();
  }

  /* -------------------------------------------------- question editor */
  let currentBank = {
    schemaVersion: 2,
    title: 'Monster Gacha - 8 Rounds English Adventure',
    questions: []
  };
  let activeIndex = 0;

  async function loadCurrentGameBank() {
    const gameId = $('editorGameSelect').value.trim() || 'monster-gacha';
    $('gameId').value = gameId;
    try {
      const bank = await api('GET', `/api/admin/sources/${encodeURIComponent(gameId)}/bank`);
      if (bank && Array.isArray(bank.questions) && bank.questions.length > 0) {
        currentBank = bank;
      }
    } catch {
      // Fallback to starter structure if empty
      currentBank = {
        schemaVersion: 2,
        title: 'Monster Gacha - 8 Rounds English Adventure',
        questions: [
          {
            id: 'q-001',
            type: 'single-choice',
            prompt: 'I have soft fur and I say Meow. What am I?',
            options: [
              { id: 'a', text: 'A dog' },
              { id: 'b', text: 'A cat' },
              { id: 'c', text: 'A duck' },
              { id: 'd', text: 'A lion' }
            ],
            correctOptionId: 'b',
            explanation: 'A cat says Meow!',
            points: 100,
            timeLimitMs: 20000
          }
        ]
      };
    }

    $('editorBankTitle').value = currentBank.title || '';
    if (activeIndex >= currentBank.questions.length) activeIndex = 0;
    renderQuestionList();
    loadQuestionToForm(activeIndex);
  }

  function renderQuestionList() {
    const list = $('qItemsList');
    list.replaceChildren();
    $('qCountBadge').textContent = String(currentBank.questions.length);

    currentBank.questions.forEach((q, idx) => {
      const card = el('div', undefined, `q-card-item ${idx === activeIndex ? 'active' : ''}`);
      card.addEventListener('click', () => {
        saveFormToActive();
        activeIndex = idx;
        renderQuestionList();
        loadQuestionToForm(idx);
      });

      const top = el('div', undefined, 'q-item-top');
      top.append(
        el('span', `Câu #${idx + 1}`, 'q-idx'),
        el('span', `+${q.points || 100}đ · ${Math.round((q.timeLimitMs || 20000) / 1000)}s`, 'q-pts')
      );

      const promptSnippet = el('p', q.prompt || '(Chưa nhập nội dung câu hỏi)', 'q-prompt-snippet');
      const optSummary = el('div', `${(q.options || []).length} lựa chọn · Đáp án: ${q.correctOptionId ? q.correctOptionId.toUpperCase() : 'Chưa chọn'}`, 'q-opt-count');

      card.append(top, promptSnippet, optSummary);
      list.append(card);
    });
  }

  function loadQuestionToForm(idx) {
    const q = currentBank.questions[idx];
    if (!q) return;

    $('editingQTitle').textContent = `Chỉnh sửa Câu hỏi #${idx + 1}`;
    $('qTypeSelect').value = q.type || 'single-choice';
    $('qPoints').value = q.points || 100;
    $('qTimeLimit').value = Math.round((q.timeLimitMs || 20000) / 1000);
    $('qPrompt').value = q.prompt || '';
    $('qExplanation').value = q.explanation || '';

    // Single choice vs fill blank
    const isBlank = q.type === 'fill-blank';
    $('optionsSection').hidden = isBlank;
    $('blankSection').hidden = !isBlank;

    if (isBlank) {
      $('qAcceptedAnswers').value = (q.acceptedAnswers || []).join(', ');
    } else {
      renderOptionsEditor(q);
    }

    renderLivePreview();
  }

  function renderOptionsEditor(q) {
    const list = $('optionsList');
    list.replaceChildren();
    const opts = q.options || [];

    opts.forEach((o, optIdx) => {
      const row = el('div', undefined, `opt-edit-row ${o.id === q.correctOptionId ? 'correct-row' : ''}`);

      const radioWrap = el('div', undefined, 'radio-check-wrap');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'correctOptRadio';
      radio.className = 'radio-correct';
      radio.checked = o.id === q.correctOptionId;
      radio.title = 'Tích chọn làm đáp án đúng';
      radio.addEventListener('change', () => {
        q.correctOptionId = o.id;
        renderOptionsEditor(q);
        renderLivePreview();
      });
      radioWrap.append(radio);

      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.placeholder = `Nội dung lựa chọn ${String.fromCharCode(65 + optIdx)}...`;
      textInput.value = o.text || '';
      textInput.addEventListener('input', () => {
        o.text = textInput.value;
        renderLivePreview();
      });

      const delBtn = el('button', '🗑️', 'btn-icon-del');
      delBtn.type = 'button';
      delBtn.title = 'Xóa lựa chọn này';
      delBtn.disabled = opts.length <= 2;
      delBtn.addEventListener('click', () => {
        if (opts.length <= 2) return;
        q.options = opts.filter((_, i) => i !== optIdx);
        if (q.correctOptionId === o.id && q.options[0]) {
          q.correctOptionId = q.options[0].id;
        }
        renderOptionsEditor(q);
        renderLivePreview();
      });

      row.append(radioWrap, textInput, delBtn);
      list.append(row);
    });
  }

  function saveFormToActive() {
    const q = currentBank.questions[activeIndex];
    if (!q) return;

    q.type = $('qTypeSelect').value;
    q.points = Number($('qPoints').value) || 100;
    q.timeLimitMs = (Number($('qTimeLimit').value) || 20) * 1000;
    q.prompt = $('qPrompt').value.trim();
    q.explanation = $('qExplanation').value.trim();

    if (q.type === 'fill-blank') {
      q.acceptedAnswers = $('qAcceptedAnswers').value.split(',').map(s => s.trim()).filter(Boolean);
      delete q.options;
      delete q.correctOptionId;
    }

    renderLivePreview();
  }

  function renderLivePreview() {
    const shell = $('livePreviewBox');
    shell.replaceChildren();

    const q = currentBank.questions[activeIndex];
    if (!q) {
      shell.append(el('p', 'Chưa có câu hỏi nào.'));
      return;
    }

    const badge = el('span', `VÒNG #${activeIndex + 1} · ${q.points || 100} ĐIỂM · ${Math.round((q.timeLimitMs || 20000)/1000)}s`, 'prev-badge');
    const prompt = el('h2', q.prompt || '(Nội dung câu hỏi hiển thị tại đây)', 'prev-prompt');
    shell.append(badge, prompt);

    if (q.type === 'fill-blank') {
      const row = el('div', undefined, 'row');
      const input = document.createElement('input');
      input.placeholder = 'Học sinh nhập câu trả lời vào đây...';
      input.disabled = true;
      row.append(input);
      shell.append(row);
    } else {
      const grid = el('div', undefined, 'prev-grid');
      (q.options || []).forEach((o, i) => {
        const isRight = o.id === q.correctOptionId;
        const optCard = el('div', undefined, `prev-opt ${isRight ? 'is-right' : ''}`);
        optCard.append(
          el('strong', `${String.fromCharCode(65 + i)}. `),
          el('span', o.text || `(Lựa chọn ${String.fromCharCode(65 + i)})`),
          isRight ? el('span', ' ✔ ĐÁP ÁN ĐÚNG', 'badge info') : ''
        );
        grid.append(optCard);
      });
      shell.append(grid);
    }

    if (q.explanation) {
      const exp = el('p', `💡 Giải thích: ${q.explanation}`, 'hint');
      exp.style.marginTop = '12px';
      shell.append(exp);
    }
  }

  // Question editing actions
  $('qEditForm')?.addEventListener('submit', e => {
    e.preventDefault();
    saveFormToActive();
    renderQuestionList();
    msg('Đã cập nhật câu hỏi vào danh sách!', true);
  });

  $('btnApplyQ')?.addEventListener('click', () => {
    saveFormToActive();
    renderQuestionList();
    msg('Đã cập nhật câu hỏi vào danh sách!', true);
  });

  $('btnAddOption')?.addEventListener('click', () => {
    const q = currentBank.questions[activeIndex];
    if (!q) return;
    q.options = q.options || [];
    if (q.options.length >= 6) {
      return msg('Tối đa 6 lựa chọn đáp án.');
    }
    const nextId = String.fromCharCode(97 + q.options.length); // a, b, c, d, e, f
    q.options.push({ id: nextId, text: `Lựa chọn ${nextId.toUpperCase()}` });
    renderOptionsEditor(q);
    renderLivePreview();
  });

  $('btnNewQ')?.addEventListener('click', () => {
    saveFormToActive();
    const newIdx = currentBank.questions.length + 1;
    const newId = `q-${String(newIdx).padStart(3, '0')}`;
    const newQ = {
      id: newId,
      type: 'single-choice',
      prompt: `Câu hỏi số ${newIdx} mới...`,
      options: [
        { id: 'a', text: 'Đáp án A' },
        { id: 'b', text: 'Đáp án B' },
        { id: 'c', text: 'Đáp án C' },
        { id: 'd', text: 'Đáp án D' }
      ],
      correctOptionId: 'a',
      explanation: '',
      points: 100,
      timeLimitMs: 20000
    };
    currentBank.questions.push(newQ);
    activeIndex = currentBank.questions.length - 1;
    renderQuestionList();
    loadQuestionToForm(activeIndex);
    $('qPrompt').focus();
    msg(`Đã thêm câu hỏi #${newIdx}!`, true);
  });

  $('btnDuplicateQ')?.addEventListener('click', () => {
    saveFormToActive();
    const cur = currentBank.questions[activeIndex];
    if (!cur) return;
    const cloned = JSON.parse(JSON.stringify(cur));
    cloned.id = `q-${Date.now().toString(36).slice(-4)}`;
    cloned.prompt = `${cloned.prompt} (Bản sao)`;
    currentBank.questions.splice(activeIndex + 1, 0, cloned);
    activeIndex += 1;
    renderQuestionList();
    loadQuestionToForm(activeIndex);
    msg('Đã nhân bản câu hỏi!', true);
  });

  $('btnDeleteQ')?.addEventListener('click', () => {
    if (currentBank.questions.length <= 1) {
      return msg('Bộ đề cần có ít nhất 1 câu hỏi.');
    }
    currentBank.questions.splice(activeIndex, 1);
    if (activeIndex >= currentBank.questions.length) {
      activeIndex = currentBank.questions.length - 1;
    }
    renderQuestionList();
    loadQuestionToForm(activeIndex);
    msg('Đã xóa câu hỏi khỏi bộ đề.', true);
  });

  // Direct Save Draft and Direct Publish
  async function saveDirect(publish) {
    saveFormToActive();
    const gameId = $('editorGameSelect').value.trim() || 'monster-gacha';
    currentBank.title = $('editorBankTitle').value.trim() || `Bộ câu hỏi ${gameId}`;

    const res = await api('POST', `/api/admin/sources/${encodeURIComponent(gameId)}/save-bank`, {
      bank: currentBank,
      publish
    });

    currentBank = res.bank;
    renderQuestionList();
    loadQuestionToForm(activeIndex);
    await refreshSources();
    msg(publish
      ? '🚀 ĐÃ XUẤT BẢN THÀNH CÔNG! Phòng chơi mới hoặc vòng mới sẽ áp dụng ngay bộ câu hỏi này.'
      : '💾 Đã lưu bản nháp thành công! Có thể tiếp tục chỉnh sửa.',
      true
    );
  }

  $('btnSaveDraftDirect')?.addEventListener('click', () => busy($('btnSaveDraftDirect'), () => saveDirect(false)));
  $('btnPublishDirect')?.addEventListener('click', () => busy($('btnPublishDirect'), () => saveDirect(true)));

  $('qTypeSelect')?.addEventListener('change', () => {
    saveFormToActive();
    loadQuestionToForm(activeIndex);
  });
  $('qPrompt')?.addEventListener('input', () => {
    saveFormToActive();
  });

  // Tab buttons
  $('tabEditor')?.addEventListener('click', () => switchTab('tabEditor'));
  $('tabSources')?.addEventListener('click', () => switchTab('tabSources'));
  $('tabAudit')?.addEventListener('click', () => {
    switchTab('tabAudit');
    $('loadAudit')?.click();
  });
  $('tabPassword')?.addEventListener('click', () => switchTab('tabPassword'));

  /* ------------------------------------------------------------ sources */
  async function refreshSources() {
    try {
      const all = await api('GET', '/api/admin/sources');
      const listEl = $('list');
      if (!listEl) return;
      listEl.replaceChildren(...Object.entries(all).map(([g, v]) => {
        const tr = el('tr');
        const history = el('td', v.history?.length ? v.history.map(x => `v${x.version}`).join(', ') : '—');
        if (v.history?.length) {
          const select = document.createElement('select');
          v.history.forEach(x => select.append(new Option(`v${x.version} · ${x.title || x.contentVersion}`, String(x.version))));
          const restore = el('button', 'Khôi phục', 'btn ghost small');
          restore.type = 'button';
          restore.addEventListener('click', () => busy(restore, async () => {
            await api('POST', `/api/admin/sources/${encodeURIComponent(g)}/restore`, { version: Number(select.value) });
            await refreshSources();
            await loadCurrentGameBank();
            msg('Đã khôi phục thành một phiên bản xuất bản mới.', true);
          }));
          history.append(document.createElement('br'), select, restore);
        }
        tr.append(
          el('td', g),
          el('td', v.draft ? `${v.draft.sourceUrl} · ${v.draft.review?.ok ? 'đã kiểm tra' : 'chưa kiểm tra'}` : '—'),
          el('td', v.published ? `v${v.published.version} · ${v.published.title || v.published.contentVersion} · ${fmt(v.published.publishedAt)}` : '—'),
          history
        );
        return tr;
      }));
    } catch {}
  }

  function renderLegacyBank(bank) {
    const out = $('out');
    if (!out) return;
    out.replaceChildren();
    const teacher = el('ol');
    bank.questions.forEach(q => {
      const li = el('li');
      li.append(el('span', `[${q.type}] ${q.prompt}`));
      const ul = el('ul');
      if (q.options) {
        q.options.forEach(o => ul.append(el('li', `${o.id}. ${o.text}`, o.id === q.correctOptionId ? 'correct' : '')));
      } else if (q.items) {
        q.correctOrder.forEach(id => ul.append(el('li', q.items.find(x => x.id === id)?.text || id, 'correct')));
      } else if (q.leftItems) {
        Object.entries(q.correctMatches).forEach(([l, r]) => ul.append(el('li', `${q.leftItems.find(x => x.id === l)?.text} – ${q.rightItems.find(x => x.id === r)?.text}`, 'correct')));
      } else {
        q.acceptedAnswers?.forEach(a => ul.append(el('li', a, 'correct')));
      }
      li.append(ul);
      teacher.append(li);
    });
    out.append(el('h3', `${bank.title} · ${bank.questions.length} câu · phiên bản ${bank.contentVersion}`), teacher);
  }

  $('preview')?.addEventListener('click', () => busy($('preview'), async () => {
    $('out')?.replaceChildren();
    try {
      const bank = await api('POST', '/api/admin/preview', { gameId: $('gameId').value.trim(), sourceUrl: $('url').value.trim() });
      renderLegacyBank(bank);
      msg('Link đọc được và đúng định dạng.', true);
    } catch (e) { if (e.status !== 401) msg(e.message); }
  }));

  $('save')?.addEventListener('click', () => busy($('save'), async () => {
    try {
      await api('PUT', '/api/admin/sources/' + encodeURIComponent($('gameId').value.trim()), { sourceUrl: $('url').value.trim() });
      await refreshSources();
      msg('Đã lưu bản nháp từ link.', true);
    } catch (e) { if (e.status !== 401) msg(e.message); }
  }));

  $('review')?.addEventListener('click', () => busy($('review'), async () => {
    try {
      const r = await api('POST', `/api/admin/sources/${encodeURIComponent($('gameId').value.trim())}/review`, {});
      renderLegacyBank(r.bank);
      await refreshSources();
      msg('Bản nháp hợp lệ. Có thể xuất bản.', true);
    } catch (e) { if (e.status !== 401) msg(e.message); }
  }));

  $('publish')?.addEventListener('click', () => busy($('publish'), async () => {
    try {
      await api('POST', `/api/admin/sources/${encodeURIComponent($('gameId').value.trim())}/publish`, {});
      await refreshSources();
      msg('Đã xuất bản nguồn.', true);
    } catch (e) { if (e.status !== 401) msg(e.message); }
  }));

  /* -------------------------------------------------------------- audit */
  const EVENT = {
    'login.success': 'Đăng nhập', 'login.failure': 'Đăng nhập sai', 'login.blocked': 'Chặn đăng nhập', 'account.locked': 'Tạm khóa tài khoản',
    logout: 'Đăng xuất', 'password.change': 'Đổi mật khẩu', 'password.reset': 'IT cấp lại mật khẩu', 'account.create': 'IT tạo tài khoản',
    'account.disable': 'IT khóa tài khoản', 'account.enable': 'IT mở tài khoản', 'account.scope': 'Đổi phạm vi',
    'source.draft': 'Lưu bản nháp', 'source.review': 'Kiểm tra bản nháp', 'source.publish': 'Xuất bản', 'source.restore': 'Khôi phục', 'source.preview': 'Xem thử link', 'csrf.reject': 'Chặn yêu cầu giả mạo'
  };

  $('loadAudit')?.addEventListener('click', () => busy($('loadAudit'), async () => {
    try {
      const rows = await api('GET', '/api/admin/audit?limit=100');
      $('auditList').replaceChildren(...rows.map(r => {
        const detail = [r.outcome, r.reason, r.target, r.gameId, r.from && `từ ${r.from}`, r.to && `→ ${r.to}`, r.detail].filter(Boolean).join(' · ');
        const bad = r.outcome === 'failure' || /failure|blocked|locked|reject/.test(r.event);
        const tr = el('tr', undefined, bad ? 'fail' : '');
        tr.append(el('td', fmt(r.ts)), el('td', EVENT[r.event] || r.event), el('td', r.actor || ''), el('td', detail), el('td', r.ip || ''));
        return tr;
      }));
      $('auditTable').hidden = false;
    } catch (e) { if (e.status !== 401) msg(e.message); }
  }));

  /* ------------------------------------------------------- login/logout */
  $('loginForm')?.addEventListener('submit', ev => {
    ev.preventDefault();
    busy($('loginBtn'), async () => {
      const username = $('loginUser').value.trim().toLowerCase(), password = $('loginPass').value;
      $('loginPass').value = '';
      if (!username || !password) return msg('Nhập tên đăng nhập và mật khẩu.');
      try {
        const s = await api('POST', '/api/admin/login', { username, password });
        msg('');
        await enter(s);
      } catch (e) {
        msg(e.message);
        $('loginPass').focus();
      }
    });
  });

  $('logout')?.addEventListener('click', () => busy($('logout'), async () => {
    try { await api('POST', '/api/admin/logout', {}); } catch {}
    showLogin();
    msg('Đã đăng xuất.', true);
  }));

  /* ---------------------------------------------------- change password */
  $('pwForm')?.addEventListener('submit', ev => {
    ev.preventDefault();
    busy($('pwBtn'), async () => {
      const currentPassword = $('pwCurrent').value, newPassword = $('pwNew').value, again = $('pwNew2').value;
      for (const id of ['pwCurrent', 'pwNew', 'pwNew2']) $(id).value = '';
      if (!currentPassword || !newPassword) return msg('Nhập đủ mật khẩu hiện tại và mật khẩu mới.');
      if (newPassword !== again) return msg('Hai lần nhập mật khẩu mới không khớp.');
      if ([...newPassword].length < 12) return msg('Mật khẩu mới cần ít nhất 12 ký tự.');
      try {
        const s = await api('POST', '/api/admin/password', { currentPassword, newPassword });
        applySession(s);
        await showMain();
        msg('Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.', true);
      } catch (e) { if (e.status !== 401) msg(e.message); }
    });
  });

  /* --------------------------------------------------------------- boot */
  api('GET', '/api/admin/session').then(enter).catch(e => {
    if (e.status !== 401) showLogin(e.message);
  });
})();
