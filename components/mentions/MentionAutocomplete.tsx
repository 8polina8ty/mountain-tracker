"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/Lib/supabase/client";

export default function MentionAutocomplete({ query, onSelect }: { query: string; onSelect: (username: string, userId: string)=>void }) {
  const [searchResults, setSearchResults] = useState<{ query: string; users: { userId:string; username:string; displayName:string|null; avatarUrl:string|null }[] }>({ query: "", users: [] });
  const [active, setActive] = useState(0);
  const results = query.length > 0 && searchResults.query === query ? searchResults.users : [];
  useEffect(()=>{
    if(query.length < 1) return;
    let cancelled = false;
    const t=setTimeout(async()=>{
      const supabase=createClient();
      const { data } = await supabase.rpc("search_public_users",{ search_text: query, result_limit: 5 });
      if(cancelled) return;
      setSearchResults({ query, users: Array.isArray(data) ? data.map((r:Record<string,unknown>)=>({ userId:String(r.user_id), username:String(r.username), displayName:typeof r.display_name === "string" ? r.display_name : null, avatarUrl:typeof r.avatar_url === "string" ? r.avatar_url : null })) : [] });
      setActive(0);
    }, 250);
    return ()=>{ cancelled = true; clearTimeout(t); };
  },[query]);
  if(results.length===0) return null;
  return (
    <div role="listbox" aria-label="mentionSuggestions" className="absolute z-50 mt-1 max-h-48 w-64 overflow-auto rounded-xl border bg-[var(--color-surface)] p-1 shadow-[var(--shadow-panel)]">
      {results.map((u,i)=>(
        <button key={u.userId} role="option" aria-selected={i===active} onClick={()=>onSelect(u.username, u.userId)} onMouseEnter={()=>setActive(i)} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left ${i===active?"bg-[var(--color-surface-muted)]":""}`}>
          <span className="h-6 w-6 rounded-full bg-[var(--color-surface-muted)]" />
          <span className="font-semibold">@{u.username}</span>
        </button>
      ))}
    </div>
  );
}
