import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function LogoutButton({ onLogout }: { onLogout: () => void }) {
  const [confirming, setConfirming] = useState(false);

  const handleClick = async () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    try {
      await invoke("auth_logout");
    } catch (e) {
      console.error("logout failed", e);
    }
    onLogout();
  };

  return (
    <button
      onClick={handleClick}
      className={`text-xs px-3 py-1.5 rounded-md transition-opacity ${
        confirming ? "bg-red-500 text-white hover:opacity-80" : "bg-muted hover:opacity-80"
      }`}
    >
      {confirming ? "확인 클릭" : "로그아웃"}
    </button>
  );
}
