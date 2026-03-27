"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

interface Props {
  userId: string;
  onComplete: () => void;
}

export default function SetupProfile({ userId, onComplete }: Props) {
  const [step, setStep] = useState<"name" | "group">("name");
  const [name, setName] = useState("");
  const [groupChoice, setGroupChoice] = useState<"create" | "join">("create");
  const [groupName, setGroupName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSetup = async () => {
    setLoading(true);
    let groupId: string;

    if (groupChoice === "create") {
      // Generate UUID client-side to avoid SELECT-after-INSERT RLS issue
      // (user has no profile yet, so get_my_group_id() returns NULL)
      groupId = crypto.randomUUID();
      const { error } = await supabase
        .from("groups")
        .insert({ id: groupId, name: groupName || `${name}的收藏` });
      if (error) {
        alert("建立群組失敗：" + error.message);
        setLoading(false);
        return;
      }
    } else {
      const { data, error } = await supabase
        .from("groups")
        .select("id")
        .eq("invite_code", inviteCode.trim())
        .single();
      if (error || !data) {
        alert("邀請碼無效");
        setLoading(false);
        return;
      }
      groupId = data.id;
    }

    const { error } = await supabase.from("profiles").insert({
      id: userId,
      display_name: name,
      group_id: groupId,
    });

    if (error) {
      alert("建立個人資料失敗：" + error.message);
    } else {
      onComplete();
    }
    setLoading(false);
  };

  if (step === "name") {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <div className="text-4xl">👋</div>
            <h2 className="text-xl font-semibold">歡迎！你的暱稱是？</h2>
          </div>
          <input
            type="text"
            placeholder="輸入暱稱"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            onClick={() => name.trim() && setStep("group")}
            disabled={!name.trim()}
            className="w-full py-3 rounded-xl bg-primary text-primary-fg font-semibold disabled:opacity-50"
          >
            下一步
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="text-4xl">👨‍👩‍👧‍👦</div>
          <h2 className="text-xl font-semibold">建立或加入群組</h2>
          <p className="text-muted text-sm">群組可以和家人朋友共享收藏</p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setGroupChoice("create")}
            className={`flex-1 py-2 rounded-lg font-medium text-sm ${
              groupChoice === "create"
                ? "bg-primary text-primary-fg"
                : "bg-card border border-border"
            }`}
          >
            建立新群組
          </button>
          <button
            onClick={() => setGroupChoice("join")}
            className={`flex-1 py-2 rounded-lg font-medium text-sm ${
              groupChoice === "join"
                ? "bg-primary text-primary-fg"
                : "bg-card border border-border"
            }`}
          >
            用邀請碼加入
          </button>
        </div>

        {groupChoice === "create" ? (
          <input
            type="text"
            placeholder="群組名稱（例：我們家的美食清單）"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary"
          />
        ) : (
          <input
            type="text"
            placeholder="輸入邀請碼"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-border bg-card text-base outline-none focus:ring-2 focus:ring-primary"
          />
        )}

        <button
          onClick={handleSetup}
          disabled={loading}
          className="w-full py-3 rounded-xl bg-primary text-primary-fg font-semibold disabled:opacity-50"
        >
          {loading ? "設定中..." : "完成設定"}
        </button>
      </div>
    </div>
  );
}
