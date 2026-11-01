import { createSearchEngine } from './search-core.js';

let catalogPromise;
async function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const response = await fetch(new URL('./data/songs.json', import.meta.url));
      if (!response.ok) throw new Error('The song catalog could not be loaded. Please retry.');
      return createSearchEngine(await response.json());
    })().catch((error) => {
      catalogPromise = undefined;
      throw error;
    });
  }
  return catalogPromise;
}

self.onmessage = async ({ data }) => {
  if (!data || !['init', 'search'].includes(data.type)) return;
  try {
    const engine = await loadCatalog();
    if (data.type === 'init') {
      self.postMessage({ type: 'ready', total: engine.total, requestId: 0, ...engine.search() });
    } else {
      self.postMessage({ type: 'results', requestId: data.requestId, ...engine.search(data) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId: data.requestId ?? 0,
      message: error instanceof Error ? error.message : 'The song catalog could not be loaded.' });
  }
};
