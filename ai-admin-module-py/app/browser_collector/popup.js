// Firefox exposes the Chromium-compatible callback namespace as `chrome` too.
// Prefer it so the same message adapter works in every packaged browser.
const api = globalThis.chrome || globalThis.browser;
const pairing = document.querySelector('#pairing');
const limit = document.querySelector('#limit');
const status = document.querySelector('#status');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const download = document.querySelector('#download');

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(message, response => {
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(response || {});
    });
  });
}
function setStatus(value) {
  status.textContent = value?.message || (value?.active ? `Crawling: ${value.pages || 0} page(s)` : 'Not connected.');
  pairing.value = value?.pairing || pairing.value;
}
function saveLog(value) {
  const rows=value?.logs||[];
  if(!rows.length){setStatus({message:'No collector log is available yet.'});return;}
  const body=JSON.stringify({format:'automation-studio-collector-log/1',crawl_id:value.id||null,exported_at:new Date().toISOString(),entries:rows},null,2);
  const url=URL.createObjectURL(new Blob([body],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`automation-studio-collector-${value.id||'latest'}.json`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function refresh() { try { setStatus(await runtimeMessage({type:'status'})); } catch (e) { setStatus({message:e.message}); } }
start.onclick = async () => {
  start.disabled = true;
  try { setStatus(await runtimeMessage({type:'start', pairing:pairing.value.trim(), maxPages:Number(limit.value)||20})); }
  catch (e) { setStatus({message:e.message}); }
  finally { start.disabled = false; }
};
stop.onclick = async () => {
  stop.disabled = true;
  try { setStatus(await runtimeMessage({type:'finish'})); }
  catch (e) { setStatus({message:e.message}); }
  finally { stop.disabled = false; }
};
download.onclick = async () => {
  download.disabled=true;
  try {saveLog(await runtimeMessage({type:'logs'}));}
  catch(e){setStatus({message:e.message});}
  finally{download.disabled=false;}
};
refresh();
