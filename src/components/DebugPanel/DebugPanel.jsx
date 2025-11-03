import React, { useEffect, useState, useRef } from 'react';

/**
 * DebugPanel
 * Renders a transient debug area showing active tool executions and recent messages summary.
 * Starts expanded on first mount then can be minimized by user; optionally auto-minimizes after delay.
 */
export default function DebugPanel({ messages = [], activeToolExecs = [], autoHideMs = 6000 }) {
  const [expanded, setExpanded] = useState(true);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (autoHideMs > 0) {
      timerRef.current = setTimeout(() => {
        setExpanded(false);
        setAutoCollapsed(true);
      }, autoHideMs);
      return () => clearTimeout(timerRef.current);
    }
  }, [autoHideMs]);

  function toggle() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setExpanded(e => !e);
  }

  const running = activeToolExecs.filter(t => t.status === 'running');
  const recentErrors = activeToolExecs.filter(t => t.status === 'error').slice(-3);
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');

  return (
    <div style={{
      position:'fixed',
      bottom:12,
      right:12,
      width: expanded ? 340 : 140,
      transition:'width 0.25s ease, height 0.25s ease',
      background:'#121212',
      border:'1px solid #2a2a2a',
      borderRadius:10,
      boxShadow:'0 4px 14px rgba(0,0,0,0.55)',
      fontSize:'0.65rem',
      color:'#ddd',
      overflow:'hidden',
      zIndex:500
    }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0.35rem 0.55rem', background:'#181818', borderBottom:'1px solid #222' }}>
        <strong style={{ fontSize:'0.7rem' }}>Debug</strong>
        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
          {autoCollapsed && !expanded && <span style={{ opacity:0.5 }}>auto</span>}
          <button onClick={toggle} style={{ background:'#262626', color:'#ddd', fontSize:'0.55rem', padding:'0.25rem 0.5rem', border:'1px solid #333', borderRadius:4, cursor:'pointer' }}>{expanded? '−' : '+'}</button>
        </div>
      </div>
      {expanded && (
        <div style={{ padding:'0.5rem 0.65rem', display:'grid', gap:'0.5rem', maxHeight:260, overflowY:'auto' }}>
          <section>
            <div style={{ fontWeight:600, marginBottom:4 }}>Active Tools</div>
            {running.length ? (
              <ul style={{ listStyle:'none', margin:0, padding:0 }}>
                {running.map((t,i) => (
                  <li key={i} style={{ padding:'0.25rem 0', borderBottom:'1px solid #1c1c1c' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:6 }}>
                      <span style={{ color:'#eee' }}>{t.tool}</span>
                      <span style={{ opacity:0.55 }}>{Math.round((Date.now()-t.startedAt)/1000)}s</span>
                    </div>
                    {t.args && Object.keys(t.args).length > 0 && (
                      <div style={{ opacity:0.6, whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden', maxWidth:300 }}>
                        {JSON.stringify(t.args)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : <div style={{ opacity:0.5 }}>No running tools.</div>}
          </section>
          {(recentErrors.length > 0) && (
            <section>
              <div style={{ fontWeight:600, marginBottom:4, color:'#ff6b6b' }}>Recent Errors</div>
              <ul style={{ listStyle:'none', margin:0, padding:0 }}>
                {recentErrors.map((t,i)=>(
                  <li key={i} style={{ padding:'0.25rem 0', borderBottom:'1px solid #1c1c1c' }}>
                    <div style={{ color:'#ff6b6b' }}>{t.tool}: {String(t.error).slice(0,140)}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {lastAssistant && (
            <section>
              <div style={{ fontWeight:600, marginBottom:4 }}>Last Assistant Reply</div>
              <div style={{ fontSize:'0.6rem', lineHeight:1.3, maxHeight:100, overflowY:'auto', whiteSpace:'pre-wrap' }}>
                {lastAssistant.content.slice(0,800)}{lastAssistant.content.length>800? '…':''}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
