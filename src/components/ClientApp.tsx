"use client";

import { useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Bookmark } from "@/lib/types";
import { CITIES, PlaceType, PLACE_TYPE_LABELS } from "@/lib/types";
import { platformEmoji, placeTypeEmoji } from "@/lib/utils";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  xiaohongshu: "小紅書",
  youtube: "YouTube",
  tiktok: "TikTok",
  googlemaps: "Google Maps",
  other: "其他",
};

/**
 * 一篇貼文拆出來的多個地點，在畫面上要收在同一個框裡。
 * single = 單獨一筆（source_url 是 null，也就是以前就有的一般收藏）
 * group  = 同一個 source_url 的一群（IG／小紅書「一篇介紹 8 家店」拆出來的）
 */
type DisplayRow =
  | { kind: "single"; bookmark: Bookmark }
  | { kind: "group"; sourceUrl: string; items: Bookmark[] };

function groupBySource(list: Bookmark[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  // source_url → 已經放進 rows 的那個 group，之後同一篇的都塞進去
  const openGroups = new Map<string, Extract<DisplayRow, { kind: "group" }>>();

  for (const bookmark of list) {
    const source = bookmark.source_url;
    if (!source) {
      rows.push({ kind: "single", bookmark });
      continue;
    }
    const existing = openGroups.get(source);
    if (existing) {
      existing.items.push(bookmark);
    } else {
      const group: Extract<DisplayRow, { kind: "group" }> = {
        kind: "group",
        sourceUrl: source,
        items: [bookmark],
      };
      openGroups.set(source, group);
      rows.push(group);
    }
  }

  // 篩選之後可能整群只剩一筆，這時候框起來反而多餘 → 打回單筆顯示
  return rows.map((row) =>
    row.kind === "group" && row.items.length === 1
      ? { kind: "single" as const, bookmark: row.items[0] }
      : row
  );
}

interface Props {
  initialBookmarks: Bookmark[];
  groupName: string;
}

export default function ClientApp({ initialBookmarks, groupName }: Props) {
  const [bookmarks, setBookmarks] = useState(initialBookmarks);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: "", city: "", place_type: "" });
  const [filters, setFilters] = useState({
    city: "",
    district: "",
    placeType: "",
    search: "",
  });

  const districts = filters.city ? CITIES[filters.city] || [] : [];

  const handleDelete = async (id: string) => {
    if (!confirm("確定要刪除這筆收藏嗎？")) return;
    await supabase.from("bookmarks").delete().eq("id", id);
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  };

  const handleToggleVisited = async (id: string, visited: boolean) => {
    await supabase.from("bookmarks").update({ visited }).eq("id", id);
    setBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, visited } : b)));
  };

  const handleReEnrich = async (id: string) => {
    await supabase.from("bookmarks").update({ enriched_at: null, confidence: null }).eq("id", id);
    setBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, enriched_at: null, confidence: null } : b)));
  };

  const startEdit = (b: Bookmark) => {
    setEditingId(b.id);
    setEditForm({ title: b.title || "", city: b.city || "", place_type: b.place_type || "" });
  };

  const saveEdit = async (id: string) => {
    const updates: Record<string, string | null> = {
      title: editForm.title || null,
      city: editForm.city || null,
      place_type: editForm.place_type || null,
    };
    await supabase.from("bookmarks").update(updates).eq("id", id);
    setBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, ...updates } : b)));
    setEditingId(null);
  };

  /**
   * 單張書籤卡。抽成函式是因為它現在有兩個出現位置：
   * 直接列在清單上，或包在「同一篇貼文」的群組框裡（inGroup=true）。
   */
  const renderBookmark = (bookmark: Bookmark, inGroup = false) => (
    <div key={bookmark.id} className="border border-border rounded-2xl overflow-hidden bg-card">
      <div className="p-4 space-y-2">
        {editingId === bookmark.id ? (
          /* Edit Mode */
          <div className="space-y-3">
            <input
              type="text"
              value={editForm.title}
              onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              placeholder="名稱"
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm"
            />
            <select
              value={editForm.city}
              onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm"
            >
              <option value="">選擇縣市</option>
              {Object.keys(CITIES).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={editForm.place_type}
              onChange={(e) => setEditForm({ ...editForm, place_type: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm"
            >
              <option value="">選擇類型</option>
              {(Object.entries(PLACE_TYPE_LABELS) as [PlaceType, string][]).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={() => saveEdit(bookmark.id)}
                className="px-4 py-1.5 bg-primary text-white rounded-lg text-sm font-medium"
              >
                儲存
              </button>
              <button
                onClick={() => setEditingId(null)}
                className="px-4 py-1.5 border border-border rounded-lg text-sm text-muted"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          /* View Mode */
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-base truncate">
                  {placeTypeEmoji(bookmark.place_type)}{" "}
                  {bookmark.title || "未命名收藏"}
                </h3>
                <p className="text-sm text-muted flex items-center gap-1 mt-0.5">
                  {platformEmoji(bookmark.platform)}{" "}
                  {PLATFORM_LABELS[bookmark.platform] || "其他"}
                  {bookmark.city && (
                    <>
                      <span className="mx-1">·</span>
                      {bookmark.city}
                      {bookmark.district && ` ${bookmark.district}`}
                    </>
                  )}
                </p>
              </div>
              <button
                onClick={() => handleToggleVisited(bookmark.id, !bookmark.visited)}
                className={`text-2xl ${bookmark.visited ? "opacity-100" : "opacity-30"}`}
              >
                ✅
              </button>
            </div>

            {bookmark.tags && bookmark.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {bookmark.tags.filter(t => t !== "疑似重複").map((tag) => (
                  <span key={tag} className="px-2 py-0.5 bg-orange-50 text-orange-600 rounded-full text-xs">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {bookmark.place_type && (
              <span className="inline-block px-2 py-0.5 bg-stone-100 rounded-full text-xs text-muted">
                {PLACE_TYPE_LABELS[bookmark.place_type as PlaceType] || bookmark.place_type}
              </span>
            )}

            <div className="flex gap-3 mt-1">
              {/* 拆出來的地點：url 是它自己的 Google Maps 連結，原貼文在 source_url。
                  群組框上面已經有一個「查看原始貼文」了，卡片裡就不再重複放。 */}
              {!inGroup && (
                <a
                  href={bookmark.source_url || bookmark.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary text-sm font-medium"
                >
                  {bookmark.platform === "googlemaps" && !bookmark.source_url
                    ? "🗺️ 在 Google Maps 開啟 →"
                    : "查看原始貼文 →"}
                </a>
              )}
              {/* 本身就是地圖連結時不用再給一個搜尋連結。
                  拆出來的地點（source_url 有值）直接用 bookmark.url —— 那就是建立當下
                  存好的地圖連結，也是 unique (group_id, url) 的去重鍵。用它而不是即時
                  重組，好處是之後在網頁上改了店名／縣市，這顆按鈕仍然指向當初收錄的那家店。 */}
              {(bookmark.platform !== "googlemaps" || bookmark.source_url) &&
                (bookmark.title || bookmark.city) && (
                <a
                  href={bookmark.source_url
                    ? bookmark.url
                    : `https://www.google.com/maps/search/${encodeURIComponent([bookmark.title, bookmark.city, bookmark.district].filter(Boolean).join(" "))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-600 text-sm font-medium"
                >
                  📍 Google Maps
                </a>
              )}
            </div>

            {bookmark.tags?.includes("疑似重複") && (
              <span className="inline-block px-2 py-0.5 bg-red-50 text-red-600 rounded-full text-xs font-medium">
                ⚠️ 疑似重複收藏，請確認是否為同一家店
              </span>
            )}
            {bookmark.confidence !== null && bookmark.confidence < 0.7 && (
              <span className="inline-block px-2 py-0.5 bg-amber-50 text-amber-600 rounded-full text-xs">
                ⚠️ 自動辨識信心偏低，建議確認
              </span>
            )}
            {bookmark.enriched_at === null && (
              <span className="inline-block px-2 py-0.5 bg-blue-50 text-blue-500 rounded-full text-xs">
                🔄 等待自動辨識中...
              </span>
            )}

            <div className="flex gap-3 pt-2 border-t border-border">
              <button
                onClick={() => startEdit(bookmark)}
                className="text-sm text-primary font-medium"
              >
                ✏️ 編輯
              </button>
              <button
                onClick={() => handleReEnrich(bookmark.id)}
                className="text-sm text-blue-500 font-medium"
              >
                🔄 重新辨識
              </button>
              <button
                onClick={() => handleDelete(bookmark.id)}
                className="text-sm text-red-500 font-medium"
              >
                🗑️ 刪除
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const filtered = bookmarks.filter((b) => {
    if (filters.city && b.city !== filters.city) return false;
    if (filters.district && b.district !== filters.district) return false;
    if (filters.placeType && b.place_type !== filters.placeType) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const match =
        b.title?.toLowerCase().includes(q) ||
        b.tags?.some((t) => t.toLowerCase().includes(q)) ||
        b.description?.toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });

  const displayRows = groupBySource(filtered);

  return (
    <div className="max-w-lg mx-auto pb-24">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-stone-50/90 backdrop-blur-lg border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">📍 旅遊收藏</h1>
          <span className="text-sm px-3 py-1 rounded-full bg-card border border-border">
            👥 {groupName}
          </span>
        </div>
      </header>

      {/* Filters */}
      <div className="px-4 pt-4 space-y-3">
        <input
          type="text"
          placeholder="搜尋名稱或標籤..."
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          className="w-full px-3 py-2 rounded-xl border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary"
        />
        <div className="flex gap-2 overflow-x-auto pb-1">
          <select
            value={filters.city}
            onChange={(e) => setFilters({ ...filters, city: e.target.value, district: "" })}
            className="px-3 py-1.5 rounded-full border border-border bg-card text-sm shrink-0"
          >
            <option value="">所有縣市</option>
            {Object.keys(CITIES).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          {filters.city && districts.length > 0 && (
            <select
              value={filters.district}
              onChange={(e) => setFilters({ ...filters, district: e.target.value })}
              className="px-3 py-1.5 rounded-full border border-border bg-card text-sm shrink-0"
            >
              <option value="">所有區域</option>
              {districts.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}

          <select
            value={filters.placeType}
            onChange={(e) => setFilters({ ...filters, placeType: e.target.value })}
            className="px-3 py-1.5 rounded-full border border-border bg-card text-sm shrink-0"
          >
            <option value="">所有類型</option>
            {(Object.entries(PLACE_TYPE_LABELS) as [PlaceType, string][]).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 pt-3 pb-1">
        <p className="text-sm text-muted">
          {filtered.length} 筆收藏
          {filters.city && ` · ${filters.city}`}
          {filters.district && ` ${filters.district}`}
        </p>
      </div>

      {/* Bookmark List */}
      <div className="px-4 space-y-3 pt-2">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-muted">
            <div className="text-4xl mb-3">🗺️</div>
            <p>還沒有收藏</p>
            <p className="text-sm mt-1">用 LINE Bot 傳連結開始收藏！</p>
          </div>
        ) : (
          displayRows.map((row) =>
            row.kind === "single" ? (
              renderBookmark(row.bookmark)
            ) : (
              /* 同一篇貼文拆出來的多個地點：框起來，標題列直接連回原貼文 */
              <div
                key={row.sourceUrl}
                className="rounded-2xl border border-orange-200 bg-orange-50/50 p-2 space-y-2"
              >
                <div className="flex items-center justify-between gap-2 px-2 pt-1">
                  <span className="text-xs font-medium text-orange-700 shrink-0">
                    📋 同一篇貼文的 {row.items.length} 個地點
                  </span>
                  <a
                    href={row.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary font-medium shrink-0"
                  >
                    查看原始貼文 →
                  </a>
                </div>
                {row.items.map((b) => renderBookmark(b, true))}
              </div>
            )
          )
        )}
      </div>
    </div>
  );
}
