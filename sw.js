// Service worker de Torneo FIFA: necesario para instalar la app en el celular.
// · La página y el resto de la app: siempre primero de internet (así cada
//   publicación se ve al instante); solo sin conexión usa la última copia.
// · Lo que nunca cambia (librería con versión fija, catálogo de jugadores con
//   número de versión, tipografías): se guarda en el celular y se lee de ahí.
// No toca las llamadas a Supabase (los datos del torneo siempre se piden en vivo).
const CACHE = "torneofifa-v5";
const STATIC = "torneofifa-static-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Archivos que nunca cambian para una misma dirección: la librería con versión
// fija, el catálogo pedido con ?v= y las tipografías.
function isStatic(url) {
  if (FONT_HOSTS.includes(url.hostname)) return true;
  if (url.origin !== self.location.origin) return false;
  return url.pathname.includes("/vendor/") || (url.pathname.endsWith("/market.json") && url.searchParams.has("v"));
}
async function fromStatic(req, url) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    // De market.json solo se guarda la versión actual.
    if (url.pathname.endsWith("/market.json")) {
      for (const k of await cache.keys()) if (new URL(k.url).pathname.endsWith("/market.json")) await cache.delete(k);
    }
    await cache.put(req, res.clone());
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (isStatic(url)) { e.respondWith(fromStatic(req, url)); return; }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined)))
  );
});

// Notificaciones push: las manda la función "notify" de Supabase.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Torneo FIFA", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Torneo FIFA", {
    body: d.body || "",
    // Sin "icon" grande a la derecha: deja más espacio al texto. El badge es
    // la silueta blanca del balón que Android muestra en la barra de estado.
    badge: "icons/badge-96.png",
    image: d.image || undefined,
    tag: d.tag || undefined,
    data: { url: d.url || "./" }
  }));
});

// Al tocar la notificación: abre la app (o la enfoca) en la sección del aviso.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope) && "focus" in w) { await w.navigate(url).catch(() => {}); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

// Si el navegador renueva el registro de notificaciones por su cuenta (pasa
// cada cierto tiempo, sobre todo si el celular lleva mucho sin usar la app),
// se pide uno nuevo y se avisa al servidor, sin que la persona abra la app.
const IS_PROD = ["torneofifa.com", "www.torneofifa.com"].includes(self.location.hostname);
const SB_URL = IS_PROD ? "https://zohacxiwuapnziicaarj.supabase.co" : "https://bcvzgwnwjtcmtbhwruhi.supabase.co";
const VAPID = IS_PROD
  ? "BJuDm4Fub96yd9DA7ScIlhyr3DtuPPGcps5nuH0F3TjtXrvWrkWDrgky5W_NSeG71n_PYKd-T0TO91Q2b_w8Rck"
  : "BIPAuwSogSlMMzavPGUQQVCpT9HeGQgN1mxzuYjIw5JQun4phuycjoz6cRlKdvnoWhcnEsbgKQgIf1uZtC7qdbs";
function vapidBytes(b64) {
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription;
    if (!old || !old.endpoint) return; // sin el registro anterior, se repara al abrir la app
    const sub = e.newSubscription ||
      await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(VAPID) });
    await fetch(SB_URL + "/functions/v1/push-renew", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldEndpoint: old.endpoint, sub: sub.toJSON() })
    }).catch(() => {});
  })());
});
