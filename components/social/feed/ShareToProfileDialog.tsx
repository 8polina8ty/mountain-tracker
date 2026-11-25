"use client";
import { useState } from "react";
import { X } from "lucide-react";

export default function ShareToProfileDialog({ title, preview, onShare, onClose, busy }: { title: string; preview: React.ReactNode; onShare: (body: string, visibility: string)=>Promise<void>; onClose: ()=>void; busy?: boolean }) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"public"|"friends"|"private">("public");
  const [error, setError] = useState("");
  async function handle(){ if(body.length>5000) { setError("Too long"); return; } try{ await onShare(body, visibility);}catch(e: unknown){ setError((e as Error).message||"Share failed"); } }
  return (
    <div role="dialog" aria-modal="true" aria-label="Share dialog" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-[20px] border bg-[var(--color-surface)] p-5 shadow-[var(--shadow-panel)]">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close share dialog" className="h-11 w-11 grid place-items-center rounded-full hover:bg-[var(--color-surface-muted)]"><X size={18} /></button>
        </div>
        <div className="mt-3 rounded-xl border bg-[var(--color-surface-muted)] p-3">{preview}</div>
        <label className="mt-3 block text-xs font-semibold">Caption</label>
        <textarea value={body} onChange={(e)=>setBody(e.target.value)} maxLength={5000} placeholder="Add a caption…" className="mt-1 w-full rounded-xl border p-3 text-sm" />
        <div className="mt-1 text-right text-xs text-[var(--color-text-muted)]">{body.length} / 5000</div>
        <label className="mt-2 block text-xs font-semibold">Visibility</label>
        <select value={visibility} onChange={(e)=>setVisibility(e.target.value as never)} aria-label="Visibility" className="ui-field mt-1 w-full px-3 py-2">
          <option value="public">Public</option>
          <option value="friends">Friends</option>
          <option value="private">Private</option>
        </select>
        {error && <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="ui-pressable rounded-full border px-5 py-2.5 font-semibold">Cancel</button>
          <button onClick={handle} disabled={!!busy} className="ui-pressable rounded-full bg-[var(--color-forest)] px-6 py-2.5 font-bold text-white disabled:opacity-50">{busy ? "Sharing…" : "Share to profile"}</button>
        </div>
      </div>
    </div>
  );
}
