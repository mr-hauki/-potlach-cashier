const CACHE='potlach-public-v6';
const FALLBACK='./v3.html?v=6';
const ASSETS=['./v3.html?v=6','./index.html?base=v6','./global-config.js?v=6','./manifest.webmanifest?v=6'];

self.addEventListener('install',(event)=>{
  event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate',(event)=>{
  event.waitUntil(
    caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch',(event)=>{
  if(event.request.method!=='GET') return;
  if(event.request.mode==='navigate'){
    event.respondWith(
      fetch(event.request)
        .then((response)=>{
          if(response.ok){
            const copy=response.clone();
            caches.open(CACHE).then((cache)=>cache.put(event.request,copy));
          }
          return response;
        })
        .catch(()=>caches.match(event.request).then((cached)=>cached||caches.match(FALLBACK)))
    );
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response)=>{
        if(response.ok && event.request.url.startsWith(self.location.origin)){
          const copy=response.clone();
          caches.open(CACHE).then((cache)=>cache.put(event.request,copy));
        }
        return response;
      })
      .catch(()=>caches.match(event.request))
  );
});