// 交互原型：仅模拟同步流程，不访问仓库、不执行 Git。
'use strict';
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const oid = (prefix) => (prefix + '9a63bf720d15e98a4c731b6d0258ee19fc7269aa').slice(0, 40);

function initialState(role = 'internal') {
  return {
    role, tab: role === 'internal' ? 'out' : 'in', scenario: 'normal',
    project: 'Threat Intelligence', transfer: 'OFFLINE_USB / ti', full: false, patch: false,
    exported: false, returned: false, received: false, mirror: 11,
    repos: [{ name: '主开发仓库', seq: 10 }, { name: 'Agent 仓库', seq: 11 }],
    reviews: [], selected: new Set(['feature/batch-query', 'hotfix/backpressure']),
    pushSelected: new Set(), busy: null, pushPlan: null,
    history: [{ title: role === 'internal' ? '已导出更新 #11' : '已同步更新 #11', detail: '今天 10:42', steps: [] }],
  };
}
let state = initialState();
let timer, toastTimer, dialogOpener;
const branchData = [
  { name: 'feature/batch-query', base: 'main', sha: oid('b71e402'), commits: ['支持批量情报查询', '统一结果去重规则', '补充分页边界测试'] },
  { name: 'hotfix/backpressure', base: 'release/2.4', sha: oid('c8a1529'), commits: ['限制积压任务重试', '修复重复消费'] },
];
function button(text, action, { primary = false, disabled = false, small = false, id = '', danger = false } = {}) {
  return `<button class="button ${primary ? 'primary' : ''} ${small ? 'small' : ''} ${danger ? 'danger' : ''}" data-action="${action}" ${id ? `data-id="${escapeHtml(id)}"` : ''} ${disabled ? 'disabled' : ''}>${text}</button>`;
}
function keyValues(rows) {
  return `<dl class="details-list">${rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('')}</dl>`;
}
function errorLine(text, action = '', label = '', red = false) {
  return `<div class="error ${red ? 'red' : ''}" role="status"><span class="error-copy">${text}</span>${action ? `<button class="text-button" data-action="${action}" ${state.busy ? 'disabled' : ''}>${label}</button>` : ''}</div>`;
}
function card(title, subtitle, action, options = {}) {
  return `<section class="main-card"><div class="action-row"><span class="file-icon ${options.done ? 'done' : ''}" aria-hidden="true">${options.done ? '✓' : '⇄'}</span><div class="action-copy"><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>${options.extra || ''}</section>`;
}
function isBlocked() {
  return !!state.busy || state.scenario === 'corrupt' || state.scenario === 'exportInterrupted';
}
function staleRepos() { return state.repos.filter((repo) => repo.seq < state.mirror); }
function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3000);
}
function render() {
  const internal = state.role === 'internal';
  const tabs = internal ? [['out', '导出更新'], ['back', '导入回传']] : [['in', '同步更新'], ['return', '回传提交']];
  $('.project-button').innerHTML = `${escapeHtml(state.project)} <span aria-hidden="true">⌄</span>`;
  $('#role-badge').textContent = internal ? '内网' : '外网';
  $('.location .path').textContent = state.transfer;
  for (const action of ['settings', 'location']) $('[data-action="' + action + '"]').disabled = !!state.busy;
  $('#tabs').setAttribute('role', 'tablist');
  $('#tabs').innerHTML = tabs.map(([id, label]) => `<button class="tab" id="tab-${id}" role="tab" data-tab="${id}" aria-controls="content" aria-selected="${state.tab === id}" tabindex="${state.tab === id ? 0 : -1}">${label}${id === 'back' && !state.received && state.scenario !== 'empty' && state.scenario !== 'corrupt' ? '<span class="count">1</span>' : ''}</button>`).join('');
  $('#content').setAttribute('role', 'tabpanel');
  $('#content').setAttribute('aria-labelledby', `tab-${state.tab}`);
  let content;
  if (state.scenario === 'empty') content = renderSetup();
  else if (state.scenario === 'corrupt') content = errorLine('无法读取同步记录，请检查后重试。', 'diagnose', '查看原因', true);
  else {
    const views = { out: renderOutbound, back: renderBack, in: renderInbound, return: renderReturn };
    content = views[state.tab]();
    if (state.scenario === 'exportInterrupted') content = errorLine('上次导出未完成。', 'resume', '继续导出') + content;
  }
  $('#content').innerHTML = content;
  $('#latest').textContent = state.scenario === 'empty' ? '尚未同步' : state.scenario === 'corrupt' ? '同步状态未知' : `最近：${state.history[0].title}`;
  $('.location').hidden = state.scenario === 'empty';
  renderProgress();
}
function renderOutbound() {
  const name = state.exported ? `ti-out-${String(state.exported.seq).padStart(4, '0')}-${state.exported.full ? 'full' : 'incr'}.bundle` : '';
  const title = state.exported ? `更新包 #${state.exported.seq}` : '导出最新代码';
  const subtitle = state.exported ? `${name} · ${state.exported.full ? '128' : '8.6'} MB` : 'main、release/2.4 等 18 个分支';
  const extra = `<details class="options"><summary>选项</summary><label class="check"><input id="full" type="checkbox" ${state.full ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>全量导出（首次使用或补齐丢包）</label></details>`;
  return card(title, subtitle, button(state.exported ? '检查更新' : '导出更新', 'export', { primary: !state.exported, disabled: isBlocked() }), { done: state.exported, extra }) +
    (state.exported ? `<div class="result"><span>✓ 已保存到 ${escapeHtml(state.transfer)}</span><button class="text-button" data-action="files">查看文件</button></div>` : '');
}
function renderInbound() {
  if (state.scenario === 'missing') return card('更新 #14', '3.2 MB', button('同步更新', 'sync', { disabled: true })) + `<div style="margin-top:16px">${errorLine('缺少更新 #13，请补齐或改用全量包。', 'full-package', '使用全量包')}</div>`;
  if (state.scenario === 'collision') return errorLine('包内容与已有记录不一致，请重新复制。', 'package-details', '查看详情', true);
  const pending = staleRepos().length;
  const received = state.mirror >= 12;
  let label = '同步更新';
  if (received) label = pending ? '完成同步' : '已同步';
  const title = received ? `更新 #${state.mirror}` : '发现 1 份更新';
  const subtitle = received ? pending ? `${pending} 个开发仓库待更新` : '2 个开发仓库已获取更新' : '4 个分支 · 8.6 MB';
  const extra = `<details class="options"><summary>详情</summary>${keyValues([['同步到', '主开发仓库、Agent 仓库'], ['文件', `<code>ti-out-${received ? String(state.mirror).padStart(4, '0') : '0012'}-${state.mirror === 15 ? 'full' : 'incr'}.bundle</code>`], ['范围', '更新远程引用，保留本地分支与修改']])}</details>`;
  return card(title, subtitle, button(label, 'sync', { primary: !received || !!pending, disabled: isBlocked() || (received && !pending) }), { done: received && !pending, extra });
}
function renderBack() {
  if (state.scenario === 'collision') return errorLine('回传包内容与已有记录不一致，请重新复制。', 'package-details', '查看详情', true);
  const pending = state.reviews.some((review) => review.status === 'received');
  const base = card(state.received ? '回传 #17' : '发现 1 份回传', '2 个分支 · 5 个提交', button(pending ? '继续整理' : state.received ? '已导入' : '导入回传', 'import-back', { primary: !state.received || pending, disabled: isBlocked() || (state.received && !pending) }), {
    done: state.received,
    extra: `<details class="options"><summary>内容</summary>${branchData.map((branch) => `<div class="branch-row"><div class="branch-copy"><code>${branch.name}</code><small>${branch.base} · ${branch.commits.length} 个提交</small></div></div>`).join('')}</details>`,
  });
  if (!state.received) return base;
  const unresolved = state.reviews.some((review) => ['conflict', 'unknown', 'received'].includes(review.status));
  const selected = state.reviews.filter((review) => state.pushSelected.has(review.name) && review.status === 'ready');
  const labels = { received: '待整理', ready: '待推送', pushed: '已推送', conflict: '有冲突', unknown: '结果待确认' };
  let rows = state.reviews.map((review) => {
    let action = '';
    if (review.status === 'conflict') action = button('处理', 'conflict', { id: review.name, small: true, disabled: isBlocked() });
    if (review.status === 'received') action = button('整理', 'integrate', { id: review.name, small: true, disabled: isBlocked() });
    if (review.status === 'unknown') action = button('检查结果', 'verify', { id: review.name, small: true, disabled: isBlocked() });
    return `<div class="branch-row"><input type="checkbox" name="push-branch" value="${review.name}" aria-label="选择 ${review.name}" ${state.pushSelected.has(review.name) ? 'checked' : ''} ${review.status !== 'ready' || state.busy ? 'disabled' : ''}><div class="branch-copy"><code>${review.name}</code><small>${review.commits.length} 个提交 · ${review.base}</small></div><span class="branch-state ${review.status === 'pushed' ? 'green' : review.status === 'ready' ? '' : 'amber'}">${labels[review.status]}</span>${action}</div>`;
  }).join('');
  return base + `<div class="section-heading"><h2>本次回传</h2></div><div class="branch-list">${rows}</div>` +
    (state.reviews.some((review) => review.status !== 'pushed') ? `<div class="send-footer">${unresolved ? '<span class="muted" style="font-size:11px">先处理未完成的操作</span>' : ''}<div class="button-group">${button(`检查并推送${selected.length ? ` (${selected.length})` : ''}`, 'push-plan', { primary: true, disabled: isBlocked() || unresolved || !selected.length })}</div></div>` : '');
}
function renderReturn() {
  if (state.returned) return card('回传包 #17', `ti-back-0017.${state.patch ? 'patch' : 'bundle'}`, button('已导出', 'return', { disabled: true }), { done: true }) + `<div class="result">✓ 已保存到 ${escapeHtml(state.transfer)}</div>`;
  return `<div class="section-heading" style="margin-top:5px"><h2>选择要回传的分支</h2><button class="text-button" data-action="repo">主开发仓库 ⌄</button></div><div class="branch-list">${branchData.map((branch) => `<label class="branch-row"><input type="checkbox" name="return-branch" value="${branch.name}" ${state.selected.has(branch.name) ? 'checked' : ''} ${state.busy ? 'disabled' : ''}><span class="branch-copy"><code>${branch.name}</code><small>${branch.base} · ${branch.commits.length} 个提交</small></span></label>`).join('')}</div><div class="send-footer"><button class="text-button" data-action="return-options" ${state.busy ? 'disabled' : ''}>${state.patch ? 'Patch' : 'Bundle'} ⌄</button>${button(`导出回传${state.selected.size ? ` (${state.selected.size})` : ''}`, 'return', { primary: true, disabled: isBlocked() || !state.selected.size || (state.patch && state.selected.size > 1) })}</div>${state.patch && state.selected.size > 1 ? '<div class="result warning">Patch 一次只能选择一个分支。</div>' : ''}`;
}
function renderSetup() {
  return `<section class="empty"><h1>添加一个项目</h1><p>配置一次，以后直接同步。</p><div class="button-group">${button('连接内网 GitLab', 'setup-internal', { primary: true })}${button('导入内网全量包', 'setup-external')}</div></section>`;
}
function openDialog(title, body, action = '') {
  dialogOpener = document.activeElement;
  $('#dialog-content').innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="close" data-action="close" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div><div class="dialog-footer">${button(action ? '取消' : '关闭', 'close')}${action}</div>`;
  if (!$('#dialog').open) $('#dialog').showModal();
}
function closeDialog() { $('#dialog').close(); }
$('#dialog').addEventListener('close', () => {
  if (dialogOpener?.isConnected) dialogOpener.focus();
  else $('#content').focus({ preventScroll: true });
});
function startOperation(title, steps, result) {
  if (state.busy) return;
  const operation = { title, steps, result, index: 0, completed: [], cancelled: false };
  state.busy = operation;
  render();
  function tick() {
    if (state.busy !== operation) return;
    if (operation.cancelled) {
      finishOperation(operation, '已停止', operation.completed.length ? operation.completed.join('；') : '未产生变更');
      return;
    }
    const step = steps[operation.index];
    step.apply?.();
    if (step.effect) operation.completed.push(step.effect);
    operation.index++;
    if (operation.index === steps.length) finishOperation(operation, title, result);
    else { render(); timer = setTimeout(tick, 650); }
  }
  timer = setTimeout(tick, 650);
}
function finishOperation(operation, title, detail) {
  state.history.unshift({ title, detail, steps: operation.steps.slice(0, operation.index).map((step) => step.label) });
  state.busy = null;
  render();
  toast(title);
}
function renderProgress() {
  const op = state.busy;
  $('#progress').hidden = !op;
  if (!op) { $('#progress').innerHTML = ''; return; }
  const step = op.steps[op.index];
  $('#progress').innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="progress-copy">${op.cancelled ? '正在停止…' : step.label}</span>${button(op.cancelled ? '等待停止' : '停止', 'stop', { small: true, disabled: op.cancelled || step.commit })}`;
}
function syncUpdate(target = 12) {
  if (isBlocked()) return;
  const steps = [];
  if (state.mirror < target) {
    steps.push({ label: '检查更新包…' }, { label: '导入更新…', commit: true, apply: () => { state.mirror = target; }, effect: `更新 #${target} 已导入镜像` });
  }
  const pending = state.repos.filter((repo) => repo.seq < Math.max(state.mirror, target));
  for (const repo of pending) steps.push({ label: `更新${repo.name}…`, apply: () => { repo.seq = state.mirror; }, effect: `${repo.name}已获取更新` });
  if (!steps.length) { toast('已经是最新'); return; }
  startOperation(`已同步更新 #${Math.max(target, state.mirror)}`, steps, '开发仓库已获取引用，本地分支与修改保留');
}
function importBack() {
  if (isBlocked() || state.scenario === 'collision') return;
  if (state.received) {
    const pending = state.reviews.filter((review) => review.status === 'received');
    if (!pending.length) return;
    startOperation('提交已整理', [{ label: '继续整理提交…', apply: () => {
      pending.forEach((review) => { review.status = 'ready'; state.pushSelected.add(review.name); });
    }, effect: '已完成剩余提交整理' }], '可以检查并推送');
    return;
  }
  startOperation('回传已导入，可检查推送', [
    { label: '检查回传包…' },
    { label: '接收回传…', commit: true, apply: () => {
      state.received = true;
      state.reviews = branchData.map((branch) => ({ ...branch, status: 'received' }));
    }, effect: '原始回传已接收' },
    { label: '整理提交…', apply: () => {
      state.reviews.forEach((review) => { review.status = 'ready'; state.pushSelected.add(review.name); });
    }, effect: '提交已在独立工作树中整理' },
  ], '2 个分支可推送');
}
function pushPlan() {
  if (isBlocked()) return;
  const selected = state.reviews.filter((review) => state.pushSelected.has(review.name) && review.status === 'ready');
  if (!selected.length) return;
  state.pushPlan = selected.map((review) => ({ name: review.name, sha: review.sha }));
  const count = selected.reduce((sum, review) => sum + review.commits.length, 0);
  const body = `<p>${selected.length} 个分支，${count} 个提交 → gitlab.internal/security/ti</p>` + selected.map((review) => `<h3 class="mono">${review.name}</h3>${review.commits.map((commit) => `<div class="commit">${escapeHtml(commit)}</div>`).join('')}`).join('') +
    `<details class="detail-toggle"><summary>技术详情</summary>${keyValues(selected.map((review) => [review.base, `<code>${review.sha}</code>`]))}<p style="margin-top:12px">仅快进推送；执行前复核提交。</p><button class="text-button" style="margin-top:12px" data-action="simulate-change">演示：分支新增提交</button></details>`;
  openDialog('确认推送', body, button('推送', 'push', { primary: true }));
}
function settings(locationOnly = false) {
  if (state.busy) return;
  if (locationOnly) {
    openDialog('传输目录', `<label class="field">目录<input id="transfer-path" value="${escapeHtml(state.transfer)}"></label>`, button('保存', 'save-location', { primary: true }));
    return;
  }
  openDialog('项目设置', `<label class="field">项目名称<input id="project-name" value="${escapeHtml(state.project)}"></label><label class="field">传输目录<input id="transfer-path" value="${escapeHtml(state.transfer)}"></label><details class="detail-toggle"><summary>仓库路径</summary>${keyValues(state.role === 'internal' ? [['镜像', '<code>D:/Mirrors/ti.git</code>'], ['工作仓库', '<code>D:/Repos/ti-work</code>']] : [['镜像', '<code>~/Mirrors/ti.git</code>'], ['开发仓库', '<code>~/Developer/ti<br>~/Developer/ti-agent</code>']])}</details>`, button('保存', 'save-settings', { primary: true }));
}
function handleAction(action, id) {
  const review = state.reviews.find((item) => item.name === id);
  switch (action) {
    case 'close': closeDialog(); break;
    case 'refresh': toast(state.scenario === 'corrupt' ? '同步记录仍无法读取' : '已刷新'); break;
    case 'export': {
      if (isBlocked()) break;
      if (state.exported && !state.full) { toast('没有新的更新'); break; }
      const next = { seq: state.exported ? state.exported.seq + 1 : 12, full: state.full };
      const filename = `ti-out-${String(next.seq).padStart(4, '0')}-${next.full ? 'full' : 'incr'}.bundle`;
      startOperation(`已导出更新 #${next.seq}`, [{ label: '拉取内网更新…' }, { label: '生成更新包…' }, { label: '保存更新包…', commit: true, apply: () => { state.exported = next; }, effect: '更新包已保存' }], `${state.transfer}/${filename}`);
      break;
    }
    case 'sync': if (state.scenario !== 'missing' && state.scenario !== 'collision') syncUpdate(state.mirror >= 12 ? state.mirror : 12); break;
    case 'full-package':
      openDialog('使用全量包 #15', `<p>跳过缺失更新，将镜像更新到 #15。</p><div class="commit">删除分支 <code>feature/legacy-export</code></div><details class="detail-toggle"><summary>其他变更</summary><p>main 更新 8 个提交；release/2.4 更新 4 个提交。</p></details>`, button('同步更新', 'confirm-full', { primary: true, disabled: isBlocked() }));
      break;
    case 'confirm-full': closeDialog(); state.scenario = 'normal'; $('#scenario').value = 'normal'; syncUpdate(15); break;
    case 'import-back': importBack(); break;
    case 'integrate':
      if (isBlocked() || !review) break;
      startOperation('提交已整理', [{ label: '整理提交…', apply: () => { review.status = 'ready'; state.pushSelected.add(review.name); }, effect: '提交已在独立工作树中整理' }], review.name);
      break;
    case 'push-plan': pushPlan(); break;
    case 'simulate-change': {
      const planned = state.pushPlan?.[0];
      const changed = state.reviews.find((item) => item.name === planned?.name);
      if (!changed) break;
      changed.sha = oid('9cf37a2');
      changed.commits = [...changed.commits, '补充输入参数校验'];
      $('[data-action="push"]').disabled = true;
      $('.dialog-body').insertAdjacentHTML('afterbegin', errorLine('提交已变化，请重新检查。', '', '', true));
      $('[data-action="simulate-change"]').disabled = true;
      break;
    }
    case 'push': {
      if (isBlocked() || !state.pushPlan?.length) break;
      if (state.pushPlan.some((plan) => state.reviews.find((item) => item.name === plan.name)?.sha !== plan.sha)) { toast('提交已变化，请重新检查'); break; }
      const plans = state.pushPlan.map((plan) => ({ ...plan }));
      closeDialog();
      startOperation('推送完成', plans.map((plan) => ({ label: `推送 ${plan.name}…`, apply: () => { state.reviews.find((item) => item.name === plan.name).status = 'pushed'; state.pushSelected.delete(plan.name); }, effect: `${plan.name} 已推送并核实` })), `${plans.length} 个分支已推送`);
      break;
    }
    case 'return-options':
      openDialog('回传格式', `<label class="check"><input type="radio" name="format" value="bundle" ${!state.patch ? 'checked' : ''}>Bundle</label><label class="check"><input type="radio" name="format" value="patch" ${state.patch ? 'checked' : ''}>Patch（单个分支）</label>`, button('确定', 'save-format', { primary: true }));
      break;
    case 'save-format': state.patch = $('input[name="format"]:checked').value === 'patch'; closeDialog(); render(); break;
    case 'return':
      if (isBlocked() || !state.selected.size || (state.patch && state.selected.size > 1)) break;
      startOperation('已导出回传 #17', [{ label: '检查所选提交…' }, { label: '生成回传包…' }, { label: '保存回传包…', commit: true, apply: () => { state.returned = true; }, effect: '回传包已保存' }], `${state.transfer}/ti-back-0017.${state.patch ? 'patch' : 'bundle'}`);
      break;
    case 'stop': if (state.busy && !state.busy.steps[state.busy.index].commit) { state.busy.cancelled = true; renderProgress(); } break;
    case 'conflict':
      openDialog('解决冲突', `<p>在下面的目录解决冲突并暂存文件。</p><p class="mono" style="margin-top:10px">D:/Reviews/${escapeHtml(review.name.replaceAll('/', '-'))}</p><h3>冲突文件</h3><div class="commit mono">src/query/StreamFilter.java</div><details class="detail-toggle"><summary>演示操作</summary><label class="check"><input id="resolved" type="checkbox">模拟文件已解决</label></details>`, button('中止整理', 'abort', { id: review.name, danger: true }) + button('继续', 'continue', { id: review.name, primary: true, disabled: true }));
      break;
    case 'continue':
      if (!$('#resolved')?.checked || isBlocked()) break;
      closeDialog();
      startOperation('整理完成', [{ label: '继续整理…', apply: () => { review.status = 'ready'; state.pushSelected.add(review.name); }, effect: '冲突处理完成' }], review.name);
      break;
    case 'abort':
      openDialog('中止本次整理？', '<p>恢复到整理前的分支。已接收的回传保留。</p>', button('中止整理', 'confirm-abort', { id: review.name, danger: true }));
      break;
    case 'confirm-abort':
      closeDialog();
      startOperation('已中止整理', [{ label: '恢复整理前的分支…', apply: () => { review.status = 'received'; }, effect: '分支已恢复，回传保留' }], review.name);
      break;
    case 'verify':
      if (isBlocked()) break;
      startOperation('推送结果已确认', [{ label: '检查远程分支…', apply: () => { review.status = 'pushed'; state.pushSelected.delete(review.name); }, effect: '远程提交与上次推送一致' }], '该分支已推送，无需重复操作');
      break;
    case 'resume':
      if (state.busy) break;
      startOperation('上次导出已完成', [{ label: '检查原文件…' }, { label: '继续保存…', commit: true, apply: () => { state.scenario = 'normal'; $('#scenario').value = 'normal'; if (state.role === 'internal') state.exported = { seq: 12, full: false }; else state.returned = true; }, effect: '原包与原序号已保存' }], '已恢复原来的包，未重新编号');
      break;
    case 'history':
      openDialog('最近记录', state.history.map((item) => `<article class="history-item">${escapeHtml(item.title)}<p>${escapeHtml(item.detail)}</p>${item.steps.length ? `<details><summary>日志</summary><pre>${escapeHtml(item.steps.join('\n'))}</pre></details>` : ''}</article>`).join(''));
      break;
    case 'files': {
      if (!state.exported) break;
      const name = `ti-out-${String(state.exported.seq).padStart(4, '0')}-${state.exported.full ? 'full' : 'incr'}.bundle`;
      openDialog('更新包', `<p class="mono">${escapeHtml(state.transfer)}/${name}</p><p class="mono" style="margin-top:10px">${name}.manifest.json</p>`);
      break;
    }
    case 'diagnose': openDialog('无法读取同步记录', '<p>state.json 内容损坏。核对已有包与状态备份后恢复，不能自动重置序号。</p>'); break;
    case 'package-details': openDialog('包内容不一致', '<p>同一序号对应了不同内容。请保留原文件，向发布端重新获取。</p>'); break;
    case 'location': if (!state.busy) settings(true); break;
    case 'settings': if (!state.busy) settings(); break;
    case 'save-settings': {
      const name = $('#project-name').value.trim();
      const path = $('#transfer-path').value.trim();
      if (!name || !path) { toast('请填写名称和目录'); break; }
      state.project = name; state.transfer = path; closeDialog(); render(); break;
    }
    case 'save-location': {
      const path = $('#transfer-path').value.trim();
      if (!path) { toast('请选择目录'); break; }
      state.transfer = path; closeDialog(); render(); break;
    }
    case 'project': openDialog('选择项目', `<div class="branch-row"><span class="branch-copy">${escapeHtml(state.project)}</span><span class="branch-state green">当前</span></div>`, button('项目设置', 'project-settings')); break;
    case 'project-settings': closeDialog(); settings(); break;
    case 'repo': openDialog('开发仓库', '<p class="mono">~/Developer/threat-intelligence</p>'); break;
    case 'setup-internal':
      openDialog('添加内网项目', '<label class="field">GitLab 地址<input id="setup-url" value="https://gitlab.internal/security/ti.git"></label><label class="field">本地目录<input value="D:/Repos/ti" readonly></label>', button('添加', 'complete-setup', { id: 'internal', primary: true }));
      break;
    case 'setup-external':
      openDialog('导入全量包', '<label class="field">文件<input value="ti-out-0011-full.bundle" readonly></label><p>Threat Intelligence · main · 18 个分支</p><details class="detail-toggle"><summary>项目身份</summary><p class="mono">7ae5136b-94bc-4e91-b9ab-0d1a76f237c8</p></details>', button('导入', 'complete-setup', { id: 'external', primary: true }));
      break;
    case 'complete-setup': closeDialog(); resetState(id, 'normal'); toast('项目已添加（演示）'); break;
  }
}
function resetState(role, scenario) {
  clearTimeout(timer);
  if ($('#dialog').open) closeDialog();
  state = initialState(role);
  state.scenario = scenario;
  if (scenario === 'conflict' || scenario === 'unknown') {
    state.role = 'internal'; state.tab = 'back'; state.received = true;
    state.reviews = branchData.map((branch, index) => ({ ...branch, status: index ? 'ready' : scenario === 'conflict' ? 'conflict' : 'unknown' }));
    state.pushSelected = new Set(state.reviews.filter((review) => review.status === 'ready').map((review) => review.name));
  }
  if (scenario === 'missing') { state.role = 'external'; state.tab = 'in'; }
  if (scenario === 'collision') state.tab = state.role === 'internal' ? 'back' : 'in';
  if (scenario === 'exportInterrupted') state.tab = state.role === 'internal' ? 'out' : 'return';
  $('#role').value = state.role;
  $('#scenario').value = scenario;
  render();
}
document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; render(); $(`[data-tab="${state.tab}"]`).focus(); return; }
  const action = event.target.closest('[data-action]');
  if (action && !action.disabled) handleAction(action.dataset.action, action.dataset.id);
});
document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.id === 'role') resetState(el.value, 'normal');
  else if (el.id === 'scenario') resetState(state.role, el.value);
  else if (el.id === 'full') state.full = el.checked;
  else if (el.name === 'return-branch') { el.checked ? state.selected.add(el.value) : state.selected.delete(el.value); render(); }
  else if (el.name === 'push-branch') { el.checked ? state.pushSelected.add(el.value) : state.pushSelected.delete(el.value); render(); }
  else if (el.id === 'resolved') $('[data-action="continue"]').disabled = !el.checked;
});
$('#tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const index = tabs.findIndex((tab) => tab.dataset.tab === state.tab);
  let target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[target].click();
});
$('#reset').addEventListener('click', () => resetState(state.role, state.scenario));
render();
