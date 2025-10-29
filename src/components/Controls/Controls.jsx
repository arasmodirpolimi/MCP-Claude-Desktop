import { useRef, useEffect, useState } from "react";
import TextareaAutosize from 'react-textarea-autosize';
import styles from "./Controls.module.css";

export function Controls( {isDisabled = false, onSend } ) {
  const textareaRef = useRef(null);
  const [content, setContent] = useState("");
  const [selectedModel, setSelectedModel] = useState('claude-3-5-sonnet-latest');
  const [enableTools, setEnableTools] = useState(true);


  useEffect(() => {
    if (!isDisabled) {
      textareaRef.current.focus();
    }
  },[isDisabled])

  function handleContentChange(event) {
    setContent(event.target.value);
  }

  function handleContentSend() {
    if (content.trim().length === 0) return;
    onSend(content, { model: selectedModel, enableTools });
    setContent("");
  }

  function handleEnterPress(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleContentSend();
    }
  }


  return (
    <div className={styles.Controls}>
      <div style={{ display:'flex', gap:'0.5rem', alignItems:'center', flexWrap:'wrap', marginBottom:'0.4rem' }}>
        <label style={{ display:'flex', flexDirection:'column', fontSize:'0.65rem', color:'#ccc' }}>
          <span style={{ marginBottom:2 }}>Model</span>
          <select
            value={selectedModel}
            onChange={e=>setSelectedModel(e.target.value)}
            disabled={isDisabled}
            style={{ padding:'0.35rem 0.5rem', background:'#222', color:'#eee', border:'1px solid #444', borderRadius:4, fontSize:'0.75rem' }}
          >
            <option value="claude-3-5-sonnet-latest">Sonnet</option>
            <option value="claude-3-5-haiku-latest">Haiku</option>
            <option value="claude-3-opus-latest">Opus</option>
          </select>
        </label>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:'0.7rem', color:'#ccc' }}>
          <input type="checkbox" checked={enableTools} disabled={isDisabled} onChange={e=>setEnableTools(e.target.checked)} />
          Use tools
        </label>
      </div>
      <div className={styles.TextAreaContainer}>
        <TextareaAutosize
          className={styles.TextArea}
          placeholder="Message AI Chatbot"
          value={content}
          ref={textareaRef}
          disabled={isDisabled}
          minRows={1}
          maxRows={4}
          onChange={handleContentChange}
          onKeyDown={handleEnterPress}
        />
      </div>
      <button className={styles.Button} disabled={isDisabled} onClick={handleContentSend}>
        <SendIcon />
      </button>
    </div>
  );
}

function SendIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="24px"
      viewBox="0 -960 960 960"
      width="24px"
      fill="#5f6368"
    >
      <path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v140l240 60-240 60v140Zm0 0v-400 400Z" />
    </svg>
  );
}
