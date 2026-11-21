/* Shared storage for the hosted app: one JSON file (data.json) in a private GitHub repo.
   Gives the app the same small db interface it uses inside Claude (window.claude.use("db")),
   so the app code does not change. Config (repo + key) lives only on this phone: localStorage "gh-cfg". */
(function(){
  var cfg;try{cfg=JSON.parse(localStorage.getItem("gh-cfg")||"null")}catch(e){cfg=null}
  if(!cfg||!cfg.repo||!cfg.token)return;
  var API="https://api.github.com/repos/"+cfg.repo+"/contents/data.json";
  var POLL=20000;
  var data=null,sha=null,etag=null,loaded=false,queue=[],busy=false,timer=null,dead=null;
  var collL=[],docL=[];

  function hdr(extra){var h={"Authorization":"Bearer "+cfg.token,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};for(var k in extra)h[k]=extra[k];return h}
  function b64dec(s){var bin=atob(String(s||"").replace(/\s/g,""));var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new TextDecoder().decode(u)}
  function b64enc(str){var u=new TextEncoder().encode(str),s="";for(var i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)}
  function err(code,msg){return {code:code,message:msg}}
  function authFail(st){return st===401||st===403||st===404}
  function sortObj(o){if(Array.isArray(o))return o.map(sortObj);if(o&&typeof o==="object"){var r={};Object.keys(o).sort().forEach(function(k){r[k]=sortObj(o[k])});return r}return o}

  // GET data.json; resolves true when the content changed
  function fetchData(){
    var h={};if(etag&&loaded)h["If-None-Match"]=etag;
    return fetch(API+"?t="+Date.now(),{headers:hdr(h),cache:"no-store"}).then(function(r){
      if(r.status===304)return false;
      if(r.status===404&&!dead){ // repo reachable but no data file yet? check the repo itself
        return fetch("https://api.github.com/repos/"+cfg.repo,{headers:hdr(),cache:"no-store"}).then(function(r2){
          if(!r2.ok){dead=r2.status;throw err("revoked","no access")}
          var ch=!loaded;data=data||{};sha=null;loaded=true;return ch;
        });
      }
      if(authFail(r.status)){dead=r.status;throw err("revoked","no access")}
      if(!r.ok)throw err("unavailable","http "+r.status);
      etag=r.headers.get("ETag");
      return r.json().then(function(j){
        var txt=b64dec(j.content),nd;try{nd=JSON.parse(txt||"{}")}catch(e){nd={}}
        var ch=!loaded||JSON.stringify(nd)!==JSON.stringify(data);
        data=nd;sha=j.sha;loaded=true;return ch;
      });
    });
  }
  function put(){
    var body={message:"sync",content:b64enc(JSON.stringify(sortObj(data),null,1)+"\n")};if(sha)body.sha=sha;
    return fetch(API,{method:"PUT",headers:hdr({"Content-Type":"application/json"}),body:JSON.stringify(body)}).then(function(r){
      if(r.status===409||r.status===422)return "conflict";
      if(r.status===401||r.status===403){dead=r.status;throw err("revoked","no access")}
      if(!r.ok)throw err("unavailable","http "+r.status);
      return r.json().then(function(j){sha=j.content&&j.content.sha;etag=null;return "ok"});
    });
  }
  function apply(op){
    var p=op.path.split("/"),c=p[0],id=p[1];
    if(op.kind==="set"){data[c]=data[c]||{};data[c][id]=JSON.parse(JSON.stringify(op.data))}
    else if(data[c]){delete data[c][id];if(!Object.keys(data[c]).length)delete data[c]}
  }
  // send all queued writes as one commit; on a clash, re-read and apply again
  function flush(){
    if(busy||!queue.length)return;
    busy=true;var batch=queue.splice(0,queue.length),tries=0;
    (function attempt(){
      (loaded&&tries===0?Promise.resolve():fetchData()).then(function(){
        batch.forEach(apply);return put();
      }).then(function(res){
        if(res==="conflict"&&tries<4){tries++;etag=null;setTimeout(attempt,400*tries);return}
        if(res==="conflict")throw err("unavailable","conflict");
        busy=false;batch.forEach(function(o){o.ok()});emit();if(queue.length)flush();
      }).catch(function(e){
        if(e&&e.code==="revoked"){busy=false;batch.forEach(function(o){o.no(e)});queue.splice(0).forEach(function(o){o.no(e)});return}
        // offline or GitHub hiccup: keep trying in the background
        tries=0;loaded=false;etag=null;setTimeout(attempt,Math.min(60000,5000+Math.random()*5000));
      });
    })();
  }
  function write(kind,path,d){
    return new Promise(function(ok,no){
      if(dead)return no(err("revoked","no access"));
      queue.push({kind:kind,path:path,data:d,ok:ok,no:no});
      clearTimeout(timer);timer=setTimeout(flush,250);
    });
  }
  function frz(o){return JSON.parse(JSON.stringify(o))}
  function docSnap(path){var p=path.split("/"),c=data&&data[p[0]],v=c&&c[p[1]];return {id:p[1],exists:!!v,data:function(){return v?frz(v):undefined},metadata:{fromCache:false,hasPendingWrites:false}}}
  function collSnap(c){var o=(data&&data[c])||{};var docs=Object.keys(o).sort().map(function(id){return docSnap(c+"/"+id)});return {docs:docs,size:docs.length,empty:!docs.length,metadata:{fromCache:false,hasPendingWrites:false},docChanges:function(){return[]}}}
  function emit(){if(!loaded)return;collL.forEach(function(l){try{l.next(collSnap(l.c))}catch(e){}});docL.forEach(function(l){try{l.next(docSnap(l.p))}catch(e){}})}
  function fail(e){collL.concat(docL).forEach(function(l){if(l.err)try{l.err(e)}catch(x){}})}
  function poll(){
    if(busy||queue.length||document.hidden)return;
    fetchData().then(function(ch){if(ch)emit()}).catch(function(e){fail(e);if(e&&e.code==="revoked"&&window.ghRevoked)window.ghRevoked()});
  }
  var started=false;
  function start(){if(started)return;started=true;setTimeout(poll,0);setInterval(poll,POLL);
    document.addEventListener("visibilitychange",function(){if(!document.hidden)poll()});
    window.addEventListener("online",function(){poll();flush()})}
  function docRef(path){return {id:path.split("/").pop(),path:path,
    set:function(d){return write("set",path,d)},
    delete:function(){return write("del",path)},
    get:function(){return (loaded?Promise.resolve():fetchData()).then(function(){return docSnap(path)})},
    onSnapshot:function(next,er){var l={p:path,next:next,err:er};docL.push(l);start();if(loaded)setTimeout(function(){next(docSnap(path))},0);return function(){docL=docL.filter(function(x){return x!==l})}}}}
  var db={
    collection:function(c){return {path:c,doc:function(id){return docRef(c+"/"+id)},
      onSnapshot:function(next,er){var l={c:c,next:next,err:er};collL.push(l);start();if(loaded)setTimeout(function(){next(collSnap(c))},0);return function(){collL=collL.filter(function(x){return x!==l})}}}},
    doc:function(p){return docRef(p)}
  };
  window.claude={use:function(name){
    if(name==="db")return Promise.resolve(db);
    if(name==="user")return Promise.resolve({can:function(){return Promise.resolve(true)}});
    return Promise.reject(err("not_granted","not available"));
  }};
})();
