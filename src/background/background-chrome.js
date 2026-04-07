// Chrome MV3: service worker, chrome namespace
// Rehydrate tabData from session storage on service worker restart
chrome.storage.session?.get(null, (items) => {
  if (items) {
    for (const [key, value] of Object.entries(items)) {
      if (key.startsWith('tab_')) {
        const tabId = parseInt(key.replace('tab_', ''), 10);
        tabData[tabId] = value;
      }
    }
  }
});

BackgroundController.init(chrome, {
  badgeApi: 'action',
  useSessionStorage: true,
});
