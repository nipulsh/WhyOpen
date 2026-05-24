/**
 * IntentTab — Extension popup logic
 */

async function loadActiveCount() {
  const el = document.getElementById('active-count');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_COUNT' });
    el.textContent = response?.count ?? 0;
  } catch {
    el.textContent = '0';
  }
}

document.getElementById('open-dashboard').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

loadActiveCount();
