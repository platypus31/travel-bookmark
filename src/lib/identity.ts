// 網頁端身分＝從 LINE 群組成員名單挑一個名字，不提供自由新增名字
// （profiles 完全由 LINE webhook 依 LINE userId 建立/更新，見
// supabase/migrations/2026-09-26-collab-history-lists.sql 與 docs/collab-design.md）。
// 這是君子協定不是登入系統：任何人都能選別人的名字，這裡刻意不假裝做驗證。
//
// 用 useSyncExternalStore 讀 localStorage，不用「mounted flag + useEffect 裡
// setState」那種寫法——後者會在 SSR 那次 render 跟瀏覽器 hydrate 那次 render
// 之間手動切換兩次 state，屬於 effect 裡直接呼叫 setState 的反樣式（React 官方
// 文件跟本專案新版 eslint react-hooks/set-state-in-effect 規則都會擋）。
// useSyncExternalStore 原生就是為了「讀一個外部 store、SSR 用固定 snapshot、
// hydrate 後換成瀏覽器真實值」這個情境設計的，不需要額外的 mounted state。

import { useCallback, useSyncExternalStore } from "react";

export interface Identity {
  id: string;
  display_name: string;
}

const STORAGE_KEY = "tb_identity";
const listeners = new Set<() => void>();

function parse(raw: string | null): Identity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string" && typeof parsed.display_name === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // 無痕視窗/被封鎖時 localStorage 會噴錯，當作沒有身分處理即可
    return null;
  }
}

function getServerSnapshot(): string | null {
  return null;
}

/** 目前選的身分 + 切換函式。SSR 與 hydrate 前一律回傳 null，之後才換成瀏覽器真實值。 */
export function useIdentity(): [Identity | null, (next: Identity | null) => void] {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setIdentity = useCallback((next: Identity | null) => {
    try {
      if (next) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // 存不進去就算了，最多下次重整要重選一次名字，不影響其他功能
    }
    listeners.forEach((l) => l());
  }, []);
  return [parse(raw), setIdentity];
}
