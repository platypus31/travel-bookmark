import { useSyncExternalStore } from "react";

// 讀網址上的 ?list=<id>（清單分享連結用）。跟 identity.ts 的 useIdentity 同一招：
// 用 useSyncExternalStore 讀外部狀態，SSR 那次固定回傳 null，避免 hydration 對不起來，
// 也不需要 effect 裡 setState（會被 react-hooks/set-state-in-effect 擋）。

// codex review 備註（2026-09-26）：只監聽 popstate，站內用 pushState 改 ?list=
// 而不整頁換頁時抓不到變化。目前唯一用法是分享連結整頁載入（見 MyLists.tsx 的
// shareUrl() 跟 ClientApp.tsx 的 focus 模式），沒有站內導頁會改這個參數，
// 現況不受影響；之後如果加了「站內切換清單改網址」才需要處理。
function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getSnapshot(): string | null {
  return new URLSearchParams(window.location.search).get("list");
}

function getServerSnapshot(): string | null {
  return null;
}

export function useListParam(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
