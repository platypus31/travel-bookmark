"use client";

import { useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { CITIES, PlaceType, PLACE_TYPE_LABELS } from "@/lib/types";
import { detectPlatform, platformEmoji } from "@/lib/utils";

interface Props {
  groupId: string;
  userId: string;
  onAdded: () => void;
  onClose: () => void;
}

export default function AddBookmark({ groupId, userId, onAdded, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [placeType, setPlaceType] = useState<PlaceType | "">("");
  const [tags, setTags] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);

  const fetchPreview = useCallback(async (inputUrl: string) => {
    if (!inputUrl.trim()) return;
    try {
      new URL(inputUrl);
    } catch {
      return;
    }

    setFetching(true);
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: inputUrl.trim() }),
      });
      const data = await res.json();
      if (data.title && !title) setTitle(data.title);
      if (data.description && !description) setDescription(data.description);
      if (data.image) setImageUrl(data.image);
    } catch {
      // Silently fail — user can still fill manually
    }
    setFetching(false);
  }, [title, description]);

  const handleUrlChange = (value: string) => {
    setUrl(value);
  };

  const handleUrlBlur = () => {
    if (url.trim()) fetchPreview(url);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text");
    if (pasted) {
      setTimeout(() => fetchPreview(pasted), 100);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    const platform = detectPlatform(url);

    const { error } = await supabase.from("bookmarks").insert({
      group_id: groupId,
      created_by: userId,
      url: url.trim(),
      platform,
      title: title.trim() || null,
      description: description.trim() || null,
      image_url: imageUrl.trim() || null,
      city: city || null,
      district: district || null,
      place_type: placeType || null,
      tags: tags
        .split(/[,，、]/)
        .map((t) => t.trim())
        .filter(Boolean),
    });

    if (error) {
      alert("新增失敗：" + error.message);
    } else {
      onAdded();
      onClose();
    }
    setLoading(false);
  };

  const districts = city ? CITIES[city] || [] : [];
  const platform = url ? detectPlatform(url) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center">
      <div className="bg-white dark:bg-zinc-900 w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">新增收藏</h2>
          <button onClick={onClose} className="text-muted text-2xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* URL Input */}
          <div>
            <label className="block text-sm font-medium mb-1">貼上連結 *</label>
            <input
              type="url"
              placeholder="https://www.instagram.com/p/..."
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              onBlur={handleUrlBlur}
              onPaste={handlePaste}
              required
              className="w-full px-3 py-2.5 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary"
            />
            {platform && (
              <span className="text-xs text-muted mt-1 flex items-center gap-1">
                {platformEmoji(platform)} {platform}
                {fetching && <span className="ml-2 animate-pulse">抓取中...</span>}
              </span>
            )}
          </div>

          {/* Preview Card */}
          {(imageUrl || (title && fetching === false && url)) && (
            <div className="rounded-xl border border-border overflow-hidden bg-card">
              {imageUrl && (
                <img
                  src={imageUrl}
                  alt="預覽"
                  className="w-full h-40 object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              {title && (
                <div className="p-3">
                  <p className="text-sm font-medium line-clamp-2">{title}</p>
                  {description && (
                    <p className="text-xs text-muted mt-1 line-clamp-2">{description}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Title */}
          <div>
            <label className="block text-sm font-medium mb-1">標題 / 店名</label>
            <input
              type="text"
              placeholder="例：超好吃的鹽酥雞"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* City & District */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">縣市</label>
              <select
                value={city}
                onChange={(e) => {
                  setCity(e.target.value);
                  setDistrict("");
                }}
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">選擇縣市</option>
                {Object.keys(CITIES).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">區域</label>
              <select
                value={district}
                onChange={(e) => setDistrict(e.target.value)}
                disabled={!city}
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
              >
                <option value="">選擇區域</option>
                {districts.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Place Type */}
          <div>
            <label className="block text-sm font-medium mb-1">類型</label>
            <div className="flex flex-wrap gap-2">
              {(Object.entries(PLACE_TYPE_LABELS) as [PlaceType, string][]).map(
                ([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPlaceType(placeType === key ? "" : key)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium ${
                      placeType === key
                        ? "bg-primary text-primary-fg"
                        : "bg-card border border-border"
                    }`}
                  >
                    {label}
                  </button>
                )
              )}
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium mb-1">標籤</label>
            <input
              type="text"
              placeholder="日式、海鮮、約會（逗號分隔）"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="w-full py-3 rounded-xl bg-primary text-primary-fg font-semibold text-base disabled:opacity-50"
          >
            {loading ? "儲存中..." : "儲存收藏"}
          </button>
        </form>
      </div>
    </div>
  );
}
