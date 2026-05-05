const CACHE_PREFIX = "musicgpt-";

export function shouldRegisterServiceWorker(mode = import.meta.env.MODE, hasSupport = "serviceWorker" in navigator): boolean {
  return mode === "production" && hasSupport;
}

export function registerServiceWorker(): void {
  window.addEventListener("load", async () => {
    if (!shouldRegisterServiceWorker()) {
      await cleanupDevelopmentServiceWorker();
      return;
    }

    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch {
      return;
    }
  });
}

async function cleanupDevelopmentServiceWorker(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => serviceWorkerPath(registration) === "/sw.js")
        .map((registration) => registration.unregister())
    );
  }

  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
  }
}

function serviceWorkerPath(registration: ServiceWorkerRegistration): string | undefined {
  const scriptUrl =
    registration.active?.scriptURL ?? registration.waiting?.scriptURL ?? registration.installing?.scriptURL;
  return scriptUrl ? new URL(scriptUrl).pathname : undefined;
}
