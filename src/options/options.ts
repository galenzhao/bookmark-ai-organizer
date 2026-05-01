// SPDX-License-Identifier: Apache-2.0

async function loadPopupDocument(): Promise<Document> {
  const url = chrome.runtime.getURL('popup/popup.html');
  const resp = await fetch(url);
  const html = await resp.text();
  return new DOMParser().parseFromString(html, 'text/html');
}

function stripScripts(root: HTMLElement): void {
  root.querySelectorAll('script').forEach((el) => el.remove());
}

async function mountUi(): Promise<void> {
  const root = document.getElementById('options-root');
  if (!root) return;

  const doc = await loadPopupDocument();
  const toast = doc.getElementById('toast-container');
  const app = doc.getElementById('app');
  const classificationModal = doc.getElementById('classification-modal');
  const bulkDetailsModal = doc.getElementById('bulk-details-modal');
  if (!toast || !app) {
    throw new Error('Failed to load UI markup.');
  }

  // Ensure we don't accidentally execute popup.html scripts.
  stripScripts(toast);
  stripScripts(app);
  if (classificationModal) stripScripts(classificationModal);
  if (bulkDetailsModal) stripScripts(bulkDetailsModal);

  root.innerHTML = [
    toast.outerHTML,
    app.outerHTML,
    classificationModal?.outerHTML ?? '',
    bulkDetailsModal?.outerHTML ?? '',
  ].join('\n');
}

async function bootstrap(): Promise<void> {
  await mountUi();
  // Importing popup module initializes the controller (it calls new PopupController()).
  await import('../popup/popup');
}

void bootstrap();

