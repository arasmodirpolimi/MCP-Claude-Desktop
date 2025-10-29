import React, { useEffect, useState } from 'react';

export default function ToolLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const API_BASE = import.meta.env.VITE_API_BASE || '';
  function buildUrl(path){ return API_BASE ? API_BASE.replace(/\/?$/, '') + path : path; }

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const r = await fetch(buildUrl('/admin/tools/usage'));
      if (!r.ok) throw new Error(`Usage fetch failed ${r.status}`);
      const j = await r.json();
      setEntries(Array.isArray(j.entries) ? j.entries : []);
    } catch(e){ setError(String(e.message||e)); }
    finally { setLoading(false); }
  }

  useEffect(()=>{ refresh(); const id = setInterval(refresh, 10000); return ()=> clearInterval(id); }, []);

  return (
    <div style={{ border:'1px solid #333', padding:'0.7rem', borderRadius:8, background:'#1e1e1e', marginTop:'0.75rem' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.4rem' }}>
        <h4 style={{ margin:0, fontSize:'0.8rem' }}>Recent Tool Calls</h4>
        <button onClick={refresh} disabled={loading} style={{ fontSize:'0.6rem', padding:'0.25rem 0.5rem', background:'#333', color:'#eee', border:'1px solid #444', borderRadius:4, cursor:'pointer' }}>↻</button>
      </div>
      {error && <div style={{ color:'#ff6b6b', fontSize:'0.65rem' }}>{error}</div>}
      {loading && <div style={{ fontSize:'0.6rem', opacity:0.7 }}>Loading…</div>}
      <ul style={{ listStyle:'none', padding:0, margin:0, maxHeight:160, overflowY:'auto' }}>
        {entries.slice().reverse().map((e,i)=>(
          <li key={i} style={{ fontSize:'0.6rem', padding:'0.3rem 0', borderBottom:'1px solid #222' }}>
            <div style={{ display:'flex', justifyContent:'space-between', gap:6 }}>
              <strong style={{ color:'#ccc' }}>{e.name}</strong>
              <span style={{ opacity:0.55 }}>{new Date(e.startedAt).toLocaleTimeString()}</span>
            </div>
            <div style={{ color: e.error? '#ff6b6b':'#aaa' }}>{e.summary || (e.error? e.error:'')}</div>
          </li>
        ))}
        {!entries.length && !loading && <li style={{ fontSize:'0.6rem', opacity:0.6 }}>No tool calls yet.</li>}
      </ul>
    </div>
  );
}
