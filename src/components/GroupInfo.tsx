"use client";

import { useState } from "react";
import { Group } from "@/lib/types";

interface Props {
  group: Group;
  onClose: () => void;
}

export default function GroupInfo({ group, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(group.invite_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center px-6">
      <div className="bg-white dark:bg-zinc-900 w-full max-w-sm rounded-2xl p-6 space-y-4">
        <div className="text-center space-y-1">
          <h2 className="text-lg font-semibold">{group.name}</h2>
          <p className="text-sm text-muted">分享邀請碼給家人朋友加入</p>
        </div>

        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <p className="text-sm text-muted mb-1">邀請碼</p>
          <p className="text-2xl font-mono font-bold tracking-widest">
            {group.invite_code}
          </p>
        </div>

        <button
          onClick={handleCopy}
          className="w-full py-2.5 rounded-xl bg-primary text-primary-fg font-semibold"
        >
          {copied ? "已複製！" : "複製邀請碼"}
        </button>
        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-xl border border-border font-medium"
        >
          關閉
        </button>
      </div>
    </div>
  );
}
