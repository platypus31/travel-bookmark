"use client";

import { useState } from "react";
import { Bookmark, PLACE_TYPE_LABELS, PLATFORM_LABELS } from "@/lib/types";
import { platformEmoji, placeTypeEmoji } from "@/lib/utils";

interface Props {
  bookmark: Bookmark;
  onToggleVisited: (id: string, visited: boolean) => void;
  onDelete: (id: string) => void;
}

export default function BookmarkCard({ bookmark, onToggleVisited, onDelete }: Props) {
  const [showActions, setShowActions] = useState(false);

  return (
    <div className="border border-border rounded-2xl overflow-hidden bg-card">
      {/* Cover Image */}
      {bookmark.image_url && (
        <img
          src={bookmark.image_url}
          alt={bookmark.title || ""}
          className="w-full h-40 object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}

      <div className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-base truncate">
              {placeTypeEmoji(bookmark.place_type)}{" "}
              {bookmark.title || "未命名收藏"}
            </h3>
            <p className="text-sm text-muted flex items-center gap-1 mt-0.5">
              {platformEmoji(bookmark.platform)}{" "}
              {PLATFORM_LABELS[bookmark.platform]}
              {bookmark.city && (
                <>
                  <span className="mx-1">·</span>
                  {bookmark.city}
                  {bookmark.district && ` ${bookmark.district}`}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onToggleVisited(bookmark.id, !bookmark.visited)}
              className={`text-2xl ${bookmark.visited ? "opacity-100" : "opacity-30"}`}
              title={bookmark.visited ? "已去過" : "標記去過"}
            >
              ✅
            </button>
            <button
              onClick={() => setShowActions(!showActions)}
              className="text-muted text-xl px-1"
              title="更多"
            >
              ⋯
            </button>
          </div>
        </div>

        {bookmark.description && (
          <p className="text-sm text-muted line-clamp-2">{bookmark.description}</p>
        )}

        {bookmark.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {bookmark.tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 rounded-full text-xs"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {bookmark.place_type && (
          <span className="inline-block px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-full text-xs text-muted">
            {PLACE_TYPE_LABELS[bookmark.place_type]}
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

        {/* Action Menu */}
        {showActions && (
          <div className="flex gap-2 pt-2 border-t border-border">
            <button
              onClick={() => {
                if (confirm("確定要刪除這筆收藏嗎？")) {
                  onDelete(bookmark.id);
                }
              }}
              className="text-sm text-red-500 font-medium"
            >
              刪除
            </button>
            <button
              onClick={() => setShowActions(false)}
              className="text-sm text-muted"
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
