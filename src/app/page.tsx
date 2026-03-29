import { createClient } from "@supabase/supabase-js";
import { Bookmark } from "@/lib/types";
import ClientApp from "@/components/ClientApp";

const DEFAULT_GROUP_ID = "YOUR_LINE_DEFAULT_GROUP_ID";

async function getBookmarks(): Promise<Bookmark[]> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );

  const { data } = await supabase
    .from("bookmarks")
    .select("*")
    .eq("group_id", DEFAULT_GROUP_ID)
    .order("created_at", { ascending: false });

  return data || [];
}

async function getGroupName(): Promise<string> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );

  const { data } = await supabase
    .from("groups")
    .select("name")
    .eq("id", DEFAULT_GROUP_ID)
    .single();

  return data?.name || "群組";
}

export const dynamic = "force-dynamic";

export default async function Home() {
  const [bookmarks, groupName] = await Promise.all([
    getBookmarks(),
    getGroupName(),
  ]);

  return <ClientApp initialBookmarks={bookmarks} groupName={groupName} />;
}
