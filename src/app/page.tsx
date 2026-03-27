"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Bookmark, Group, Profile } from "@/lib/types";
import AuthForm from "@/components/AuthForm";
import SetupProfile from "@/components/SetupProfile";
import BookmarkCard from "@/components/BookmarkCard";
import FilterBar from "@/components/FilterBar";
import AddBookmark from "@/components/AddBookmark";
import GroupInfo from "@/components/GroupInfo";
import type { User } from "@supabase/supabase-js";

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [filters, setFilters] = useState({
    city: "",
    district: "",
    placeType: "",
    search: "",
  });

  const loadProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    setProfile(data);
    return data;
  }, []);

  const loadGroup = useCallback(async (groupId: string) => {
    const { data } = await supabase
      .from("groups")
      .select("*")
      .eq("id", groupId)
      .single();
    setGroup(data);
  }, []);

  const loadBookmarks = useCallback(async (groupId: string) => {
    const { data } = await supabase
      .from("bookmarks")
      .select("*")
      .eq("group_id", groupId)
      .order("created_at", { ascending: false });
    setBookmarks(data || []);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfile(session.user.id).then((p) => {
          if (p?.group_id) {
            loadGroup(p.group_id);
            loadBookmarks(p.group_id);
          }
        });
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        if (session?.user) {
          loadProfile(session.user.id).then((p) => {
            if (p?.group_id) {
              loadGroup(p.group_id);
              loadBookmarks(p.group_id);
            }
          });
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [loadProfile, loadGroup, loadBookmarks]);

  const handleToggleVisited = async (id: string, visited: boolean) => {
    await supabase.from("bookmarks").update({ visited }).eq("id", id);
    setBookmarks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, visited } : b))
    );
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setGroup(null);
    setBookmarks([]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-dvh">
        <div className="text-muted">載入中...</div>
      </div>
    );
  }

  if (!user) return <AuthForm />;

  if (!profile) {
    return (
      <SetupProfile
        userId={user.id}
        onComplete={() => loadProfile(user.id).then((p) => {
          if (p?.group_id) {
            loadGroup(p.group_id);
            loadBookmarks(p.group_id);
          }
        })}
      />
    );
  }

  const filtered = bookmarks.filter((b) => {
    if (filters.city && b.city !== filters.city) return false;
    if (filters.district && b.district !== filters.district) return false;
    if (filters.placeType && b.place_type !== filters.placeType) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const match =
        b.title?.toLowerCase().includes(q) ||
        b.tags.some((t) => t.toLowerCase().includes(q)) ||
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowGroup(true)}
              className="text-sm px-3 py-1 rounded-full bg-card border border-border"
            >
              👥 {group?.name || "群組"}
            </button>
            <button
              onClick={handleLogout}
              className="text-sm text-muted"
            >
              登出
            </button>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="px-4 pt-4">
        <FilterBar filters={filters} onChange={setFilters} />
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
            <p className="text-sm mt-1">點右下角 + 新增第一筆吧！</p>
          </div>
        ) : (
          filtered.map((bookmark) => (
            <BookmarkCard
              key={bookmark.id}
              bookmark={bookmark}
              onToggleVisited={handleToggleVisited}
            />
          ))
        )}
      </div>

      {/* FAB */}
      <button
        onClick={() => setShowAdd(true)}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-primary text-primary-fg text-3xl shadow-lg flex items-center justify-center z-40"
      >
        +
      </button>

      {/* Modals */}
      {showAdd && profile.group_id && (
        <AddBookmark
          groupId={profile.group_id}
          userId={user.id}
          onAdded={() => profile.group_id && loadBookmarks(profile.group_id)}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showGroup && group && (
        <GroupInfo group={group} onClose={() => setShowGroup(false)} />
      )}
    </div>
  );
}
