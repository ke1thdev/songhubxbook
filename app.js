const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en');
const STORAGE_KEY = 'songhub:favorites:v1';
const state = { query:'', view:'all', offset:0, limit:60, count:0, total:0, ready:false, requestId:0, favorites:new Set(), rows:[], offlineReady:false };
let searchWorker;
let toastTimer;
let searchTimer;
let installPrompt;
let registration;
let waitingWorker;
let offlineFailure = false;
let storageWorks = true;
let loadFeedbackTimer;

const systemTheme=matchMedia('(prefers-color-scheme: dark)');
let explicitTheme;
try { explicitTheme=localStorage.getItem('songhub:theme'); } catch {}
function applyTheme(theme) {
  const dark=theme==='dark';
  document.documentElement.dataset.theme=dark?'dark':'light';
  $('theme-toggle').textContent=dark?'Light':'Dark';
  $('theme-toggle').setAttribute('aria-label',`Switch to ${dark?'light':'dark'} mode`);
  $('theme-toggle').setAttribute('aria-pressed',String(dark));
  document.querySelector('meta[name="theme-color"]').content=dark?'#111111':'#ffffff';
}
applyTheme(document.documentElement.dataset.theme);
$('theme-toggle').addEventListener('click',()=>{
  explicitTheme=document.documentElement.dataset.theme==='dark'?'light':'dark';
  applyTheme(explicitTheme);
  try { localStorage.setItem('songhub:theme',explicitTheme); } catch {}
});
systemTheme.addEventListener('change',({matches})=>{if(!['dark','light'].includes(explicitTheme))applyTheme(matches?'dark':'light');});

function hideLoading() {
  clearTimeout(loadFeedbackTimer);
  $('skeleton-list').hidden=true;
}

function readFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(stored) ? stored.filter((code) => /^\d{6}$/.test(code)) : []);
  } catch { storageWorks = false; return new Set(); }
}
state.favorites = readFavorites();

function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}

function updateFavoriteCount() {
  $('favorites-count').textContent = number.format(state.favorites.size);
}

function saveFavorites(next) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); storageWorks = true; }
  catch { storageWorks = false; }
  state.favorites = next;
  updateFavoriteCount();
  if (!storageWorks) showToast('Saved for this visit. Browser storage is unavailable.');
}

function icon(id) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('class','icon'); el.setAttribute('aria-hidden','true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href',`#i-${id}`); el.append(use);
  return el;
}

function highlighted(el, value) {
  // Rendering never interprets song titles or searches as HTML.
  const terms = state.query.trim().split(/\s+/).filter(Boolean).slice(0,12).sort((a,b) => b.length-a.length);
  if (!terms.length) { el.textContent = value; return; }
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  let start = 0;
  for (const match of value.matchAll(re)) {
    el.append(document.createTextNode(value.slice(start,match.index)));
    const mark = document.createElement('mark'); mark.textContent = match[0]; el.append(mark);
    start = match.index+match[0].length;
  }
  el.append(document.createTextNode(value.slice(start)));
}

function renderRows(rows) {
  const fragment = document.createDocumentFragment();
  for (const song of rows) {
    const row = document.createElement('li'); row.className = 'song-row'; row.dataset.code = song.code;
    const title = document.createElement('span'); title.className = 'song-title'; highlighted(title,song.title);
    const artist = document.createElement('span'); artist.className = 'song-artist'; highlighted(artist,song.artist || 'Artist not listed');
    const code = document.createElement('button'); code.className = 'song-code'; code.type = 'button'; code.dataset.action = 'copy'; code.dataset.code = song.code;
    code.setAttribute('aria-label',`Copy code ${song.code} for ${song.title}`); code.title = 'Copy song code';
    code.append(icon('copy'),document.createTextNode(song.code));
    const favorite = document.createElement('button'); favorite.className = 'favorite-button'; favorite.type = 'button'; favorite.dataset.action = 'favorite'; favorite.dataset.code = song.code; favorite.dataset.title = song.title;
    setFavoriteButton(favorite,state.favorites.has(song.code)); favorite.append(icon('star'));
    row.append(title,artist,code,favorite); fragment.append(row);
  }
  $('song-list').replaceChildren(fragment);
}

function setFavoriteButton(button, saved) {
  button.setAttribute('aria-pressed',String(saved));
  const label = `${saved?'Remove':'Add'} ${button.dataset.title} ${saved?'from':'to'} favorites`;
  button.setAttribute('aria-label',label); button.title = saved?'Remove from favorites':'Add to favorites';
}

function showListState(title, detail, action) {
  const box = $('list-state'); box.replaceChildren();
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = detail;
  box.append(h,p);
  if (action) {
    const button = document.createElement('button'); button.type='button'; button.className='secondary-button'; button.textContent=action.label; button.addEventListener('click',action.run); box.append(button);
  }
  box.hidden=false;
}

function updateResults(data) {
  hideLoading();
  if(!data.rows.length && data.count>0 && data.offset>0){state.offset=Math.floor((data.count-1)/state.limit)*state.limit;requestSearch({reset:false});return;}
  state.count=data.count; state.rows=data.rows; state.offset=data.offset||0;
  renderRows(data.rows);
  $('catalog').setAttribute('aria-busy','false');
  const unit = state.view==='favorites'?'favorite':'song';
  $('result-summary').textContent = `${number.format(data.count)} ${state.query.trim()?'match'+(data.count===1?'':'es'):unit+(data.count===1?'':'s')}`;
  $('list-state').hidden = data.rows.length>0;
  if (!data.rows.length) {
    if (state.view==='favorites' && !state.favorites.size) {
      showListState('Your favorites, all together','Tap the star beside a song to save it here.',{label:'Browse all songs',run:()=>switchView('all')});
    } else {
      showListState('No songs found',state.view==='favorites'?'Try another search, or look in all songs.':'Try fewer words, an artist name, or a song code.',{label:state.query?'Clear search':'Browse all songs',run:()=>{if(state.query)clearSearch();else switchView('all');}});
    }
  }
  $('pagination').hidden=!data.rows.length;
  const first = data.rows.length ? state.offset+1 : 0;
  const last = state.offset+data.rows.length;
  $('shown-count').textContent=`${number.format(first)}–${number.format(last)} of ${number.format(data.count)}`;
  $('previous-page').disabled=state.offset===0;
  $('next-page').disabled=last>=data.count;
  $('previous-page').parentElement.hidden=data.count<=state.limit;
}

function requestSearch({reset=true,scroll=false}={}) {
  if (!state.ready) return;
  if (reset) state.offset=0;
  state.requestId++;
  $('catalog').setAttribute('aria-busy','true');
  searchWorker.postMessage({type:'search',requestId:state.requestId,query:state.query,view:state.view,favorites:[...state.favorites],offset:state.offset,limit:state.limit});
  if (scroll) $('catalog').scrollIntoView({behavior:'instant',block:'start'});
}

function startSearch() {
  searchWorker?.terminate(); state.ready=false;
  $('song-list').replaceChildren();
  $('skeleton-list').hidden=false;
  $('list-state').hidden=true;
  $('pagination').hidden=true;
  clearTimeout(loadFeedbackTimer);
  loadFeedbackTimer=setTimeout(()=>{$('result-summary').textContent='Still opening…';},10000);
  $('catalog').setAttribute('aria-busy','true');
  $('result-summary').textContent='Loading songbook…';
  try {
    searchWorker = new Worker(new URL('./search-worker.js',import.meta.url),{type:'module'});
    searchWorker.addEventListener('message',({data})=>{
      if (data.type==='error') { loadError(data.message); return; }
      if (data.type==='ready') {
        state.ready=true; state.total=data.total;
        updateFavoriteCount();
        if (state.query || state.view!=='all') requestSearch();
        else updateResults({...data,offset:0});
      }
      if (data.type==='results' && data.requestId===state.requestId) updateResults(data);
    });
    searchWorker.addEventListener('error',()=>loadError('The song catalog could not be opened.'));
    searchWorker.postMessage({type:'init'});
  } catch { loadError('Your browser could not start song search.'); }
}

function loadError() {
  hideLoading();
  state.ready=false;
  $('catalog').setAttribute('aria-busy','false');
  $('result-summary').textContent='Catalog unavailable'; $('pagination').hidden=true;
  showListState('Couldn’t open the songbook','Check your connection and try again. You can also use the PDF.',{label:'Try again',run:startSearch});
}

function syncSearchURL() {
  const url = new URL(location.href);
  const params=new URLSearchParams();
  if (state.query) params.set('q',state.query);
  if (state.view==='favorites') params.set('view','favorites');
  url.hash=params.toString();
  history.replaceState(null,'',url);
}

function switchView(view) {
  state.view=view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const selected=button.dataset.view===view; button.classList.toggle('active',selected); button.setAttribute('aria-pressed',String(selected));
  }
  requestSearch(); syncSearchURL();
}

function clearSearch() {
  clearTimeout(searchTimer); state.query=''; $('search').value=''; $('clear-search').hidden=true;
  requestSearch(); syncSearchURL(); $('search').focus();
}

async function copyCode(code) {
  try { await navigator.clipboard.writeText(code); showToast(`Copied ${code}`); }
  catch {
    const input=document.createElement('textarea'); input.value=code; input.style.cssText='position:fixed;left:-9999px;top:0'; input.setAttribute('readonly',''); document.body.append(input); input.select();
    let copied=false; try { copied=document.execCommand('copy'); } catch {} input.remove();
    showToast(copied?`Copied ${code}`:`Song code: ${code}`);
  }
}

let pdfBusy=false;
for(const link of document.querySelectorAll('a[download="SongHub-Songbook.pdf"]'))link.addEventListener('click',async(event)=>{
  // Fetch through the controlled page, then download a local blob. This also
  // works in browsers whose download manager bypasses service-worker requests.
  event.preventDefault();if(pdfBusy)return;pdfBusy=true;
  showToast('Preparing your PDF…');
  try{
    const response=await fetch(link.href);
    if(!response.ok)throw new Error('PDF unavailable');
    const blob=await response.blob();
    if(!(await blob.slice(0,5).text()).startsWith('%PDF-'))throw new Error('Invalid PDF');
    const url=URL.createObjectURL(blob);const download=document.createElement('a');
    download.href=url;download.download='SongHub-Songbook.pdf';download.hidden=true;document.body.append(download);download.click();download.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);showToast('Your PDF is ready to save');
  }catch{showToast('PDF unavailable. Connect to the internet and try again.');}
  finally{pdfBusy=false;}
});

$('song-list').addEventListener('click',(event)=>{
  const button=event.target.closest('button[data-action]'); if (!button) return;
  const code=button.dataset.code;
  if (button.dataset.action==='copy') { copyCode(code); return; }
  const next=new Set(state.favorites); const saved=!next.has(code);
  if(saved) next.add(code); else next.delete(code);
  saveFavorites(next); setFavoriteButton(button,saved);
  if(storageWorks) showToast(saved?'Added to favorites':'Removed from favorites');
  if(state.view==='favorites') requestSearch({reset:false});
});

$('search').addEventListener('input',()=>{
  state.requestId++;
  state.query=$('search').value.slice(0,200); $('clear-search').hidden=!state.query;
  clearTimeout(searchTimer);
  // One frame of coalescing; the worker keeps all search work off the UI thread.
  searchTimer=setTimeout(()=>{requestSearch(); syncSearchURL();},20);
});
$('search').addEventListener('keydown',(event)=>{if(event.key==='Escape'){event.preventDefault();clearSearch();}if(event.key==='Enter'){event.preventDefault();clearTimeout(searchTimer);requestSearch();syncSearchURL();}});
$('clear-search').addEventListener('click',clearSearch);
for(const button of document.querySelectorAll('[data-view]')) button.addEventListener('click',()=>switchView(button.dataset.view));
$('previous-page').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.limit);requestSearch({reset:false,scroll:true});});
$('next-page').addEventListener('click',()=>{state.offset+=state.limit;requestSearch({reset:false,scroll:true});});
document.addEventListener('keydown',(event)=>{if((event.key==='/' || ((event.ctrlKey||event.metaKey)&&event.key==='k')) && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('app-dialog').open){event.preventDefault();$('search').focus();}});
window.addEventListener('storage',(event)=>{
  if(event.key===STORAGE_KEY){state.favorites=readFavorites();updateFavoriteCount();if(state.view==='favorites')requestSearch();else renderRows(state.rows);}
  if(event.key==='songhub:theme'){explicitTheme=event.newValue;applyTheme(['dark','light'].includes(explicitTheme)?explicitTheme:systemTheme.matches?'dark':'light');}
});

function updateOfflineUI() {
  let label;
  let title;
  let detail;
  if(state.offlineReady) {
    label=navigator.onLine?'Ready offline':'Offline · ready';
    title='Your songbook is saved offline';
    detail='All 48,000 songs and the PDF are saved on this device. Search and favorites work without a connection.';
  } else if(offlineFailure) {
    label='Offline setup incomplete'; title='Offline access isn’t ready yet'; detail='Stay connected and try again to save the full catalog and PDF.';
  } else {
    label=navigator.onLine?'Preparing offline access':'Offline access not ready'; title='Preparing offline access'; detail='Saving the full catalog and PDF on this device. Keep this page open until it says Ready offline.';
  }
  $('offline-label').textContent=label; $('offline-button').setAttribute('aria-label',`Offline access: ${label}`);
  $('status-dot').className=`status-dot${state.offlineReady?' ready':offlineFailure?' error':''}`;
  $('dialog-offline-title').textContent=title; $('dialog-offline-detail').textContent=detail;
  $('retry-offline').hidden=!offlineFailure;
}

async function messageOfflineWorker(type='GET_OFFLINE_STATUS') {
  const worker=registration?.active;
  if(!worker) throw new Error('Offline worker is unavailable');
  return new Promise((resolve,reject)=>{
      const channel=new MessageChannel(); const timer=setTimeout(()=>{channel.port1.close();reject(new Error('Status timeout'));},type==='GET_OFFLINE_STATUS'?8000:45000);
      channel.port1.onmessage=({data})=>{clearTimeout(timer);channel.port1.close();resolve(data);};
      worker.postMessage({type},[channel.port2]);
    });
}

async function checkOffline() {
  if(!registration?.active) return;
  try {
    const status=await messageOfflineWorker();
    state.offlineReady=Boolean(status.ready); offlineFailure=!status.ready; updateOfflineUI();
  } catch { offlineFailure=true;updateOfflineUI(); }
}

function showUpdate(worker) { waitingWorker=worker; $('update-app').hidden=false; showToast('An update is ready. Open offline access to update.'); }

async function setupOffline() {
  if(!('serviceWorker' in navigator) || !window.isSecureContext) {
    offlineFailure=true;updateOfflineUI();$('dialog-offline-detail').textContent='Offline access needs HTTPS or localhost and a browser that supports service workers.';return;
  }
  try {
    registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    if(registration.waiting) showUpdate(registration.waiting);
    registration.addEventListener('updatefound',()=>{
      const installing=registration.installing;
      installing?.addEventListener('statechange',()=>{
        if(installing.state==='redundant'){offlineFailure=true;updateOfflineUI();}
        if(installing.state==='installed' && navigator.serviceWorker.controller) showUpdate(registration.waiting||installing);
      });
    });
    await navigator.serviceWorker.ready;
    await checkOffline();
  } catch { offlineFailure=true;updateOfflineUI(); }
}

function openDialog() {
  const standalone=window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('native-install').hidden=!installPrompt||standalone;
  $('install-instructions').hidden=Boolean(installPrompt)||standalone;
  if(/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    $('install-help').replaceChildren();
    const help=$('install-help'); help.append('In Safari, tap '); const share=document.createElement('strong');share.textContent='Share';help.append(share,', then ');const home=document.createElement('strong');home.textContent='Add to Home Screen';help.append(home,'.');
  }
  if(!$('app-dialog').open) $('app-dialog').showModal();
  if(registration?.active)checkOffline();
}

$('install-button').addEventListener('click',openDialog);
$('offline-button').addEventListener('click',openDialog);
$('close-dialog').addEventListener('click',()=>$('app-dialog').close());
$('app-dialog').addEventListener('click',(event)=>{if(event.target===$('app-dialog')){const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.target.close();}});
$('native-install').addEventListener('click',async()=>{
  if(!installPrompt)return;
  const prompt=installPrompt;installPrompt=null;$('native-install').hidden=true;
  try {await prompt.prompt();const choice=await prompt.userChoice;if(choice.outcome==='accepted'){$('app-dialog').close();showToast('SongHub is being installed');}else $('install-instructions').hidden=false;}catch{$('install-instructions').hidden=false;}
});
$('retry-offline').addEventListener('click',async()=>{
  offlineFailure=false;$('retry-offline').disabled=true;updateOfflineUI();
  try{
    if(registration?.active){const status=await messageOfflineWorker('RETRY_OFFLINE_PREPARATION');state.offlineReady=Boolean(status.ready);offlineFailure=!status.ready;updateOfflineUI();}
    else await setupOffline();
  }catch{offlineFailure=true;updateOfflineUI();}
  finally{$('retry-offline').disabled=false;}
});
$('update-app').addEventListener('click',()=>{if(waitingWorker){waitingWorker.postMessage({type:'SKIP_WAITING'});$('update-app').disabled=true;}});
window.addEventListener('beforeinstallprompt',(event)=>{event.preventDefault();installPrompt=event;if($('app-dialog').open){$('native-install').hidden=false;$('install-instructions').hidden=true;}});
window.addEventListener('appinstalled',()=>{installPrompt=null;$('install-button').hidden=true;$('app-dialog').close();});
window.addEventListener('online',()=>{updateOfflineUI();if(!state.offlineReady)setupOffline();});
window.addEventListener('offline',updateOfflineUI);
navigator.serviceWorker?.addEventListener('message',({data})=>{if(data?.type==='OFFLINE_READY')checkOffline();});
navigator.serviceWorker?.addEventListener('controllerchange',()=>{if(waitingWorker)location.reload();else checkOffline();});

const initialParams=new URLSearchParams(location.hash.slice(1));state.query=(initialParams.get('q')||'').slice(0,200);$('search').value=state.query;$('clear-search').hidden=!state.query;
if(initialParams.get('view')==='favorites')switchView('favorites');
if(window.matchMedia('(display-mode: standalone)').matches||navigator.standalone)$('install-button').hidden=true;
const searchArea=document.querySelector('.search-area');
new ResizeObserver(()=>document.documentElement.style.setProperty('--search-sticky-height',`${Math.ceil(searchArea.getBoundingClientRect().height)}px`)).observe(searchArea);
updateFavoriteCount();startSearch();setupOffline();
