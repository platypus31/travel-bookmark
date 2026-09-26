"use client";

import { GroupMember } from "@/lib/types";
import { Identity } from "@/lib/identity";

interface Props {
  members: GroupMember[];
  loading: boolean;
  current?: Identity | null;
  /** 切換模式（已經有身分，只是要換人）時可以關閉不選；第一次選名字沒有這個按鈕。 */
  onClose?: () => void;
  onSelect: (member: GroupMember) => void;
}

export default function IdentityPicker({ members, loading, current, onClose, onSelect }: Props) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center px-0 sm:px-6">
      <div className="bg-white dark:bg-zinc-900 w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl max-h-[85dvh] overflow-y-auto">
        <div className="p-6 space-y-5">
          <div className="text-center space-y-1">
            <div className="text-4xl">👋</div>
            <h2 className="text-xl font-semibold">你是誰？</h2>
            <p className="text-sm text-muted">
              從 LINE 群組成員裡選一個名字，之後編輯/上傳/清單都會顯示這個名字
            </p>
          </div>

          {loading ? (
            <p className="text-center text-sm text-muted py-6">載入成員名單中...</p>
          ) : members.length === 0 ? (
            <div className="text-center text-sm text-muted py-6 space-y-1">
              <p>目前群組還沒有任何成員紀錄</p>
              <p>先在 LINE 群組傳一則訊息就會出現在這裡</p>
            </div>
          ) : (
            <div className="space-y-2">
              {members.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSelect(m)}
                  className={`w-full text-left px-4 py-3 rounded-xl border text-base font-medium ${
                    current?.id === m.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card"
                  }`}
                >
                  {m.display_name}
                  {current?.id === m.id && <span className="ml-2 text-xs">（目前）</span>}
                </button>
              ))}
              <p className="text-center text-xs text-muted pt-1">
                找不到自己？先在 LINE 群組傳一則訊息就會出現
              </p>
            </div>
          )}

          {onClose && (
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl border border-border font-medium text-sm text-muted"
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
