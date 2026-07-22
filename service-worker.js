const CACHE='potlach-public-v2';
const FALLBACK='./index.html';
const ASSETS=['./','./index.html','./manifest.webmanifest'];

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
          const copy=response.clone();
          caches.open(CACHE).then((cache)=>cache.put(FALLBACK,copy));
          return response;
        })
        .catch(()=>caches.match(FALLBACK))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached)=>{
      const network=fetch(event.request).then((response)=>{
        if(response.ok && event.request.url.startsWith(self.location.origin)){
          const copy=response.clone();
          caches.open(CACHE).then((cache)=>cache.put(event.request,copy));
        }
        return response;
      });
      return cached || network;
    })
  );
});
