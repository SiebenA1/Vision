import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Circle,
  Loader2,
  PanelRightClose,
  Paperclip,
  Send,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { useAppStore } from '../state/store';
import type { ChatMessage } from '../core/types';

interface CopilotPanelProps {
  onSend: (prompt: string) => void;
}

function AgentMark({ size = 28 }: { size?: number }) {
  return (
    <span className="agent-mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4L12 2.8Z" stroke="currentColor" strokeWidth="1.3" />
        <path d="m8.2 12 2.5 2.5 5.1-6.1" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    </span>
  );
}

function renderContent(content: string) {
  return content.split('\n').map((line, index) => {
    if (!line.trim()) return <div key={index} className="chat-line chat-line--empty" />;
    const chunks = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return (
      <p key={index} className="chat-line">
        {chunks.map((chunk, chunkIndex) => {
          if (chunk.startsWith('**') && chunk.endsWith('**')) {
            return <strong key={chunkIndex}>{chunk.slice(2, -2)}</strong>;
          }
          if (chunk.startsWith('`') && chunk.endsWith('`')) {
            return <code key={chunkIndex}>{chunk.slice(1, -1)}</code>;
          }
          return <span key={chunkIndex}>{chunk}</span>;
        })}
      </p>
    );
  });
}

function Message({ message, onChip }: { message: ChatMessage; onChip: (text: string) => void }) {
  const isUser = message.role === 'user';
  if (isUser) {
    return (
      <div className="chat-message chat-message--user">
        <div className="chat-message__bubble">{renderContent(message.content)}</div>
        <span className="chat-message__time">
          {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    );
  }
  return (
    <div className="chat-message chat-message--assistant">
      <div className="chat-message__head">
        <AgentMark size={24} />
        <div>
          <b>ATLAS</b>
          <small>ENGINEERING AGENT</small>
        </div>
        <span className="chat-message__time">
          {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className="chat-message__body">
        {message.steps && message.steps.length > 0 && (
          <div className="agent-plan">
            {message.steps.map((step) => (
              <div key={step.id} className={`agent-step agent-step--${step.status}`}>
                <span className="agent-step__icon">
                  {step.status === 'running' ? (
                    <Loader2 size={12} className="spin" />
                  ) : step.status === 'done' ? (
                    <Check size={12} />
                  ) : step.status === 'error' ? (
                    <AlertTriangle size={12} />
                  ) : (
                    <Circle size={9} />
                  )}
                </span>
                <span className="agent-step__label">{step.label}</span>
                {step.detail && <span className="agent-step__detail">{step.detail}</span>}
              </div>
            ))}
          </div>
        )}
        {message.content && <div className="chat-message__content">{renderContent(message.content)}</div>}
        {message.meta?.chips && (
          <div className="chat-chips">
            {message.meta.chips.map((chip) => (
              <button key={chip} type="button" onClick={() => onChip(chip)} disabled={useAppStore.getState().chatBusy}>
                {chip}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  { label: '基线校核', prompt: '运行一次基线校核，并解释最大应力出现的位置。' },
  { label: '轻量化优化', prompt: '以质量最小为目标，安全系数不低于 2.0，位移不超过 2.0 mm，优化悬臂厚度。' },
  { label: '提高载荷', prompt: '把端部载荷提高到 1200 N，然后重新校核。' },  { label: '换成 7075', prompt: '材料换成 7075-T6，保持当前载荷，重新校核。' },
];

export function CopilotPanel({ onSend }: CopilotPanelProps) {
  const chat = useAppStore((state) => state.chat);
  const busy = useAppStore((state) => state.chatBusy);
  const copilotCollapsed = useAppStore((state) => state.copilotCollapsed);
  const toggleCopilot = useAppStore((state) => state.toggleCopilot);
  const addToast = useAppStore((state) => state.addToast);
  const model = useAppStore((state) => state.model);
  const loadMagnitude = model.loads[0]?.magnitude ?? 0;
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat]);

  useEffect(() => {
    if (copilotCollapsed) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [copilotCollapsed]);

  if (copilotCollapsed) {
    return (
      <button type="button" className="copilot-rail" onClick={toggleCopilot} title="展开工程智能体">
        <AgentMark size={26} />
        <span>ATLAS</span>
        <span className="copilot-rail__line" />
        <span className="copilot-rail__hint">⌘K</span>
      </button>
    );
  }

  const submit = () => {
    const value = draft.trim();
    if (!value || busy) return;
    setDraft('');
    onSend(value);
  };

  return (
    <aside className="copilot">
      <div className="copilot__head">
        <div className="copilot__identity">
          <AgentMark size={30} />
          <div>
            <div className="copilot__name">
              ATLAS <span className="chip chip--live">TOOL-CALLING</span>
            </div>
            <span className="copilot__sub">工程智能体 · 本地推理层</span>
          </div>
        </div>
        <button type="button" className="icon-button icon-button--small" onClick={toggleCopilot} title="收起智能体">
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="copilot__context">
        <span className="context-chip">
          <span className="context-chip__dot" /> BRK-042
        </span>
        <span className="context-chip">AL 6061-T6</span>
        <span className="context-chip">{loadMagnitude} N</span>
        <span className="context-chip context-chip--muted">C3D8</span>
      </div>

      <div className="copilot__scroll" ref={scrollRef}>
        {chat.map((message) => (
          <Message key={message.id} message={message} onChip={onSend} />
        ))}

        {chat.length <= 1 && (
          <div className="suggestion-block">
            <span className="eyebrow">NEXT ACTION</span>
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion.label} type="button" onClick={() => onSend(suggestion.prompt)} disabled={busy}>
                <span>{suggestion.label}</span>
                <ArrowUp size={12} />
              </button>
            ))}
          </div>
        )}

        {busy && (
          <div className="agent-thinking">
            <span />
            <span />
            <span />
            <small>ATLAS 正在编排工具调用</small>
          </div>
        )}
      </div>

      <div className="copilot__composer">
        <div className="composer-tools">
          <span className="composer-context">
            <TerminalSquare size={12} /> CONTEXT: 模型 + 结果
          </span>
          <button
            type="button"
            className="composer-tool"
            onClick={() =>
              addToast({
                title: '上下文附件',
                detail: '可直接引用 STEP / STL / CSV 结果；本地解析，不上传几何。',
                tone: 'neutral',
              })
            }
            title="添加上下文"
          >
            <Paperclip size={14} />
          </button>
        </div>
        <div className={`composer-box ${busy ? 'is-busy' : ''}`}>
          <textarea
            id="copilot-input"
            ref={inputRef}
            value={draft}
            rows={2}
            placeholder="描述目标、尺寸、工况或优化约束…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            disabled={busy}
          />
          <div className="composer-box__footer">
            <span>
              <Sparkles size={12} /> 受控工具 · 可撤销
            </span>
            <button type="button" className="send-button" onClick={submit} disabled={!draft.trim() || busy} aria-label="发送">
              <Send size={14} />
            </button>
          </div>
        </div>
        <div className="composer-note">Enter 发送 · Shift+Enter 换行 · 所有数值写入前经过单位校验</div>
      </div>
    </aside>
  );
}
