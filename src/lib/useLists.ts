import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { BookmarkList, ListItem } from "@/lib/types";

/**
 * lists / list_items 的共用資料來源。抽成 hook 是因為主頁面（右上角依上傳者
 * 篩選時要列出「他建立的子清單」）跟「清單」分頁（MyLists.tsx）現在要共用
 * 同一份資料，不要各自 fetch 一次、也不要靠 props 手動同步兩份 state。
 */
export function useLists(groupId: string) {
  const [lists, setLists] = useState<BookmarkList[]>([]);
  const [itemsByList, setItemsByList] = useState<Record<string, ListItem[]>>({});
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data: listRows } = await supabase
      .from("lists")
      .select("*")
      .eq("group_id", groupId)
      .order("created_at", { ascending: false });
    const allLists = listRows || [];
    setLists(allLists);

    if (allLists.length > 0) {
      const ids = allLists.map((l) => l.id);
      const { data: itemRows } = await supabase.from("list_items").select("*").in("list_id", ids);
      const grouped: Record<string, ListItem[]> = {};
      for (const item of itemRows || []) {
        (grouped[item.list_id] ||= []).push(item);
      }
      setItemsByList(grouped);
    } else {
      setItemsByList({});
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { lists, itemsByList, loading, reload };
}
