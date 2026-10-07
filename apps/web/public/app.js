"use strict";

const state = { csrf: null, view: "jobs", jobId: null, stream: null };

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.method && options.method !== "GET" ? { "x-csrf-token": state.csrf ?? "" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409) {
    throw new Error(body.message || body.error || `HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function badge(text) {
  return el("span", { class: `badge ${text}` }, text);
}

function newRequestId() {
  return `web-${crypto.randomUUID()}`;
}

async function render() {
  if (state.stream) { state.stream.close(); state.stream = null; }
  const main = $("#main");
  main.replaceChildren();
  if (!state.csrf) {
    main.append(loginView());
    return;
  }
  $("#nav").hidden = false;
  try {
    if (state.view === "jobs") main.append(await jobsView());
    else if (state.view === "new") main.append(newJobView());
    else if (state.view === "projects") main.append(await projectsView());
    else if (state.view === "job") main.append(await jobView(state.jobId));
  } catch (cause) {
    // A failed read (expired session, network) shows a reason and a way back, not a blank page.
    main.append(el("div", { class: "card" },
      el("p", { class: "error" }, `Could not load this view: ${String(cause.message)}`),
      el("button", { onclick: async () => { await fetch("/api/session/end", { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": state.csrf } }); state.csrf = null; await render(); } }, "Sign in again")));
  }
}

function loginView() {
  const password = el("input", { type: "password", autocomplete: "current-password", placeholder: "Owner password" });
  const error = el("p", { class: "error" });
  const form = el("form", { class: "card", onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: password.value }),
      });
      const body = await response.json();
      if (!response.ok) { error.textContent = body.error === "auth_not_configured" ? "The service has no owner password configured." : "Sign-in failed."; return; }
      state.csrf = body.csrfToken;
      await render();
    } catch { error.textContent = "Sign-in failed."; }
  } },
    el("label", {}, "Owner sign-in"),
    password,
    el("p", {}, el("button", { class: "primary", type: "submit" }, "Sign in")),
    error,
  );
  return el("section", {}, form);
}

async function jobsView() {
  const { body } = await api("/api/jobs");
  const list = el("div", {}, ...(body.jobs.length === 0
    ? [el("p", { class: "muted card" }, "No threads yet. Start one with New request.")]
    : body.jobs.map((job) => el("div", { class: "card" },
        el("div", { class: "row" },
          el("strong", {}, job.title),
          badge(job.stage),
          badge(job.runState),
          el("span", { class: "muted" }, job.projectId),
          el("span", { class: "muted" }, new Date(job.updatedAt).toLocaleString()),
        ),
        job.issue ? el("p", { class: "muted" }, `issue ${job.issue.repoSlug}#${job.issue.issueNumber}`) : null,
        el("button", { onclick: () => { state.jobId = job.jobId; state.view = "job"; void render(); } }, "Open"),
      ))));
  return list;
}

function newJobView() {
  const projects = [];
  const projectSelect = el("select", { id: "project" });
  const title = el("input", { id: "title", maxlength: 200, placeholder: "Add a goods-ready screen" });
  const request = el("textarea", { id: "request", placeholder: "Let the office allocate finished items to orders." });
  const error = el("p", { class: "error" });
  void api("/api/projects").then(({ body }) => {
    projects.push(...body.projects);
    projectSelect.replaceChildren(...projects.map((project) => el("option", { value: project.projectId }, `${project.projectId} (${project.repoSlug})`)));
  });
  return el("form", { class: "card", onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      const { body } = await api("/api/jobs", { method: "POST", body: JSON.stringify({
        requestId: newRequestId(),
        projectId: projectSelect.value,
        title: title.value,
        request: request.value,
      }) });
      state.jobId = body.job.jobId;
      state.view = "job";
      await render();
    } catch (cause) { error.textContent = String(cause.message); }
  } },
    el("label", {}, "Project"), projectSelect,
    el("label", {}, "Title"), title,
    el("label", {}, "Describe the change"), request,
    el("p", {}, el("button", { class: "primary", type: "submit" }, "Start thread")),
    error,
  );
}

async function projectsView() {
  const [{ body: hosts }, { body: projects }] = await Promise.all([api("/api/hosts"), api("/api/projects")]);
  const hostId = el("input", { placeholder: "runner-a" });
  const address = el("input", { placeholder: "runner.internal" });
  const sshUser = el("input", { placeholder: "slice-runner" });
  const runnerRoot = el("input", { placeholder: "/srv/slice/jobs" });
  const projectId = el("input", { placeholder: "demo-app" });
  const repoSlug = el("input", { placeholder: "you/demo-app" });
  const branch = el("input", { placeholder: "main" });
  const checkId = el("input", { placeholder: "test" });
  const checkCommand = el("input", { placeholder: "npm test" });
  const error = el("p", { class: "error" });
  return el("section", {},
    el("div", { class: "card" },
      el("h3", {}, "Registered hosts"),
      ...hosts.hosts.map((host) => el("p", {}, `${host.hostId} — ${host.address} (${host.os}, ${host.sshUser}, ${host.runnerRoot})`)),
      hosts.hosts.length === 0 ? el("p", { class: "muted" }, "None yet.") : null,
      el("div", { class: "row" }, hostId, address, sshUser, runnerRoot,
        el("button", { class: "primary", onclick: async () => {
          try { await api("/api/hosts", { method: "POST", body: JSON.stringify({ hostId: hostId.value, address: address.value, os: "linux", sshUser: sshUser.value, runnerRoot: runnerRoot.value }) }); await render(); }
          catch (cause) { error.textContent = String(cause.message); }
        } }, "Add host")),
    ),
    el("div", { class: "card" },
      el("h3", {}, "Registered projects"),
      ...projects.projects.map((project) => el("p", {},
        `${project.projectId} — ${project.repoSlug} @ ${project.hostId} `, badge(project.status),
        " ", el("button", { onclick: async () => {
          await api(`/api/projects/${project.projectId}/status`, { method: "POST", body: JSON.stringify({ status: project.status === "active" ? "paused" : "active" }) });
          await render();
        } }, project.status === "active" ? "Pause" : "Activate"),
      )),
      projects.projects.length === 0 ? el("p", { class: "muted" }, "None yet.") : null,
      el("div", { class: "row" }, projectId, repoSlug, branch, checkId, checkCommand,
        el("button", { class: "primary", onclick: async () => {
          try {
            await api("/api/projects", { method: "POST", body: JSON.stringify({
              projectId: projectId.value, repoSlug: repoSlug.value, defaultBranch: branch.value,
              hostId: hostId.value || (hosts.hosts[0] && hosts.hosts[0].hostId),
              buildProfile: { setup: [], checks: [{ id: checkId.value, command: checkCommand.value }] },
            }) });
            await render();
          } catch (cause) { error.textContent = String(cause.message); }
        } }, "Add project")),
      error,
    ),
  );
}

async function jobView(jobId) {
  const { body } = await api(`/api/jobs/${jobId}`);
  const job = body.job;
  const events = el("ul", { class: "events" });
  const questions = el("div", {});
  const instruction = el("input", { placeholder: "Keep the old screen until the new one is live" });
  const status = el("div", { class: "row" }, badge(job.stage), badge(job.runState), el("span", { class: "muted" }, `command revision ${job.commandRevision}`));

  for (const event of body.events) {
    events.append(el("li", {}, el("time", {}, new Date(event.createdAt).toLocaleTimeString()), `${event.type} `, el("span", { class: "muted" }, JSON.stringify(event.payload))));
  }

  for (const question of body.questions) {
    const answer = question.choices.length > 0 ? el("select", {}, ...question.choices.map((choice) => el("option", { value: choice }, choice))) : el("input", { placeholder: "Your answer" });
    const answerError = el("p", { class: "error" });
    questions.append(el("div", { class: "card" },
      el("strong", {}, question.question),
      el("div", { class: "row" }, answer,
        el("button", { class: "primary", onclick: async () => {
          try {
            const result = await api(`/api/jobs/${jobId}/requirements/answers`, { method: "POST", body: JSON.stringify({ questionId: question.questionId, revision: question.revision, answer: answer.value }) });
            if (result.status === 409) {
              answerError.textContent = "That answer is stale — the question was already answered or superseded.";
              return;
            }
            await render();
          } catch (cause) {
            answerError.textContent = String(cause.message);
          }
        } }, "Answer")),
      answerError,
    ));
  }

  const actionError = el("p", { class: "error" });
  const act = async (path: string): Promise<void> => {
    try {
      const result = await api(`/api/jobs/${jobId}/${path}`, { method: "POST", body: "{}" });
      if (result.status === 409) {
        actionError.textContent = result.body.message ?? "That action conflicts with the job's current state.";
        return;
      }
      await render();
    } catch (cause) {
      actionError.textContent = String(cause.message);
    }
  };
  const actions = el("div", {},
    el("div", { class: "row" },
      el("button", { onclick: () => void act("pause") }, "Pause"),
      el("button", { onclick: () => void act("resume") }, "Resume"),
      el("button", { onclick: () => void act("cancel") }, "Cancel"),
    ),
    actionError,
  );

  const stream = new EventSource(`/api/jobs/${jobId}/events`, { withCredentials: true });
  state.stream = stream;
  stream.addEventListener("snapshot", (message) => {
    const snapshot = JSON.parse(message.data);
    status.replaceChildren(badge(snapshot.job.stage), badge(snapshot.job.runState), el("span", { class: "muted" }, `command revision ${snapshot.job.commandRevision}`));
  });
  stream.addEventListener("event", (message) => {
    const event = JSON.parse(message.data);
    events.append(el("li", {}, el("time", {}, new Date(event.createdAt).toLocaleTimeString()), `${event.type} `, el("span", { class: "muted" }, JSON.stringify(event.payload))));
    if (["paused", "resumed", "cancelled", "requirements_ready", "question_asked", "question_answered", "blocked"].includes(event.type)) void render();
  });

  return el("section", {},
    el("div", { class: "card" }, el("h3", {}, job.title), status,
      job.issue ? el("p", { class: "muted" }, `from issue ${job.issue.repoSlug}#${job.issue.issueNumber} (${job.issue.url})`) : null),
    questions,
    (() => {
      const steerForm = el("form", { class: "card", onsubmit: async (event) => {
        event.preventDefault();
        const result = await api(`/api/jobs/${jobId}/steer`, { method: "POST", body: JSON.stringify({
          requestId: newRequestId(), instruction: instruction.value, expectedCommandRevision: job.commandRevision,
        }) });
        if (result.status === 409) {
          // A stale revision is refused without applying anything; show why and keep the current view.
          steerForm.append(el("p", { class: "error" }, "Stale command revision — the thread state is shown instead; nothing was applied."));
          return;
        }
        await render();
      } },
        el("label", {}, "Steer this thread"),
        instruction,
        el("p", {}, el("button", { class: "primary", type: "submit" }, "Send instruction")));
      return steerForm;
    })(),
    actions,
    el("div", { class: "card" }, el("h3", {}, "Thread activity"), events),
  );
}

$("#signout").addEventListener("click", async () => {
  await fetch("/api/session/end", { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": state.csrf } });
  state.csrf = null;
  await render();
});
for (const button of document.querySelectorAll("#nav button[data-view]")) {
  button.addEventListener("click", () => { state.view = button.dataset.view; void render(); });
}

(async () => {
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (response.ok) {
      // A live session still needs the CSRF token, which only login returns; re-authenticate is not possible
      // without the password, so a page reload starts a fresh login. The session cookie stays HttpOnly.
    }
  } catch { /* offline */ }
  await render();
})();
