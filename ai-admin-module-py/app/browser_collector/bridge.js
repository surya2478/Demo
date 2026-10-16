/* Exact-origin bridge installed after the user pairs the extension once.
   It exposes only the ability to start a server-created, short-lived crawl. */
(() => {
  if (globalThis.__automationStudioCollectorBridge) return;
  globalThis.__automationStudioCollectorBridge = true;
  const api = globalThis.chrome || globalThis.browser;
  const CHANNEL = 'automation-studio-browser-collector';

  window.addEventListener('message', event => {
    const value = event.data;
    if (event.source !== window || event.origin !== location.origin || value?.channel !== CHANNEL || !['probe','start','resume','stop'].includes(value?.type)) return;
    if(value.type==='probe'){
      window.postMessage({channel:CHANNEL,type:'probe-result',nonce:value.nonce,version:api.runtime.getManifest().version},location.origin);
      return;
    }
    const request=value.type==='start'
      ? {type:'bridge-start',pairing:value.pairing,maxPages:value.maxPages}
      : value.type==='resume'
        ? {type:'bridge-resume',crawlId:value.crawlId}
        : {type:'bridge-stop',crawlId:value.crawlId};
    api.runtime.sendMessage(request, response => {
      const error = api.runtime.lastError;
      window.postMessage({
        channel:CHANNEL,
        type:`${value.type}-result`,
        nonce:value.nonce,
        active:!error && response?.active === true,
        version:api.runtime.getManifest().version,
        message:error?.message || response?.message || null
      }, location.origin);
    });
  });
})();
