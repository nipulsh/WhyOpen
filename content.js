/**
 * IntentTab — Content script
 * Shows the intent prompt, sticky bar, and session timer on web pages.
 */

(function () {
  "use strict";

  const ROOT_ID = "intenttab-root";
  const DEFAULT_BAR_HEIGHT = 48;
  const COMPLETION_CHECK_MINUTES = 30;
  let timerInterval = null;
  let currentSession = null;
  let promptVisible = false;
  let completionPromptVisible = false;

  /** --- Utilities --- */

  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  function getRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function clearRoot() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.innerHTML = "";
    stopTimer();
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function getElapsedSeconds() {
    if (!currentSession) return 0;
    return Math.floor((Date.now() - currentSession.openedAt) / 1000);
  }

  /** Shift page content down so fixed headers (e.g. YouTube search) stay visible */
  function applyPageOffset(barEl) {
    const height = barEl?.offsetHeight || DEFAULT_BAR_HEIGHT;
    document.documentElement.style.setProperty(
      "--intenttab-bar-height",
      `${height}px`,
    );
    document.documentElement.classList.add("it-has-bar");
  }

  function removePageOffset() {
    document.documentElement.classList.remove("it-has-bar");
    document.documentElement.style.removeProperty("--intenttab-bar-height");
  }

  /** --- Prompt UI --- */

  function showPrompt(data) {
    if (promptVisible || currentSession) return;
    promptVisible = true;

    const root = getRoot();
    root.innerHTML = `
      <div class="it-overlay" id="it-overlay">
        <div class="it-modal" role="dialog" aria-labelledby="it-modal-title" aria-modal="true">
          <div class="it-modal-icon">◎</div>
          <h2 class="it-modal-title" id="it-modal-title">Why are you opening this tab?</h2>
          <p class="it-modal-subtitle">${escapeHtml(data.hostname)}</p>
          <textarea
            class="it-input"
            id="it-reason-input"
            placeholder="e.g. Research project deadline, check one message…"
            rows="3"
            maxlength="280"
          ></textarea>
          <div class="it-modal-actions">
            <button class="it-btn it-btn-primary" id="it-submit-btn">Set intention</button>
          </div>
        </div>
      </div>
    `;

    document.body.classList.add("it-blurred");

    const input = root.querySelector("#it-reason-input");
    const submitBtn = root.querySelector("#it-submit-btn");

    input.focus();

    submitBtn.addEventListener("click", () =>
      submitReason(data, input.value.trim()),
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitReason(data, input.value.trim());
      }
    });
  }

  async function submitReason(data, reason) {
    if (!reason) {
      shakeModal();
      return;
    }

    const response = await sendMessage({
      type: "SUBMIT_REASON",
      reason,
      url: data.url || location.href,
      hostname: data.hostname || location.hostname,
      title: data.title || document.title,
    });

    if (response?.ok) {
      promptVisible = false;
      document.body.classList.remove("it-blurred");
      currentSession = response.session;
      showStickyBar();
    }
  }

  function shakeModal() {
    const modal = document.querySelector(".it-modal");
    if (modal) {
      modal.classList.add("it-shake");
      setTimeout(() => modal.classList.remove("it-shake"), 500);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /** --- Sticky bar UI --- */

  function showStickyBar() {
    if (!currentSession) return;

    const root = getRoot();
    root.innerHTML = `
      <div class="it-sticky-bar" id="it-sticky-bar">
        <div class="it-sticky-inner">
          <div class="it-sticky-left">
            <span class="it-sticky-dot"></span>
            <div class="it-sticky-text">
              <span class="it-sticky-reason">${escapeHtml(currentSession.reason)}</span>
              <span class="it-sticky-site">${escapeHtml(currentSession.hostname)}</span>
            </div>
          </div>
          <div class="it-sticky-right">
            <div class="it-timer" id="it-timer">${formatDuration(getElapsedSeconds())}</div>
            <button class="it-btn it-btn-ghost" id="it-close-session">Close session</button>
          </div>
        </div>
      </div>
    `;

    document.body.classList.remove("it-blurred");

    const barEl = root.querySelector("#it-sticky-bar");
    applyPageOffset(barEl);

    root
      .querySelector("#it-close-session")
      .addEventListener("click", () => showCompletionPrompt());
    startTimer();
  }

  /** --- Completion check when ending a session --- */

  function showCompletionPrompt(options = {}) {
    if (!currentSession || completionPromptVisible) return;
    completionPromptVisible = true;
    stopTimer();

    const root = getRoot();
    const barEl = root.querySelector("#it-sticky-bar");
    if (barEl) barEl.style.display = "none";

    const checkInNote = options.automatic
      ? `<p class="it-modal-subtitle">${COMPLETION_CHECK_MINUTES} minutes have passed — time for a check-in.</p>`
      : "";

    const overlay = document.createElement("div");
    overlay.className = "it-overlay it-completion-overlay";
    overlay.id = "it-completion-overlay";
    overlay.innerHTML = `
      <div class="it-modal" role="dialog" aria-labelledby="it-completion-title" aria-modal="true">
        <div class="it-modal-icon">✓</div>
        <h2 class="it-modal-title" id="it-completion-title">Did you complete your intention?</h2>
        ${checkInNote}
        <p class="it-modal-reason">"${escapeHtml(currentSession.reason)}"</p>
        <div class="it-modal-actions it-modal-actions-row">
          <button class="it-btn it-btn-success" id="it-done-btn">Done</button>
          <button class="it-btn it-btn-secondary" id="it-not-done-btn">Not done</button>
        </div>
      </div>
    `;

    root.appendChild(overlay);
    document.body.classList.add("it-blurred");

    overlay
      .querySelector("#it-done-btn")
      .addEventListener("click", () => finishSession(true));
    overlay
      .querySelector("#it-not-done-btn")
      .addEventListener("click", dismissCompletionPrompt);
  }

  async function dismissCompletionPrompt() {
    completionPromptVisible = false;
    document.body.classList.remove("it-blurred");

    const overlay = document.getElementById("it-completion-overlay");
    if (overlay) overlay.remove();

    const barEl = document.querySelector("#it-sticky-bar");
    if (barEl) barEl.style.display = "";

    await sendMessage({ type: "COMPLETION_DISMISSED" });
    startTimer();
  }

  async function finishSession(completed) {
    const duration = getElapsedSeconds();
    await sendMessage({ type: "UPDATE_DURATION", duration });
    await sendMessage({
      type: "CLOSE_SESSION",
      completed,
      closeTab: completed,
    });

    completionPromptVisible = false;
    currentSession = null;
    promptVisible = false;
    document.body.classList.remove("it-blurred");
    removePageOffset();
    clearRoot();
  }

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(() => {
      const timerEl = document.getElementById("it-timer");
      if (timerEl && currentSession) {
        const elapsed = getElapsedSeconds();
        timerEl.textContent = formatDuration(elapsed);

        /* Persist duration every 30 seconds */
        if (elapsed > 0 && elapsed % 30 === 0) {
          sendMessage({ type: "UPDATE_DURATION", duration: elapsed });
        }
      }
    }, 1000);
  }

  /** --- Init: check existing session on page load --- */

  async function init() {
    try {
      const state = await sendMessage({ type: "GET_TAB_STATE" });
      if (state?.hasSession && state.session) {
        currentSession = state.session;
        showStickyBar();
      }
    } catch {
      /* Extension context may be unavailable */
    }
  }

  /** --- Message listener from background --- */

  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case "SHOW_PROMPT":
        if (!currentSession) {
          showPrompt({
            url: message.url,
            hostname: message.hostname,
            title: message.title,
          });
        }
        break;

      case "RESTORE_SESSION":
        currentSession = message.session;
        promptVisible = false;
        document.body.classList.remove("it-blurred");
        showStickyBar();
        break;

      case "SHOW_COMPLETION_CHECK":
        if (currentSession) {
          showCompletionPrompt({ automatic: message.automatic });
        }
        break;

      case "SESSION_CLOSED":
        currentSession = null;
        promptVisible = false;
        completionPromptVisible = false;
        document.body.classList.remove("it-blurred");
        removePageOffset();
        clearRoot();
        break;

      default:
        break;
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
