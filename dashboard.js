/**
 * IntentTab — Analytics dashboard
 */

import { getAnalytics } from './db.js';

/**
 * Format seconds into a human-readable duration string.
 */
function formatDuration(seconds) {
  if (!seconds || seconds < 1) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

/**
 * Format a timestamp as a short date/time string.
 */
function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Render summary stat cards.
 */
function renderStats(analytics) {
  const closed = analytics.sessions.filter((s) => s.closedAt);
  const avgDuration = closed.length
    ? Math.floor(closed.reduce((sum, s) => sum + s.duration, 0) / closed.length)
    : 0;

  document.getElementById('total-tabs').textContent = analytics.totalTabs;
  document.getElementById('total-time').textContent = formatDuration(analytics.totalDistractionTime);
  document.getElementById('avg-duration').textContent = formatDuration(avgDuration);
}

/**
 * Render most visited websites as horizontal bar chart.
 */
function renderMostVisited(mostVisited) {
  const container = document.getElementById('most-visited');

  if (!mostVisited.length) {
    container.innerHTML = '<p class="empty-state">No data yet</p>';
    return;
  }

  const maxCount = mostVisited[0].count;
  container.innerHTML = mostVisited
    .map(
      (item) => `
      <div class="visit-bar-row">
        <span class="visit-bar-label" title="${escapeHtml(item.hostname)}">${escapeHtml(item.hostname)}</span>
        <div class="visit-bar-track">
          <div class="visit-bar-fill" style="width: ${(item.count / maxCount) * 100}%"></div>
        </div>
        <span class="visit-bar-count">${item.count}</span>
      </div>
    `
    )
    .join('');
}

/**
 * Render recent intention reasons.
 */
function renderRecentReasons(recentReasons) {
  const container = document.getElementById('recent-reasons');

  if (!recentReasons.length) {
    container.innerHTML = '<p class="empty-state">No reasons recorded yet</p>';
    return;
  }

  container.innerHTML = recentReasons
    .map(
      (item) => `
      <div class="reason-item">
        <p class="reason-text">"${escapeHtml(item.reason)}"</p>
        <div class="reason-meta">
          <span>${escapeHtml(item.hostname)}</span>
          <span>·</span>
          <span>${formatDate(item.openedAt)}</span>
          ${item.duration ? `<span>·</span><span>${formatDuration(item.duration)}</span>` : ''}
        </div>
      </div>
    `
    )
    .join('');
}

/**
 * Render full session history table.
 */
function renderHistory(sessions) {
  const container = document.getElementById('session-history');

  if (!sessions.length) {
    container.innerHTML = '<p class="empty-state">No sessions yet</p>';
    return;
  }

  const rows = sessions.slice(0, 50).map(
    (s) => `
    <div class="history-row">
      <span class="history-site" title="${escapeHtml(s.hostname)}">${escapeHtml(s.hostname)}</span>
      <span class="history-reason" title="${escapeHtml(s.reason)}">${escapeHtml(s.reason)}</span>
      <span class="history-duration">${s.duration ? formatDuration(s.duration) : '—'}</span>
      <span class="history-date">${formatDate(s.openedAt)}</span>
    </div>
  `
  );

  container.innerHTML = `
    <div class="history-row header">
      <span>Site</span>
      <span>Reason</span>
      <span>Duration</span>
      <span>Opened</span>
    </div>
    ${rows.join('')}
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function init() {
  try {
    const analytics = await getAnalytics();
    renderStats(analytics);
    renderMostVisited(analytics.mostVisited);
    renderRecentReasons(analytics.recentReasons);
    renderHistory(analytics.sessions);
  } catch (err) {
    console.error('Failed to load analytics:', err);
  }
}

init();
