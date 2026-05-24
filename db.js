/**
 * IntentTab — IndexedDB layer
 * Stores browsing sessions locally in the extension origin.
 */

const DB_NAME = 'IntentTabDB';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

let dbPromise = null;

/**
 * Open (or reuse) the IndexedDB connection.
 */
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('hostname', 'hostname', { unique: false });
        store.createIndex('tabId', 'tabId', { unique: false });
        store.createIndex('closedAt', 'closedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

/**
 * Add a new session record.
 */
export async function createSession(session) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = {
      tabId: session.tabId,
      url: session.url,
      hostname: session.hostname,
      title: session.title || session.hostname,
      reason: session.reason,
      openedAt: session.openedAt,
      closedAt: null,
      duration: 0,
      completed: null,
      date: new Date(session.openedAt).toISOString().slice(0, 10),
    };
    const req = store.add(record);
    req.onsuccess = () => resolve({ ...record, id: req.result });
    req.onerror = () => reject(req.error);
  });
}

/**
 * Update an existing session (duration, close time, etc.).
 */
export async function updateSession(id, updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        reject(new Error(`Session ${id} not found`));
        return;
      }
      const updated = { ...existing, ...updates };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Fetch all sessions, newest first.
 */
export async function getAllSessions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const sessions = req.result.sort((a, b) => b.openedAt - a.openedAt);
      resolve(sessions);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Aggregate analytics from stored sessions.
 */
export async function getAnalytics() {
  const sessions = await getAllSessions();
  const closed = sessions.filter((s) => s.closedAt !== null);

  const totalTabs = sessions.length;
  const totalDistractionTime = closed.reduce((sum, s) => sum + (s.duration || 0), 0);

  const hostnameCounts = {};
  sessions.forEach((s) => {
    hostnameCounts[s.hostname] = (hostnameCounts[s.hostname] || 0) + 1;
  });

  const mostVisited = Object.entries(hostnameCounts)
    .map(([hostname, count]) => ({ hostname, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentReasons = sessions.slice(0, 15).map((s) => ({
    reason: s.reason,
    hostname: s.hostname,
    date: s.date,
    duration: s.duration,
    openedAt: s.openedAt,
  }));

  return {
    totalTabs,
    totalDistractionTime,
    mostVisited,
    recentReasons,
    sessions,
  };
}
