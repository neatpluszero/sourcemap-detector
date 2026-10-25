// Chrome MV3: service worker, chrome namespace.
// tabData is rehydrated from session storage on service worker restart.
BackgroundController.init(chrome, {
  badgeApi: 'action',
  useSessionStorage: true,
});
