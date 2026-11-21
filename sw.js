/* Offline shell: keeps the start page, storage code and icons on the phone. GitHub API calls are never cached here. */
var C="shell-v1",FILES=["./","index.html","ghdb.js","manifest.webmanifest","icon-192.png","icon-512.png","qr.js"];
self.addEventListener("install",function(e){e.waitUntil(caches.open(C).then(function(c){return c.addAll(FILES)}).then(function(){return self.skipWaiting()}))});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(n){return n!==C&&n!=="ss-app"}).map(function(n){return caches.delete(n)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener("fetch",function(e){
  var u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(function(r){if(r.ok){var cp=r.clone();caches.open(C).then(function(c){c.put(e.request,cp)})}return r}).catch(function(){return caches.match(e.request,{ignoreSearch:true}).then(function(r){return r||caches.match("index.html")})}));
});
