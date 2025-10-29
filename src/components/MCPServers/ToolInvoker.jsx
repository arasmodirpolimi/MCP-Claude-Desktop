import React from 'react';
import { useMcpServers } from '../../context/McpServersContext';
import { useState, useEffect } from 'react';

export default function ToolInvoker() {
  const { activeServerId, tools, loadingTools, servers, setServerAllowlist } = useMcpServers();
  const [allowInput, setAllowInput] = useState('');
  const [savingAllow, setSavingAllow] = useState(false);

  useEffect(() => {
    if (!activeServerId) return setAllowInput('');
    const s = (servers || []).find(x => x.id === activeServerId);
    setAllowInput((s?.allowedDomains || []).join(', '));
  }, [activeServerId, servers]);

  if (!activeServerId) return <div style={boxStyle}>Select or add a server first.</div>;

  return (
    <div style={{ ...boxStyle, maxWidth: '100%', boxSizing: 'border-box' }}>
      <h3 style={{ marginTop:0 }}>Tools</h3>
      <div style={{ display:'grid', gap:8 }}>
        {loadingTools && <div>Loading tools…</div>}
        {(!tools || tools.length === 0) && !loadingTools && <div style={{ opacity:0.7 }}>No tools available</div>}
        {(tools || []).map(t => (
          <div key={t.name} style={{ display:'flex', flexDirection: 'column', gap: 6, padding:'0.4rem 0', borderBottom: '1px solid #222' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize:'0.95rem', fontWeight: 500, wordBreak: 'break-all' }}>{t.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.8rem', opacity: 0.9, background: '#184d14', color: '#bfffbf', padding: '0.18rem 0.45rem', borderRadius: 6 }}>
                  {t.enabled ? 'Connected' : 'Unavailable'}
                </span>
              </div>
            </div>
            {t.description && <div style={{ fontSize:'0.75rem', color:'#bfbfbf', wordBreak:'break-word' }}>{t.description}</div>}
          </div>
        ))}
        {/* allowlist editor removed per request */}
      </div>
    </div>
  );
}

const boxStyle = { border:'1px solid #333', padding:'0.75rem', borderRadius:6, background:'#1a1a1a', marginTop:'0.75rem' };
