"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Bookmark, BookmarkEdit, GroupMember } from "@/lib/types";
import { CITIES, PlaceType, PLACE_TYPE_LABELS, EDITABLE_FIELD_LABELS } from "@/lib/types";
import { platformEmoji, placeTypeEmoji } from "@/lib/utils";
import { useIdentity } from "@/lib/identity";
import { useLists } from "@/lib/useLists";
import { useListParam } from "@/lib/useListParam";
import IdentityPicker from "@/components/IdentityPicker";
import MyLists from "@/components/MyLists";

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

// export 是為了能單獨測這段分組邏輯（它決定畫面怎麼把「同一篇貼文」收在一起）。
// 元件本身用不到 export，但沒 export 就只能靠肉眼看畫面驗證。
export function groupBySource(list: Bookmark[]): DisplayRow[] {
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
  groupId: string;
}

/** trigger 把 visited 存成 "true"/"false" 字串，顯示時轉中文 */
function formatEditValue(field: string, value: string | null): string {
  if (field === "visited") return value === "true" ? "已造訪" : "未造訪";
  return value || "（空）";
}

export default function ClientApp({ initialBookmarks, groupName, groupId }: Props) {
  const [bookmarks, setBookmarks] = useState(initialBookmarks);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: "", city: "", place_type: "" });
  const [filters, setFilters] = useState({
    city: "",
    district: "",
    placeType: "",
    search: "",
    uploader: "",
  });
  const [tab, setTab] = useState<"pool" | "lists">("pool");

  // 身分：選名字（來自 LINE 成員名單）。useIdentity 用 useSyncExternalStore 讀
  // localStorage，SSR 那次固定回傳 null、hydrate 後才換成瀏覽器真實值，
  // 不需要額外的 mounted state 也不會有 SSR/CSR 對不起來的問題。
  const [identity, setIdentity] = useIdentity();
  const [showIdentityPicker, setShowIdentityPicker] = useState(false);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);

  // 個人清單／分類，跟「依上傳者篩選」時要列的「他建立的清單」共用同一份資料。
  const { lists, itemsByList, loading: listsLoading, reload: reloadLists } = useLists(groupId);
  // 分享連結 /?list=<id> 進來時只顯示那一個清單。
  const listParam = useListParam();

  // 編輯歷史：按需展開、按 bookmark id 快取。
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyCache, setHistoryCache] = useState<Record<string, BookmarkEdit[] | "error">>({});

  // 「+ 建立新清單」快速輸入（在「依上傳者篩選＝自己」時顯示，不用切去清單分頁）。
  const [quickListName, setQuickListName] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMembersLoading(true);
      const { data } = await supabase.rpc("list_group_members", { p_group_id: groupId });
      if (!cancelled) {
        setMembers(data || []);
        setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const memberName = (id: string | null | undefined): string => {
    if (!id) return "";
    return members.find((m) => m.id === id)?.display_name || "未知成員";
  };

  const handleSelectIdentity = (member: GroupMember) => {
    setIdentity({ id: member.id, display_name: member.display_name });
    setShowIdentityPicker(false);
  };

  const districts = filters.city ? CITIES[filters.city] || [] : [];

  const handleDelete = async (id: string) => {
    if (!confirm("確定要刪除這筆收藏嗎？")) return;
    await supabase.from("bookmarks").delete().eq("id", id);
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  };

  const fetchHistory = async (id: string) => {
    const { data, error } = await supabase
      .from("bookmark_edits")
      .select("*")
      .eq("bookmark_id", id)
      .order("created_at", { ascending: false });
    // 查詢失敗要跟「真的沒紀錄」分開顯示，不然使用者會以為這筆沒人改過
    setHistoryCache((prev) => ({ ...prev, [id]: error ? "error" : data || [] }));
  };

  /**
   * 寫入 updated_by 會讓 DB trigger 多一筆 bookmark_edits，快取要跟著失效。
   * 面板正展開 → 直接重抓（只刪快取會卡在「載入中...」，因為只有關→開才會抓）；
   * 沒展開 → 刪快取，下次展開再抓。
   */
  const invalidateHistory = (id: string) => {
    if (expandedHistoryId === id) {
      void fetchHistory(id);
      return;
    }
    setHistoryCache((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleToggleVisited = async (id: string, visited: boolean) => {
    const updates: Record<string, unknown> = { visited };
    if (identity) {
      updates.updated_by = identity.id;
      updates.user_edited_at = new Date().toISOString(); // trigger 靠這欄判定是人按的
    }
    await supabase.from("bookmarks").update(updates).eq("id", id);
    // 帶 ...updates（不是只帶 visited）— 沒帶會漏掉 updated_by，畫面上「上次編輯」
    // 要重新整理頁面才會顯示正確編輯者（跟下面 saveEdit 的寫法保持一致）。
    setBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, ...updates } : b)));
    invalidateHistory(id);
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
    if (identity) {
      updates.updated_by = identity.id;
      updates.user_edited_at = new Date().toISOString(); // trigger 靠這欄判定是人按的
    }
    await supabase.from("bookmarks").update(updates).eq("id", id);
    setBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, ...updates } : b)));
    setEditingId(null);
    invalidateHistory(id);
  };

  const toggleHistory = async (id: string) => {
    if (expandedHistoryId === id) {
      setExpandedHistoryId(null);
      return;
    }
    setExpandedHistoryId(id);
    if (!historyCache[id] || historyCache[id] === "error") await fetchHistory(id);
  };

  const uploaderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bookmarks) {
      if (b.created_by) counts.set(b.created_by, (counts.get(b.created_by) || 0) + 1);
    }
    return counts;
  }, [bookmarks]);

  const handleQuickCreateList = async () => {
    const name = quickListName.trim();
    if (!name || !identity) return;
    const { error } = await supabase
      .from("lists")
      .insert({ group_id: groupId, created_by: identity.id, name });
    if (error) {
      alert("建立清單失敗：" + error.message);
      return;
    }
    setQuickListName("");
    await reloadLists();
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

            {/* 一行歸屬：編輯過就顯示最後編輯者，沒編輯過才顯示上傳者。
                完整歷史（含上傳本身）在下面「🕘 編輯紀錄」展開看，這裡只給一眼摘要。 */}
            {(bookmark.updated_by || bookmark.created_by) && (
              <p className="text-xs text-muted">
                {bookmark.updated_by
                  ? `${memberName(bookmark.updated_by) || "未知"} 上次編輯`
                  : `${memberName(bookmark.created_by) || "未知"} 上傳`}
              </p>
            )}

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

            <div className="flex gap-3 pt-2 border-t border-border flex-wrap">
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
                onClick={() => toggleHistory(bookmark.id)}
                className="text-sm text-muted font-medium"
              >
                🕘 編輯紀錄
              </button>
              <button
                onClick={() => handleDelete(bookmark.id)}
                className="text-sm text-red-500 font-medium"
              >
                🗑️ 刪除
              </button>
            </div>

            {expandedHistoryId === bookmark.id && (
              <div className="mt-1 p-2.5 rounded-xl bg-stone-50 dark:bg-zinc-800/50 space-y-1 text-xs">
                {(() => {
                  const history = historyCache[bookmark.id];
                  if (!history) return <p className="text-muted">載入中...</p>;
                  if (history === "error")
                    return <p className="text-muted">載入失敗，關掉再點一次「🕘 編輯紀錄」重試</p>;
                  if (history.length === 0) return <p className="text-muted">還沒有編輯紀錄</p>;
                  return history.map((edit) => (
                    <p key={edit.id} className="text-muted">
                      {memberName(edit.editor_id) || "未知"} 改了「
                      {EDITABLE_FIELD_LABELS[edit.field] || edit.field}」：
                      {formatEditValue(edit.field, edit.old_value)} → {formatEditValue(edit.field, edit.new_value)}
                      <span className="ml-1">
                        · {new Date(edit.created_at).toLocaleString("zh-TW", {
                          month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                    </p>
                  ));
                })()}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  const filtered = bookmarks.filter((b) => {
    if (filters.city && b.city !== filters.city) return false;
    if (filters.district && b.district !== filters.district) return false;
    if (filters.placeType && b.place_type !== filters.placeType) return false;
    if (filters.uploader && b.created_by !== filters.uploader) return false;
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
  const theirLists = filters.uploader ? lists.filter((l) => l.created_by === filters.uploader) : [];

  if (!identity) {
    return (
      <IdentityPicker
        members={members}
        loading={membersLoading}
        onSelect={handleSelectIdentity}
      />
    );
  }

  // 分享連結 /?list=<id> 進來：只顯示那一個清單，跳過收藏/清單分頁。
  if (listParam) {
    return (
      <div className="max-w-lg mx-auto pb-24">
        <header className="sticky top-0 z-40 bg-stone-50/90 backdrop-blur-lg border-b border-border px-4 py-3">
          <h1 className="text-lg font-bold">📍 旅遊收藏 · 分享的清單</h1>
        </header>
        <MyLists
          groupId={groupId}
          identity={identity}
          bookmarks={bookmarks}
          members={members}
          lists={lists}
          itemsByList={itemsByList}
          loading={listsLoading}
          reload={reloadLists}
          focusListId={listParam}
        />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto pb-24">
      {showIdentityPicker && (
        <IdentityPicker
          members={members}
          loading={membersLoading}
          current={identity}
          onClose={() => setShowIdentityPicker(false)}
          onSelect={handleSelectIdentity}
        />
      )}

      {/* Header */}
      <header className="sticky top-0 z-40 bg-stone-50/90 backdrop-blur-lg border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-bold shrink-0">📍 旅遊收藏</h1>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm px-3 py-1 rounded-full bg-card border border-border truncate">
              👥 {groupName}
            </span>
            <button
              onClick={() => setShowIdentityPicker(true)}
              className="text-sm px-3 py-1 rounded-full bg-card border border-border shrink-0"
            >
              🙋 {identity.display_name}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => setTab("pool")}
            className={`px-3 py-1.5 rounded-full text-sm font-medium ${
              tab === "pool" ? "bg-primary text-primary-fg" : "bg-card border border-border"
            }`}
          >
            🗺️ 收藏
          </button>
          <button
            onClick={() => setTab("lists")}
            className={`px-3 py-1.5 rounded-full text-sm font-medium ${
              tab === "lists" ? "bg-primary text-primary-fg" : "bg-card border border-border"
            }`}
          >
            📋 清單
          </button>
        </div>
      </header>

      {tab === "lists" ? (
        <MyLists
          groupId={groupId}
          identity={identity}
          bookmarks={bookmarks}
          members={members}
          lists={lists}
          itemsByList={itemsByList}
          loading={listsLoading}
          reload={reloadLists}
        />
      ) : (
        <>
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

              <select
                value={filters.uploader}
                onChange={(e) => setFilters({ ...filters, uploader: e.target.value })}
                className="px-3 py-1.5 rounded-full border border-border bg-card text-sm shrink-0"
              >
                <option value="">全部（依上傳者）</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}（{uploaderCounts.get(m.id) || 0}）
                  </option>
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
              {filters.uploader && ` · ${memberName(filters.uploader)} 上傳`}
            </p>
          </div>

          {/* 依上傳者篩選時：列出這個人建立的清單，選到自己還能直接開新清單 */}
          {filters.uploader && (
            <div className="px-4 pb-1 space-y-2">
              {theirLists.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted">
                    {memberName(filters.uploader)} 建立的清單
                  </p>
                  {theirLists.map((l) => (
                    // 用 ?list=<id> 整頁導向（跟分享連結同一條路）直接打開這一個清單；
                    // 只 setTab("lists") 會落在整個清單分頁，使用者還得自己找。
                    <a
                      key={l.id}
                      href={`?list=${encodeURIComponent(l.id)}`}
                      className="w-full text-left px-3 py-2 rounded-xl border border-border bg-card text-sm flex items-center justify-between"
                    >
                      <span>📋 {l.name}</span>
                      <span className="text-xs text-muted">
                        {(itemsByList[l.id] || []).length} 筆 →
                      </span>
                    </a>
                  ))}
                </div>
              )}
              {filters.uploader === identity.id && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="+ 建立你的新清單"
                    value={quickListName}
                    onChange={(e) => setQuickListName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleQuickCreateList()}
                    className="flex-1 px-3 py-1.5 rounded-xl border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary"
                  />
                  <button
                    onClick={handleQuickCreateList}
                    disabled={!quickListName.trim()}
                    className="px-3 py-1.5 rounded-xl bg-primary text-primary-fg text-sm font-medium disabled:opacity-50"
                  >
                    建立
                  </button>
                </div>
              )}
            </div>
          )}

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
        </>
      )}
    </div>
  );
}
