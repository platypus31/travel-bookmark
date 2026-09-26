"use client";

import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Bookmark, BookmarkList, GroupMember, ListEdit, ListItem } from "@/lib/types";
import { Identity } from "@/lib/identity";

interface Props {
  groupId: string;
  identity: Identity;
  bookmarks: Bookmark[];
  members: GroupMember[];
  lists: BookmarkList[];
  itemsByList: Record<string, ListItem[]>;
  loading: boolean;
  reload: () => Promise<void>;
  /** 有值時只顯示這一個清單（分享連結 /?list=<id> 進來的焦點模式）。 */
  focusListId?: string | null;
}

const ACTION_LABELS: Record<string, string> = {
  add: "加入",
  remove: "移出",
  rename: "改名",
};

function memberName(members: GroupMember[], id: string | null): string {
  if (!id) return "未知";
  return members.find((m) => m.id === id)?.display_name || "未知成員";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shareUrl(listId: string): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${window.location.pathname}?list=${listId}`;
}

export default function MyLists({
  groupId,
  identity,
  bookmarks,
  members,
  lists,
  itemsByList,
  loading,
  reload,
  focusListId,
}: Props) {
  const [newListName, setNewListName] = useState("");
  const [expandedListId, setExpandedListId] = useState<string | null>(focusListId || null);
  const [pickerListId, setPickerListId] = useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [historyListId, setHistoryListId] = useState<string | null>(null);
  const [history, setHistory] = useState<ListEdit[]>([]);
  const [renamingListId, setRenamingListId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [copiedListId, setCopiedListId] = useState<string | null>(null);

  const bookmarkTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bookmarks) map.set(b.id, b.title || "未命名收藏");
    return map;
  }, [bookmarks]);

  const handleCreate = async () => {
    const name = newListName.trim();
    if (!name) return;
    const { error } = await supabase
      .from("lists")
      .insert({ group_id: groupId, created_by: identity.id, name });
    if (error) {
      alert("建立清單失敗：" + error.message);
      return;
    }
    setNewListName("");
    await reload();
  };

  const handleRename = async (listId: string) => {
    const name = renameValue.trim();
    if (!name) return;
    const { error } = await supabase.rpc("list_rename", {
      p_list_id: listId,
      p_new_name: name,
      p_actor_id: identity.id,
    });
    if (error) {
      alert("改名失敗：" + error.message);
      return;
    }
    setRenamingListId(null);
    await reload();
  };

  const handleDelete = async (listId: string) => {
    if (!confirm("確定要刪除這個清單？（裡面的收藏不會被刪除，只是拿掉分類）")) return;
    const { error } = await supabase.rpc("list_delete", { p_list_id: listId });
    if (error) {
      alert("刪除失敗：" + error.message);
      return;
    }
    if (expandedListId === listId) setExpandedListId(null);
    await reload();
  };

  const handleAddItem = async (listId: string, bookmarkId: string) => {
    const { error } = await supabase.rpc("list_add_item", {
      p_list_id: listId,
      p_bookmark_id: bookmarkId,
      p_actor_id: identity.id,
    });
    if (error) {
      alert("加入失敗：" + error.message);
      return;
    }
    await reload();
  };

  const handleRemoveItem = async (listId: string, bookmarkId: string) => {
    const { error } = await supabase.rpc("list_remove_item", {
      p_list_id: listId,
      p_bookmark_id: bookmarkId,
      p_actor_id: identity.id,
    });
    if (error) {
      alert("移出失敗：" + error.message);
      return;
    }
    await reload();
  };

  const handleCopyLink = async (listId: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(listId));
      setCopiedListId(listId);
      setTimeout(() => setCopiedListId(null), 2000);
    } catch {
      alert("複製失敗，請手動複製網址：" + shareUrl(listId));
    }
  };

  const openHistory = async (listId: string) => {
    if (historyListId === listId) {
      setHistoryListId(null);
      return;
    }
    setHistoryListId(listId);
    const { data } = await supabase
      .from("list_edits")
      .select("*")
      .eq("list_id", listId)
      .order("created_at", { ascending: false });
    setHistory(data || []);
  };

  if (loading) {
    return <p className="text-center text-sm text-muted py-10">載入清單中...</p>;
  }

  const focusedList = focusListId ? lists.find((l) => l.id === focusListId) : null;
  const visibleLists = focusListId ? (focusedList ? [focusedList] : []) : lists;

  return (
    <div className="px-4 space-y-4 pt-2">
      {focusListId && (
        <div className="flex items-center justify-between">
          <a href="?" className="text-sm text-primary font-medium">
            ← 所有清單
          </a>
          {!focusedList && (
            <span className="text-sm text-muted">這個清單找不到了（可能被刪除了）</span>
          )}
        </div>
      )}

      {/* 建立新清單（焦點模式不顯示，避免分享連結被拿去亂建） */}
      {!focusListId && (
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="新清單名稱，例：這次去花蓮要吃的"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="flex-1 px-3 py-2 rounded-xl border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            onClick={handleCreate}
            disabled={!newListName.trim()}
            className="px-4 py-2 rounded-xl bg-primary text-primary-fg text-sm font-semibold disabled:opacity-50"
          >
            建立
          </button>
        </div>
      )}

      {visibleLists.length === 0 && !focusListId ? (
        <div className="text-center py-16 text-muted">
          <div className="text-4xl mb-3">📋</div>
          <p>還沒有清單</p>
          <p className="text-sm mt-1">建一個清單把想去的地方分類收好</p>
        </div>
      ) : (
        visibleLists.map((list) => {
          const items = itemsByList[list.id] || [];
          const isExpanded = focusListId ? true : expandedListId === list.id;
          const isPicking = pickerListId === list.id;
          const isRenaming = renamingListId === list.id;
          const itemIds = new Set(items.map((i) => i.bookmark_id));
          const pickerCandidates = bookmarks.filter(
            (b) =>
              !itemIds.has(b.id) &&
              (!pickerSearch || (b.title || "").toLowerCase().includes(pickerSearch.toLowerCase()))
          );

          return (
            <div key={list.id} className="border border-border rounded-2xl bg-card overflow-hidden">
              <div className="p-4 space-y-1">
                {isRenaming ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleRename(list.id)}
                      className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
                      autoFocus
                    />
                    <button
                      onClick={() => handleRename(list.id)}
                      className="px-3 py-1.5 bg-primary text-white rounded-lg text-sm font-medium"
                    >
                      儲存
                    </button>
                    <button
                      onClick={() => setRenamingListId(null)}
                      className="px-3 py-1.5 border border-border rounded-lg text-sm text-muted"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold text-base">{list.name}</h3>
                    <span className="text-xs text-muted shrink-0">{items.length} 筆</span>
                  </div>
                )}
                <p className="text-xs text-muted">
                  由 {memberName(members, list.created_by)} 建立
                </p>

                <div className="flex flex-wrap gap-3 pt-2">
                  {!focusListId && (
                    <button
                      onClick={() => setExpandedListId(isExpanded ? null : list.id)}
                      className="text-sm text-primary font-medium"
                    >
                      {isExpanded ? "收合" : "展開"}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setRenamingListId(list.id);
                      setRenameValue(list.name);
                    }}
                    className="text-sm text-blue-500 font-medium"
                  >
                    ✏️ 改名
                  </button>
                  <button
                    onClick={() => openHistory(list.id)}
                    className="text-sm text-muted font-medium"
                  >
                    🕘 歷史
                  </button>
                  <button
                    onClick={() => handleCopyLink(list.id)}
                    className="text-sm text-green-600 font-medium"
                  >
                    {copiedListId === list.id ? "已複製！" : "🔗 分享連結"}
                  </button>
                  {!focusListId && (
                    <button
                      onClick={() => handleDelete(list.id)}
                      className="text-sm text-red-500 font-medium"
                    >
                      🗑️ 刪除
                    </button>
                  )}
                </div>
              </div>

              {historyListId === list.id && (
                <div className="border-t border-border bg-stone-50 dark:bg-zinc-800/50 p-3 space-y-1.5 text-xs">
                  {history.length === 0 ? (
                    <p className="text-muted">還沒有紀錄</p>
                  ) : (
                    history.map((h) => (
                      <p key={h.id} className="text-muted">
                        {memberName(members, h.editor_id)} {ACTION_LABELS[h.action] || h.action}
                        {h.bookmark_id && `「${bookmarkTitle.get(h.bookmark_id) || "已刪除的收藏"}」`}
                        {h.detail && `：${h.detail}`}
                        <span className="ml-1">· {formatTime(h.created_at)}</span>
                      </p>
                    ))
                  )}
                </div>
              )}

              {isExpanded && (
                <div className="border-t border-border p-3 space-y-2">
                  {items.length === 0 ? (
                    <p className="text-sm text-muted text-center py-2">這個清單還沒有收藏</p>
                  ) : (
                    items.map((item) => (
                      <div
                        key={item.bookmark_id}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-stone-50 dark:bg-zinc-800/50"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">
                            {bookmarkTitle.get(item.bookmark_id) || "已刪除的收藏"}
                          </p>
                          <p className="text-xs text-muted">
                            {memberName(members, item.added_by)} 加入
                          </p>
                        </div>
                        <button
                          onClick={() => handleRemoveItem(list.id, item.bookmark_id)}
                          className="text-xs text-red-500 font-medium shrink-0"
                        >
                          移出
                        </button>
                      </div>
                    ))
                  )}

                  {isPicking ? (
                    <div className="space-y-2 pt-1">
                      <input
                        type="text"
                        placeholder="搜尋要加入的收藏..."
                        value={pickerSearch}
                        onChange={(e) => setPickerSearch(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm"
                        autoFocus
                      />
                      <div className="max-h-56 overflow-y-auto space-y-1">
                        {pickerCandidates.length === 0 ? (
                          <p className="text-xs text-muted text-center py-2">沒有符合的收藏</p>
                        ) : (
                          pickerCandidates.slice(0, 30).map((b) => (
                            <button
                              key={b.id}
                              onClick={() => handleAddItem(list.id, b.id)}
                              className="w-full text-left px-3 py-1.5 rounded-lg border border-border bg-white text-sm truncate"
                            >
                              {b.title || "未命名收藏"}
                            </button>
                          ))
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setPickerListId(null);
                          setPickerSearch("");
                        }}
                        className="w-full py-1.5 rounded-lg border border-border text-xs text-muted"
                      >
                        關閉
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setPickerListId(list.id)}
                      className="w-full py-2 rounded-xl border border-dashed border-border text-sm text-primary font-medium"
                    >
                      + 加入收藏
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
