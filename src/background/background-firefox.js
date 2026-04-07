// Firefox MV2: persistent background page, browser namespace
BackgroundController.init(browser, {
  badgeApi: 'browserAction',
  useSessionStorage: false,
});
