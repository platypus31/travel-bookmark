"use client";

import { useState } from "react";
import { Bookmark } from "@/lib/types";
import { CITIES, PlaceType, PLACE_TYPE_LABELS } from "@/lib/types";
import { platformEmoji, placeTypeEmoji } from "@/lib/utils";

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  xiaohongshu: "小紅書",
  youtube: "YouTube",
  tiktok: "TikTok",
  other: "其他",
};

interface Props {
  initialBookmarks: Bookmark[];
  groupName: string;
}

export default function ClientApp({ initialBookmarks, groupName }: Props) {
  const [bookmarks] = useState(initialBookmarks);
  const [filters, setFilters] = useState({
    city: "",
    district: "",
    placeType: "",
    search: "",
  });

  const districts = filters.city ? CITIES[filters.city] || [] : [];

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

  return (
    <div className="max-w-lg mx-auto pb-24">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-lg border-b border-border px-4 py-3">
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
          filtered.map((bookmark) => (
            <div key={bookmark.id} className="border border-border rounded-2xl overflow-hidden bg-card">
              <div className="p-4 space-y-2">
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
                  <span className={`text-2xl ${bookmark.visited ? "opacity-100" : "opacity-30"}`}>
                    ✅
                  </span>
                </div>

                {bookmark.tags && bookmark.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {bookmark.tags.map((tag) => (
                      <span key={tag} className="px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 rounded-full text-xs">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {bookmark.place_type && (
                  <span className="inline-block px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-full text-xs text-muted">
                    {PLACE_TYPE_LABELS[bookmark.place_type as PlaceType] || bookmark.place_type}
                  </span>
                )}

                <a
                  href={bookmark.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-primary text-sm font-medium mt-1"
                >
                  查看原始貼文 →
                </a>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
