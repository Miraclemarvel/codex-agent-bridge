const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const route = (s) => (s ? `${s.provider} / ${s.model}` : "跟随后端默认");
const localTime = (s) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const labels = {
  queued: "排队中",
  submitting: "正在派发",
  running: "执行中",
  waiting_for_approval: "等待确认",
  waiting_for_input: "等待补充",
  stopping: "停止中",
  completed: "已交付",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "已中断",
  unknown: "结果未知",
  pending: "待交付",
  awaiting_review: "待验收",
  accepted: "验收通过",
  needs_rework: "需要返工",
  unverifiable: "暂无法验证",
};
let state,
  csrf = "",
  activeId = new URLSearchParams(location.search).get("agent"),
  catalog,
  draftVersion = 0,
  activeTestId = null,
  restoreFrom,
  formGeneration = 0,
  polling = false,
  currentTask;
function notify(message, error = false) {
  const dialog = document.querySelector("dialog[open]");
  if (dialog) {
    let box = dialog.querySelector(".dialog-notice");
    if (!box) {
      box = document.createElement("div");
      box.className = "notice dialog-notice";
      box.setAttribute("role", "alert");
      dialog.querySelector(".dialog-heading").after(box);
    }
    box.textContent = message;
    box.className = "notice dialog-notice" + (error ? " error" : "");
    if (error) box.scrollIntoView({ block: "nearest" });
  }
  const n = $("notice");
  n.textContent = message;
  n.hidden = false;
  n.className = "notice" + (error ? " error" : "");
}
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Bridge-CSRF": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const x = await r.json();
  if (!r.ok) {
    const e = new Error(x.message ?? "请求失败");
    e.code = x.code;
    throw e;
  }
  return x;
}
const agent = () => state?.agents.find((a) => a.agentId === activeId);
const realTasks = () =>
  state?.tasks.filter((t) => t.purpose !== "model_test") ?? [];
function stats() {
  const tasks = realTasks();
  const active = tasks.filter((t) =>
    [
      "queued",
      "submitting",
      "running",
      "waiting_for_input",
      "waiting_for_approval",
      "stopping",
    ].includes(t.execution),
  ).length;
  const rows = [
    ["◫", tasks.length, "协作任务"],
    ["↗", active, "正在进行"],
    [
      "◇",
      tasks.filter(
        (t) =>
          t.reviewState === "awaiting_review" ||
          t.reviewState === "needs_rework",
      ).length,
      "等待验收 / 返工",
    ],
    [
      "✓",
      tasks.filter((t) => t.reviewState === "accepted").length,
      "已通过验收",
    ],
  ];
  $("stats").innerHTML = rows
    .map(
      ([icon, value, label]) =>
        `<div class="stat"><span class="stat-icon">${icon}</span><div><strong>${value}</strong><small>${label}</small></div></div>`,
    )
    .join("");
}
function agents() {
  $("agent-count").textContent = state.agents.length;
  const picker = $("active-agent");
  if (document.activeElement !== picker) {
    picker.innerHTML = state.agents
      .map(
        (a) => `<option value="${esc(a.agentId)}">${esc(a.agentId)}</option>`,
      )
      .join("");
    picker.value = activeId ?? state.agents[0]?.agentId;
  }
  picker.onchange = () => loadAgent(picker.value);
  $("agent-list").innerHTML = state.agents
    .map(
      (a) =>
        `<button class="agent-item ${a.agentId === activeId ? "selected" : ""}" data-agent="${esc(a.agentId)}"><span class="avatar ${a.kind === "deepseek" ? "dsh" : ""}">${a.kind === "deepseek" ? "D" : "H"}</span><span>${a.kind === "deepseek" ? "DeepSeek Harness" : "Hermes"}<small>${esc(a.current.selection?.model ?? "跟随后端")}</small></span></button>`,
    )
    .join("");
  $("agent-list")
    .querySelectorAll("button")
    .forEach((b) => (b.onclick = () => loadAgent(b.dataset.agent)));
  $("agent-summary").innerHTML = state.agents
    .map(
      (a) =>
        `<div class="summary-row"><div>${esc(a.agentId)}<small class="muted">${a.kind === "deepseek" ? "本地进程 · headless" : "HTTP · Runs API"}</small></div><div>${esc(a.current.selection?.provider ?? "后端默认")}<small class="muted">配置版本 v${a.current.revision}</small></div><div class="overflow-wrap">${esc(a.current.selection?.model ?? "未固定模型")}<small class="muted">${a.current.testId ? "已通过连接测试" : "初始配置"}</small></div><button class="ghost" data-agent="${esc(a.agentId)}">配置 ↗</button></div>`,
    )
    .join("");
  $("agent-summary")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          loadAgent(b.dataset.agent);
          document
            .querySelector(".config-panel")
            .scrollIntoView({ behavior: "smooth", block: "start" });
        }),
    );
}
function board() {
  const tasks = [...state.tasks]
    .reverse()
    .filter((t) => $("show-tests").checked || t.purpose !== "model_test");
  $("task-count").textContent = tasks.length;
  const columns = [
    [
      "进行中",
      (t) =>
        ![
          "completed",
          "failed",
          "cancelled",
          "interrupted",
          "unknown",
        ].includes(t.execution),
    ],
    [
      "待验收 / 需处理",
      (t) =>
        t.reviewState !== "accepted" &&
        ["completed", "failed", "cancelled", "interrupted", "unknown"].includes(
          t.execution,
        ),
    ],
    ["已完成", (t) => t.reviewState === "accepted"],
  ];
  $("board").innerHTML = columns
    .map(([title, filter]) => {
      const rows = tasks.filter(filter);
      return `<section class="column"><div class="column-heading"><span class="status-dot"></span>${title}<span class="number">${rows.length.toString().padStart(2, "0")}</span></div>${rows.length ? rows.map((t) => `<button class="task-card" data-task="${esc(t.id)}"><div class="task-id"><span>${t.purpose === "model_test" ? "MODEL TEST" : t.id.slice(0, 8).toUpperCase()}</span><span>↗</span></div><h3>${esc(t.objective)}</h3><div class="model">${esc(t.requestedModel?.selection?.model ?? "旧任务 · 模型未记录")}</div><div class="card-footer"><span>${esc(t.agentId)} · 第 ${t.attempt} 次</span><span class="badge ${t.reviewState === "needs_rework" ? "amber" : t.execution === "failed" || t.execution === "unknown" ? "red" : ""}">${esc(labels[t.reviewState === "pending" ? t.execution : t.reviewState] ?? t.execution)}</span></div></button>`).join("") : '<div class="empty">' + (title === "进行中" ? "暂时没有进行中的任务<br>新任务会从这里开始" : "此列暂无任务") + "</div>"}</section>`;
    })
    .join("");
  $("board")
    .querySelectorAll("[data-task]")
    .forEach((b) => (b.onclick = () => openTask(b.dataset.task)));
}
async function refreshState() {
  if (polling) return;
  polling = true;
  try {
    state = await api("/api/state");
    csrf = state.csrf;
    $("connection").textContent = "● 本地服务已连接";
    stats();
    agents();
    board();
    if (!activeId || !agent()) activeId = state.agents[0]?.agentId;
    if ($("provider")) renderTestAndHistory();
  } catch (e) {
    $("connection").textContent = "服务连接中断";
    notify(e.message, true);
  } finally {
    polling = false;
  }
}
function selected() {
  const s = { provider: $("provider").value, model: $("model").value.trim() };
  if ($("effort")?.value) s.reasoningEffort = $("effort").value;
  if (agent()?.kind === "deepseek" && $("credential")?.value)
    s.credentialRef = $("credential").value;
  return s;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function updateEfforts(value = "") {
  const m = catalog.providers
    .find((p) => p.id === $("provider").value)
    ?.models.find((m) => m.id === $("model").value.trim());
  $("effort").innerHTML =
    '<option value="">跟随模型默认</option>' +
    (m?.reasoningEfforts ?? [])
      .map((e) => `<option value="${esc(e)}">${esc(e)}</option>`)
      .join("");
  $("effort").value = (m?.reasoningEfforts ?? []).includes(value) ? value : "";
  $("effort").disabled = !m?.reasoningEfforts?.length;
  $("effort-hint").textContent = m?.reasoningEfforts?.length
    ? "推理强度来自该模型的能力目录。"
    : "后端未提供可选推理强度，将使用模型默认。";
}
function updateModels(model, effort) {
  const p = catalog.providers.find((p) => p.id === $("provider").value);
  $("model-options").innerHTML = (p?.models ?? [])
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
    .join("");
  $("model").value = model ?? p?.models[0]?.id ?? "";
  updateEfforts(effort);
}
function changed() {
  activeTestId = null;
  renderTestAndHistory();
}
function fillDraft(selection) {
  if (!selection) return;
  $("provider").value = selection.provider;
  updateModels(selection.model, selection.reasoningEffort);
  if ($("credential")) $("credential").value = selection.credentialRef ?? "";
  changed();
}
async function loadAgent(id, refresh = false) {
  activeId = id;
  activeTestId = null;
  restoreFrom = undefined;
  const gen = ++formGeneration;
  agents();
  const a = agent();
  if (!a) return;
  draftVersion = a.current.revision;
  $("config-body").innerHTML = '<div class="empty">正在读取实际模型目录…</div>';
  try {
    const c = await api(
      `/api/agents/${encodeURIComponent(id)}/models${refresh ? "?refresh=1" : ""}`,
    );
    if (gen !== formGeneration) return;
    catalog = c;
    const s = a.current.selection;
    const provider =
      s?.provider ??
      c.providers.find((p) => p.available && p.models.length)?.id ??
      c.providers[0]?.id;
    $("config-body").innerHTML =
      `<div class="config-content"><div class="config-main"><div class="current-model">${esc(a.agentId)} · 当前默认<strong>${esc(s?.model ?? "跟随后端默认")}</strong><small id="current-version">${esc(s?.provider ?? "未固定 Provider")} · 配置 v${a.current.revision}</small></div><label><span class="field-heading"><span>Provider</span><button type="button" class="link-button" id="refresh-models">刷新目录 ↻</button></span><select id="provider" aria-label="Provider">${c.providers.map((p) => `<option value="${esc(p.id)}" ${!p.available ? "disabled" : ""}>${esc(p.name)}${p.available ? "" : " · 未认证"}</option>`).join("")}</select></label><label>默认模型<input id="model" list="model-options" autocomplete="off" placeholder="搜索或输入模型 ID"><datalist id="model-options"></datalist></label><label>推理强度<select id="effort"></select></label><p class="hint" id="effort-hint"></p>${a.kind === "deepseek" ? `<label>已有凭据引用<select id="credential"><option value="">选择已有凭据</option>${c.credentialRefs.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select></label>` : '<p class="hint">认证由 Hermes 管理，使用 Provider 已配置的凭据。</p>'}</div><div class="config-side"><div class="model-preview" id="model-preview"></div><div class="actions"><button class="secondary" id="test-model">测试连接</button><button class="primary" id="save-model" disabled>保存默认模型</button></div><p class="hint">测试将发送一次简短推理请求。保存后，新提交的任务使用此配置。</p><div id="test-result"></div><div class="history"><h3>配置版本 <span id="restore-tag"></span></h3><div id="model-history"></div></div></div></div>`;
    $("provider").value = provider;
    updateModels(s?.model, s?.reasoningEffort);
    if ($("credential"))
      $("credential").value = s?.credentialRef ?? c.credentialRefs[0] ?? "";
    $("provider").onchange = () => {
      restoreFrom = undefined;
      updateModels();
      changed();
    };
    $("model").oninput = () => {
      restoreFrom = undefined;
      updateEfforts($("effort").value);
      changed();
    };
    $("effort").onchange = changed;
    if ($("credential")) $("credential").onchange = changed;
    $("refresh-models").onclick = () => loadAgent(activeId, true);
    $("test-model").onclick = testModel;
    $("save-model").onclick = saveModel;
    renderTestAndHistory();
  } catch (e) {
    if (gen !== formGeneration) return;
    $("config-body").innerHTML =
      `<div class="empty">模型目录暂不可用<br>${esc(e.message)}<br><br><button id="retry-catalog" class="secondary">重新连接</button></div>`;
    $("retry-catalog").onclick = () => loadAgent(id, true);
  }
}
function renderTestAndHistory() {
  const a = agent();
  if (!a || !$("provider")) return;
  const s = selected(),
    tests = a.tests;
  const test = activeTestId
    ? tests.find((t) => t.id === activeTestId)
    : tests.find(
        (t) => t.baseRevision === draftVersion && same(t.selection, s),
      );
  const conflict = a.current.revision !== draftVersion;
  const model = catalog.providers
    .find((p) => p.id === s.provider)
    ?.models.find((m) => m.id === s.model);
  const valid =
    !!s.model &&
    !!catalog.providers.find((p) => p.id === s.provider) &&
    (a.kind !== "deepseek" || !!s.credentialRef);
  $("test-model").disabled = !valid || conflict || test?.status === "running";
  $("save-model").disabled =
    conflict ||
    test?.status !== "passed" ||
    !same(test?.selection, s) ||
    Date.parse(test.expiresAt) < Date.now();
  $("model-preview").textContent =
    `待${restoreFrom !== undefined ? "恢复" : "应用"}：${route(s)}${s.reasoningEffort ? " · " + s.reasoningEffort : ""}`;
  $("restore-tag").textContent =
    restoreFrom !== undefined ? `· 待恢复 v${restoreFrom}` : "";
  let text = "选择模型后测试连接，检查该路由是否可用。",
    error = false;
  if (!model)
    text =
      "该 ID 不在当前目录中；可以测试，但保存需要后端明确回报相同的实际模型。";
  if (conflict) {
    text = "配置已被其他操作更新，请刷新目录后重新测试。";
    error = true;
  } else if (test) {
    text =
      test.status === "running"
        ? "正在执行真实模型测试，请稍候…"
        : test.status === "passed"
          ? `连接测试通过。实际模型：${test.actual ? route(test.actual) : "未回报"}。`
          : (test.error ?? "模型测试失败，原默认配置仍有效。");
    error = test.status === "failed";
  }
  $("test-result").innerHTML =
    `<div class="test-result ${error ? "error" : ""}" role="status">${esc(text)}</div>`;
  $("model-history").innerHTML = a.history
    .slice(0, 8)
    .map(
      (v) =>
        `<div class="history-row"><span>v${v.revision}</span><div title="${esc(route(v.selection))}">${esc(v.selection?.model ?? "跟随后端")}<small>${localTime(v.createdAt)}${v.restoredFrom !== undefined ? " · 恢复自 v" + v.restoredFrom : ""}</small></div>${v.revision !== a.current.revision && v.selection ? `<button class="link-button" data-revision="${v.revision}">载入恢复</button>` : '<span class="badge">当前</span>'}</div>`,
    )
    .join("");
  $("model-history")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          restoreFrom = Number(b.dataset.revision);
          fillDraft(
            a.history.find((v) => v.revision === restoreFrom).selection,
          );
          notify(
            `已载入 v${restoreFrom}。测试连接后保存，形成一个新的配置版本。`,
          );
        }),
    );
}
async function testModel() {
  const id = activeId,
    s = selected();
  $("test-model").disabled = true;
  try {
    const t = await api(`/api/agents/${id}/test`, {
      selection: s,
      expectedRevision: draftVersion,
    });
    if (id === activeId) {
      activeTestId = t.id;
      await refreshState();
      renderTestAndHistory();
    }
  } catch (e) {
    notify(`${e.code ?? ""}：${e.message}`, true);
    renderTestAndHistory();
  }
}
async function saveModel() {
  const a = agent(),
    s = selected();
  const test = activeTestId
    ? a.tests.find((t) => t.id === activeTestId)
    : a.tests.find(
        (t) => same(t.selection, s) && t.baseRevision === draftVersion,
      );
  if (!test) return;
  $("save-model").disabled = true;
  try {
    await api(`/api/agents/${activeId}/defaults`, {
      testId: test.id,
      expectedRevision: draftVersion,
      ...(restoreFrom !== undefined ? { restoredFrom: restoreFrom } : {}),
    });
    notify("默认模型已保存并回读确认，新任务将使用新配置。");
    await refreshState();
    await loadAgent(activeId);
  } catch (e) {
    notify(`${e.code ?? ""}：${e.message}`, true);
    renderTestAndHistory();
  }
}
async function openTask(id) {
  try {
    const result = await api(`/api/tasks/${id}`);
    currentTask = result.task;
    const t = result.task,
      a = t.attempts.at(-1),
      runtime = a.remote?.runtime;
    const actual =
      runtime?.provider && runtime?.model ? route(runtime) : "未回报";
    $("dialog-title").textContent = t.contract.objective;
    $("task-detail").innerHTML =
      `<div class="detail-meta"><div>执行状态<strong>${esc(labels[a.execution])} · 第 ${a.number} 次</strong></div><div>本次请求模型<strong>${esc(route(a.modelBinding?.selection))}</strong><small>配置 ${a.modelBinding ? "v" + a.modelBinding.revision : "未记录"}</small></div><div>本次实际模型<strong>${esc(actual)}</strong></div></div><p class="hint">任务 ${esc(t.id)} · ${esc(t.agentId)} · ${esc(labels[t.reviewState])}</p><h3 class="detail-title">交付报告</h3><pre class="report">${esc(a.snapshot?.artifacts.find((x) => x.source === "agent_report")?.text ?? "尚未收到交付物")}</pre>${a.snapshot ? `<p class="hint overflow-wrap">交付摘要 ${esc(a.snapshot.digest)}<br>文件内容核对：${t.deliveryCurrent ? "当前一致" : "内容已变化或文件不可用"}</p>` : ""}<h3 class="detail-title">执行记录</h3>${result.events.map((e) => `<div class="event-line">${localTime(e.createdAt)} · ${esc(e.type)}</div>`).join("")}${t.purpose !== "model_test" && a.execution === "completed" && a.snapshot ? `<h3 class="detail-title">独立验收</h3><p class="hint">逐项填写你实际检查到的证据。Agent 的报告本身不能代替验证。</p><div id="checks">${t.contract.acceptance.map((c) => `<div class="check-row"><label><input type="checkbox" data-criterion="${esc(c.id)}">${esc(c.description)}</label><textarea data-evidence="${esc(c.id)}" placeholder="填写独立验证过程、结果及文件版本"></textarea></div>`).join("")}</div><label>验收说明 / 返工反馈<textarea id="review-feedback" placeholder="说明已验证内容，或需要修正的具体问题"></textarea></label><label class="inline-toggle"><input type="checkbox" id="latest-model">本次返工使用当前默认模型（默认沿用原任务模型）</label><div class="actions"><button class="primary" id="accept-task">验收通过</button><button class="secondary" id="rework-task">退回返工</button><button class="secondary" id="unverifiable-task">暂无法验证</button></div><details><summary class="hint">将本地文件加入交付快照</summary><textarea id="capture-paths" placeholder="每行一个明确的本地文件路径"></textarea><button class="ghost" id="capture-files">捕获文件并生成新摘要</button></details>` : ""}<button class="ghost danger" id="cancel-task">请求停止执行</button>`;
    if ($("accept-task")) {
      $("accept-task").onclick = () => reviewTask("accept");
      $("rework-task").onclick = () => reviewTask("rework");
      $("unverifiable-task").onclick = () => reviewTask("unverifiable");
      $("capture-files").onclick = async () => {
        try {
          await api(`/api/tasks/${id}/capture`, {
            attemptId: a.id,
            digest: a.snapshot.digest,
            paths: $("capture-paths")
              .value.split("\n")
              .map((x) => x.trim())
              .filter(Boolean),
          });
          await openTask(id);
        } catch (e) {
          notify(e.message, true);
        }
      };
    }
    $("cancel-task").onclick = async () => {
      try {
        await api(`/api/tasks/${id}/cancel`, {});
        await openTask(id);
        await refreshState();
      } catch (e) {
        notify(e.message, true);
      }
    };
    if (!$("task-dialog").open) $("task-dialog").showModal();
  } catch (e) {
    notify(e.message, true);
  }
}
async function reviewTask(decision) {
  const t = currentTask,
    a = t.attempts.at(-1);
  const checks = t.contract.acceptance.map((c) => ({
    criterionId: c.id,
    passed: document.querySelector(`[data-criterion="${c.id}"]`).checked,
    evidence: document.querySelector(`[data-evidence="${c.id}"]`).value.trim(),
  }));
  if (checks.some((c) => !c.evidence) || !$("review-feedback").value.trim()) {
    notify("请为每项标准填写独立证据，并补充验收说明。", true);
    return;
  }
  try {
    let task;
    if (t.reviewState === "needs_rework" && decision === "rework") task = t;
    else
      task = await api(`/api/tasks/${t.id}/review`, {
        attemptId: a.id,
        digest: a.snapshot.digest,
        decision,
        checks,
        feedback: $("review-feedback").value.trim(),
      });
    if (decision === "rework")
      await api(`/api/tasks/${t.id}/rework`, {
        reviewId: task.reviews.at(-1).id,
        useLatestDefaults: $("latest-model").checked,
      });
    $("task-dialog").close();
    notify(
      decision === "accept"
        ? "验收已记录。"
        : decision === "rework"
          ? "返工任务已排队。"
          : "已记录为暂无法验证。",
    );
    await refreshState();
  } catch (e) {
    notify(e.message, true);
  }
}
$("refresh").onclick = async () => {
  await refreshState();
  await loadAgent(activeId, true);
};
$("show-tests").onchange = board;
$("nav-agents").onclick = () => {
  document
    .querySelector(".config-panel")
    .scrollIntoView({ behavior: "smooth" });
  $("nav-agents").classList.add("active");
  $("nav-overview").classList.remove("active");
};
$("nav-overview").onclick = () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("nav-overview").classList.add("active");
  $("nav-agents").classList.remove("active");
};
$("close-dialog").onclick = () => $("task-dialog").close();
$("close-new").onclick = () => $("new-dialog").close();
$("new-task").onclick = () => {
  $("new-agent").innerHTML = state.agents
    .map(
      (a) =>
        `<option value="${esc(a.agentId)}">${esc(a.agentId)} · ${esc(a.current.selection?.model ?? "后端默认")}</option>`,
    )
    .join("");
  $("new-agent").value = activeId;
  $("new-dialog").showModal();
};
$("new-form").onsubmit = async (e) => {
  e.preventDefault();
  const lines = (id) =>
    $(id)
      .value.split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  try {
    await api("/api/tasks", {
      agentId: $("new-agent").value,
      idempotencyKey: crypto.randomUUID(),
      contract: {
        objective: $("new-objective").value,
        baseline: $("new-baseline").value,
        scope: lines("new-scope"),
        deliverables: lines("new-deliverables"),
        acceptance: lines("new-acceptance").map((description, i) => ({
          id: "c" + (i + 1),
          description,
        })),
        maxAttempts: Number($("new-attempts").value),
        timeoutSeconds: Number($("new-timeout").value),
      },
    });
    $("new-dialog").close();
    $("new-form").reset();
    notify("任务已提交，已固定当前模型配置。");
    await refreshState();
  } catch (e) {
    notify(e.message, true);
  }
};
await refreshState();
if (activeId) await loadAgent(activeId);
setInterval(() => {
  void refreshState();
}, 2000);
